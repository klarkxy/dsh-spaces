import type {
  Board, BoardMutation, BoardMutationReceipt, BoundProviderRegistry, CatalogEntry,
  DashboardBackend, DashboardQuery, DashboardQueryData, DashboardQueryResponse,
  InstanceRef, InstanceView, ProviderRegistration, SourceTarget, WidgetInstance, WidgetType,
} from '../../../shared/dashboard.js';
import { emptyLayout, parseLayoutDocument, prepareLayout, readReceipt, type LayoutDocument } from './boards.js';
import { DashboardFault, invalid, limit } from './errors.js';
import { DASHBOARD_LIMITS } from './limits.js';
import { createBoundProviderRegistry, type HomePublisher } from './provider.js';
import { byteLength, canonicalJson, copyJson, identifier, object, parseQuery, parseSnapshot, parseStrictJson, refKey, timestampMillis } from './validation.js';

export interface LocalProviderSnapshot {
  providerId: string;
  runId: string;
  sequence: number;
  receivedAt: string;
  types: WidgetType[];
  instances: WidgetInstance[];
}
export interface LocalDashboardDocument {
  schemaVersion: 1;
  layout: LayoutDocument;
  providers: LocalProviderSnapshot[];
}
/** Exactly one opened official storage record. Missing and unreadable MUST remain distinct. */
export interface LocalDashboardStore {
  read(): Promise<unknown | null>;
  /** Resolves after commit, not after merely changing a write-behind cache. */
  write(document: LocalDashboardDocument): Promise<void>;
  close(): Promise<void>;
}
export interface LocalDashboardOptions {
  spaceId: string;
  title: string;
  backendEpoch: string;
  newId(): string;
  now(): number;
  store: LocalDashboardStore;
  /** Optional pre-authorized Home run; absence is local-only, not discovery. */
  homePublisherFor?(providerId: string): HomePublisher;
  /** Must check actual target existence and access. No URL or filesystem resolution here. */
  targetExists?(target: SourceTarget): Promise<boolean>;
}
export interface LocalDashboardAccess { subjectId: string; layoutWrite: boolean }
export type LocalDashboardAuthorizer = () => LocalDashboardAccess | null;
const DOCUMENT_BYTES = DASHBOARD_LIMITS.maxLayoutBytes + DASHBOARD_LIMITS.maxHomeProjectionBytes;
const RESPONSE_BYTES = 8 * 1024 * 1024;
const CURSOR_LIMIT = 256;
const CURSOR_TTL_MS = 5 * 60_000;

export function parseLocalDashboardDocument(input: unknown): LocalDashboardDocument {
  const data = typeof input === 'string' || input instanceof Uint8Array ? parseStrictJson(input, DOCUMENT_BYTES) : input;
  const encoded = canonicalJson(data);
  limit(byteLength(encoded), DOCUMENT_BYTES, 'localDocument');
  const row = object(JSON.parse(encoded) as unknown, ['schemaVersion', 'layout', 'providers'], [], 'localDocument');
  if (row.schemaVersion !== 1) throw new DashboardFault('dashboard/unsupported-version');
  if (!Array.isArray(row.providers)) return invalid('providers');
  limit(row.providers.length, DASHBOARD_LIMITS.maxProvidersPerSpace, 'providers');
  const ids = new Set<string>();
  const providers = row.providers.map((inputProvider): LocalProviderSnapshot => {
    const value = object(inputProvider, ['providerId', 'runId', 'sequence', 'receivedAt', 'types', 'instances'], [], 'provider');
    const providerId = identifier(value.providerId, 'providerId');
    if (ids.has(providerId)) invalid('providers'); ids.add(providerId);
    const runId = identifier(value.runId, 'runId');
    if (typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1) invalid('sequence');
    timestampMillis(value.receivedAt, 'receivedAt');
    const snapshot = parseSnapshot({ types: value.types, instances: value.instances });
    return { providerId, runId, sequence: value.sequence as number, receivedAt: value.receivedAt as string, ...snapshot };
  });
  limit(providers.reduce((sum, item) => sum + item.instances.length, 0), DASHBOARD_LIMITS.maxHomeInstances, 'instances');
  limit(byteLength(canonicalJson(providers)), DASHBOARD_LIMITS.maxHomeProjectionBytes, 'projections');
  return { schemaVersion: 1, layout: parseLayoutDocument(row.layout), providers };
}

interface Cursor {
  subjectId: string;
  filter: string;
  revision: string;
  offset: number;
  limit: number;
  expiresAt: number;
}
interface Binding { state: 'active' | 'failed' | 'disposed' }

/**
 * One Host, one store, one writer. Clients receive only query/mutate closures;
 * only trusted Host composition receives bindProvider. This is not an OS sandbox.
 */
export class LocalDashboard {
  private document: LocalDashboardDocument | null = null;
  private loaded = false;
  private broken = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly bindings = new Map<string, Binding>();
  private readonly cursors = new Map<string, Cursor>();
  private catalogRevision: string;
  private readonly options: LocalDashboardOptions;

  constructor(options: LocalDashboardOptions) {
    identifier(options.spaceId, 'spaceId'); identifier(options.backendEpoch, 'backendEpoch');
    if (typeof options.title !== 'string' || !options.title.trim() || Array.from(options.title).length > 200) invalid('title');
    this.options = { ...options };
    this.catalogRevision = this.id();
  }
  private id(): string { return identifier(this.options.newId(), 'generatedId'); }
  private clock(): number {
    const value = this.options.now();
    if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) invalid('clock');
    return value;
  }
  private async load(): Promise<void> {
    if (this.broken) throw new DashboardFault('dashboard/storage-failed');
    if (this.loaded) return;
    try {
      const stored = await this.options.store.read();
      this.document = stored === null ? { schemaVersion: 1, layout: emptyLayout(), providers: [] } : parseLocalDashboardDocument(stored);
      this.loaded = true;
    } catch {
      this.broken = true;
      throw new DashboardFault('dashboard/storage-failed');
    }
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new DashboardFault('dashboard/unavailable'));
    const result = this.tail.then(async () => {
      if (this.closing) throw new DashboardFault('dashboard/unavailable');
      await this.load();
      return operation();
    });
    // Release queue admission after a completed operation, never replay that operation.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async commit(candidate: LocalDashboardDocument): Promise<void> {
    const checked = parseLocalDashboardDocument(candidate);
    try { await this.options.store.write(copyJson(checked)); }
    catch {
      // A rejected commit can have an uncertain outcome. Do not serve the old in-memory
      // document as authoritative and do not retry or switch persistence implementations.
      this.broken = true;
      throw new DashboardFault('dashboard/storage-failed');
    }
    this.document = checked;
  }
  private authorize(authorizer: LocalDashboardAuthorizer, expectedSubject?: string): LocalDashboardAccess {
    if (this.closing) throw new DashboardFault('dashboard/unavailable');
    const access = authorizer();
    if (!access) throw new DashboardFault('dashboard/unauthenticated');
    identifier(access.subjectId, 'subjectId');
    if (typeof access.layoutWrite !== 'boolean') throw new DashboardFault('dashboard/forbidden');
    if (expectedSubject !== undefined && access.subjectId !== expectedSubject) throw new DashboardFault('dashboard/forbidden');
    return { ...access };
  }
  private visible(ref: InstanceRef): boolean {
    return ref.spaceId === this.options.spaceId && !!this.document!.providers.find(provider => provider.providerId === ref.providerId)?.instances.some(instance => instance.instanceId === ref.instanceId);
  }
  private metadata(): CatalogEntry[] {
    return this.document!.providers.flatMap(provider => provider.instances.map(instance => ({
      ref: { spaceId: this.options.spaceId, providerId: provider.providerId, instanceId: instance.instanceId },
      typeId: instance.typeId, typeVersion: instance.typeVersion,
      kind: instance.content.kind, title: instance.title,
      sourceState: provider.runId === this.options.backendEpoch && this.bindings.get(provider.providerId)?.state === 'active' ? 'running' as const : 'unknown' as const,
    }))).sort((left, right) => {
      const a = refKey(left.ref), b = refKey(right.ref);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  private changedMetadata(before: string, nextRevision: string): void {
    if (before !== canonicalJson(this.metadata())) {
      this.catalogRevision = nextRevision;
      this.cursors.clear();
    }
  }
  private instance(ref: InstanceRef): InstanceView {
    const absent: InstanceView = { state: 'unavailable', ref: copyJson(ref), reason: 'not-found' };
    if (ref.spaceId !== this.options.spaceId) return absent;
    const provider = this.document!.providers.find(value => value.providerId === ref.providerId);
    const instance = provider?.instances.find(value => value.instanceId === ref.instanceId);
    if (!provider || !instance) return { ...absent, reason: 'source-removed' };
    const live = provider.runId === this.options.backendEpoch && this.bindings.get(provider.providerId)?.state === 'active';
    const stale = !live || (instance.staleAfterSeconds !== null && this.clock() - timestampMillis(provider.receivedAt) >= instance.staleAfterSeconds * 1000);
    return {
      state: 'present', ref: copyJson(ref), instance: copyJson(instance), runId: provider.runId,
      sequence: provider.sequence, receivedAt: provider.receivedAt,
      freshness: stale ? 'stale' : 'current', sourceState: live ? 'running' : 'unknown',
    };
  }
  private defaultBoardId(): string {
    const layout = this.document!.layout;
    if (layout.boards.length) return layout.boards[0].id;
    const used = new Set(layout.tombstones.map(board => board.id));
    for (let n = 1; n <= DASHBOARD_LIMITS.maxBoardIds + 1; n++) {
      const id = n === 1 ? 'home' : `home-${n}`;
      if (!used.has(id)) return id;
    }
    throw new DashboardFault('dashboard/limit-exceeded');
  }
  private catalog(query: Extract<DashboardQuery, { kind: 'catalog' }>, access: LocalDashboardAccess): DashboardQueryData {
    const filter = canonicalJson(query.spaceIds === undefined ? null : [...query.spaceIds].sort());
    const count = query.limit ?? 50;
    let offset = 0;
    if (query.cursor !== undefined) {
      const cursor = this.cursors.get(query.cursor);
      if (!cursor || cursor.subjectId !== access.subjectId || cursor.filter !== filter || cursor.limit !== count || cursor.revision !== this.catalogRevision || cursor.expiresAt <= this.clock()) {
        throw new DashboardFault('dashboard/cursor-invalid');
      }
      offset = cursor.offset;
    }
    const all = query.spaceIds !== undefined && !query.spaceIds.includes(this.options.spaceId) ? [] : this.metadata();
    const entries = all.slice(offset, offset + count);
    let nextCursor: string | null = null;
    if (offset + count < all.length) {
      const time = this.clock();
      // Ephemeral read cursors contain no content, credentials or durable state.
      for (const [key, cursor] of this.cursors) if (cursor.expiresAt <= time) this.cursors.delete(key);
      if (this.cursors.size >= CURSOR_LIMIT) throw new DashboardFault('dashboard/unavailable');
      nextCursor = this.id();
      if (this.cursors.has(nextCursor)) throw new DashboardFault('dashboard/unavailable');
      this.cursors.set(nextCursor, { subjectId: access.subjectId, filter, limit: count, revision: this.catalogRevision, offset: offset + count, expiresAt: time + CURSOR_TTL_MS });
    }
    return { kind: 'catalog', entries, catalogRevision: this.catalogRevision, nextCursor };
  }
  private async queryData(query: DashboardQuery, access: LocalDashboardAccess): Promise<DashboardQueryData> {
    switch (query.kind) {
      case 'overview': return {
        kind: 'overview', mode: 'local', defaultBoardId: this.defaultBoardId(),
        boards: this.document!.layout.boards.map(({ id, title, revision }) => ({ id, title, revision })),
        sources: [{ spaceId: this.options.spaceId, title: this.options.title, sourceState: 'running', publishing: 'disabled' }],
        limits: { ...DASHBOARD_LIMITS },
        capabilities: { layoutWrite: access.layoutWrite, publicationsManage: false, executeActions: false },
      };
      case 'catalog': return this.catalog(query, access);
      case 'instances': return { kind: 'instances', items: query.refs.map(ref => this.instance(ref)) };
      case 'board': return { kind: 'board', board: copyJson(this.document!.layout.boards.find(board => board.id === query.boardId) ?? null) };
      case 'receipt': return { kind: 'receipt', receipt: readReceipt(this.document!.layout, query.requestId, { subjectId: access.subjectId, now: this.clock(), canRead: ref => this.visible(ref) }) };
      case 'navigation': {
        const view = this.instance(query.ref);
        let target: SourceTarget | null = null;
        if (view.state === 'present' && view.sourceState === 'running' && view.instance.sourceTarget !== null) {
          const candidate = view.instance.sourceTarget;
          const exists = this.options.targetExists ? await this.options.targetExists(copyJson(candidate)) : candidate.kind === 'space';
          if (exists) target = candidate;
        }
        return { kind: 'navigation', ref: copyJson(query.ref), target, available: target !== null };
      }
      case 'publications': throw new DashboardFault('dashboard/unsupported-operation');
    }
  }
  client(authorizer: LocalDashboardAuthorizer): DashboardBackend {
    return {
      query: (input: DashboardQuery): Promise<DashboardQueryResponse> => {
        let subject: string;
        try { subject = this.authorize(authorizer).subjectId; } catch (error) { return Promise.reject(error); }
        return this.run(async () => {
          const access = this.authorize(authorizer, subject);
          const data = await this.queryData(parseQuery(input), access);
          this.authorize(authorizer, subject);
          const response: DashboardQueryResponse = { protocolVersion: 1, backendEpoch: this.options.backendEpoch, data };
          limit(byteLength(canonicalJson(response)), RESPONSE_BYTES, 'response');
          return copyJson(response);
        });
      },
      mutate: (input: BoardMutation): Promise<BoardMutationReceipt> => {
        let subject: string;
        try { subject = this.authorize(authorizer).subjectId; } catch (error) { return Promise.reject(error); }
        return this.run(async () => {
          const access = this.authorize(authorizer, subject);
          if (!access.layoutWrite) throw new DashboardFault('dashboard/forbidden');
          const prepared = prepareLayout(this.document!.layout, input, {
            backendEpoch: this.options.backendEpoch, subjectId: subject,
            now: this.clock(), newRevision: this.id(), canRead: ref => this.visible(ref),
          });
          if (prepared.changed) await this.commit({ ...this.document!, layout: prepared.document });
          this.authorize(authorizer, subject);
          return copyJson(prepared.receipt);
        });
      },
    };
  }
  /** Called with the identity resolved by trusted Host composition, never browser input. */
  bindProvider(providerId: string): BoundProviderRegistry {
    identifier(providerId, 'providerId');
    if (this.closing) throw new DashboardFault('dashboard/unavailable');
    if (this.bindings.has(providerId)) throw new DashboardFault('dashboard/request-conflict');
    limit(this.bindings.size + 1, DASHBOARD_LIMITS.maxProvidersPerSpace, 'providers');
    const binding: Binding = { state: 'active' };
    const catalogRevision = this.id();
    this.bindings.set(providerId, binding);
    this.catalogRevision = catalogRevision; this.cursors.clear();
    const registry = createBoundProviderRegistry({
      commit: (snapshot) => this.run(async () => {
        if (binding.state !== 'active') throw new DashboardFault('dashboard/unavailable');
        const before = canonicalJson(this.metadata());
        const checked = parseSnapshot(snapshot);
        const previous = this.document!.providers.find(value => value.providerId === providerId);
        const sequence = previous?.runId === this.options.backendEpoch ? previous.sequence + 1 : 1;
        if (!Number.isSafeInteger(sequence)) throw new DashboardFault('dashboard/limit-exceeded');
        const record: LocalProviderSnapshot = { providerId, runId: this.options.backendEpoch, sequence, receivedAt: new Date(this.clock()).toISOString(), ...checked };
        const candidate = { ...this.document!, providers: [...this.document!.providers.filter(value => value.providerId !== providerId), record] };
        // A legal 128-character epoch cannot be concatenated with a sequence
        // to form another ID. Allocate and validate both IDs BEFORE commit.
        const localRevision = this.id(), nextCatalogRevision = this.id();
        await this.commit(candidate); this.changedMetadata(before, nextCatalogRevision);
        return localRevision;
      }),
      remove: () => this.run(async () => {
        const before = canonicalJson(this.metadata());
        const nextCatalogRevision = this.id();
        await this.commit({ ...this.document!, providers: this.document!.providers.filter(value => value.providerId !== providerId) });
        binding.state = 'disposed'; this.changedMetadata(before, nextCatalogRevision);
      }),
    }, this.options.homePublisherFor?.(providerId) ?? null);
    return {
      register: (registration: ProviderRegistration) => {
        const handle = registry.register(registration);
        return {
          publish: () => handle.publish().catch(error => {
            binding.state = 'failed'; this.catalogRevision = this.id(); this.cursors.clear();
            throw error;
          }),
          dispose: () => handle.dispose(),
        };
      },
    };
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true; this.cursors.clear();
    this.closePromise = this.tail.then(() => this.options.store.close()).then(() => {
      this.document = null; this.bindings.clear();
    }, () => { this.document = null; this.bindings.clear(); throw new DashboardFault('dashboard/storage-failed'); });
    return this.closePromise;
  }
}
