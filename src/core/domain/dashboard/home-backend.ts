import type {
  BoardMutation, BoardMutationReceipt, CatalogEntry, DashboardBackend, DashboardQuery,
  DashboardQueryData, DashboardQueryResponse, HeartbeatAck, InstanceRef, InstanceView,
  PublicationPlanInput, PublicationPolicy, PublicationSelection, PublisherGrant,
  PublishAck, SourceSummary, SourceTarget,
} from '../../../shared/dashboard.js';
import { emptyLayout, parseLayoutDocument, prepareLayout, readReceipt, type LayoutDocument } from './boards.js';
import { DashboardFault, invalid, limit } from './errors.js';
import { CHANNEL_STALE_MS, DASHBOARD_LIMITS } from './limits.js';
import { preparePublication, readProjection, selectionAllows, type Projection } from './projection.js';
import {
  byteLength, canonicalJson, copyJson, identifier, object, parseHeartbeat, parsePublicationPlan,
  parsePublishAck, parsePublishRequest, parseQuery, parseSelection, refKey, timestampMillis,
} from './validation.js';

export type StoredPublicationPolicy = Omit<PublicationPolicy, 'pendingStart'>;
export interface HomePolicyBook { schemaVersion: 1; policies: StoredPublicationPolicy[] }
/** All mutations are performed by the already owning Supervisor, never by a child. */
export interface HomeDashboardStore {
  readPolicies(): Promise<unknown | null>;
  writePolicies(value: HomePolicyBook): Promise<void>;
  readLayout(): Promise<unknown | null>;
  writeLayout(value: LayoutDocument): Promise<void>;
  readProjection(spaceId: string, providerId: string): Promise<unknown | null>;
  writeProjection(value: Projection): Promise<void>;
  deleteProjection(spaceId: string, providerId: string): Promise<void>;
  close(): Promise<void>;
}
export interface HomeReader { subjectId: string; layoutWrite: boolean; publicationsManage: boolean }
export type HomeAuthorizer = () => HomeReader | null;
export interface OwnedDashboardRun { spaceId: string; generation: number; runId: string }
export interface HomeDashboardOptions {
  backendEpoch: string;
  store: HomeDashboardStore;
  newId(): string;
  now(): number;
  /** Current Supervisor-owned sources, NOT caller-submitted space identities. */
  sources(): SourceSummary[];
  assertOwner(): void;
  assertRun(binding: OwnedDashboardRun): void;
  targetExists?(spaceId: string, target: SourceTarget): Promise<boolean>;
}
export interface HomeRunPublisher {
  grant(): Promise<PublisherGrant>;
  publish(value: unknown): Promise<PublishAck>;
  heartbeat(value: unknown): Promise<HeartbeatAck>;
  close(): void;
}
interface Run {
  binding: OwnedDashboardRun;
  grants: PublisherGrant['grants'];
  open: boolean;
  lastActivity: number;
  failedProviders: Set<string>;
  providerActivity: Map<string, number>;
  sentAt: number[];
  publishedAt: Map<string, number>;
}
interface Cursor { subject: string; filter: string; revision: string; offset: number; count: number; expires: number }
const key = (space: string, provider: string) => JSON.stringify([space, provider]);
const MAX_POLICIES = 5000;

export function parseHomePolicyBook(value: unknown): HomePolicyBook {
  const text = canonicalJson(value); limit(byteLength(text), 1024 * 1024, 'policies');
  const book = object(JSON.parse(text), ['schemaVersion', 'policies']);
  if (book.schemaVersion !== 1) throw new DashboardFault('dashboard/unsupported-version');
  if (!Array.isArray(book.policies)) return invalid('policies');
  limit(book.policies.length, MAX_POLICIES, 'policies');
  const used = new Set<string>(), counts = new Map<string, number>();
  const policies = book.policies.map(value => {
    const row = object(value, ['spaceId', 'providerId', 'revision', 'selection']);
    const spaceId = identifier(row.spaceId), providerId = identifier(row.providerId), revision = identifier(row.revision);
    if (revision === 'absent') invalid('revision');
    const id = key(spaceId, providerId);
    if (used.has(id)) invalid('policies'); used.add(id);
    const count = (counts.get(spaceId) ?? 0) + 1; counts.set(spaceId, count);
    limit(count, DASHBOARD_LIMITS.maxProvidersPerSpace, 'providers');
    return { spaceId, providerId, revision, selection: parseSelection(row.selection) };
  });
  return { schemaVersion: 1, policies };
}
export function parseHomeProjection(value: unknown, spaceId: string, providerId: string): Projection {
  const row = object(copyJson(value), ['spaceId', 'request', 'ack']);
  const request = parsePublishRequest(row.request), ack = parsePublishAck(row.ack);
  if (row.spaceId !== spaceId || request.providerId !== providerId || ack.runId !== request.runId ||
      ack.providerId !== providerId || ack.sequence !== request.sequence) invalid('projection');
  return { spaceId, request, ack };
}

/** Single-writer Home service. It neither starts processes nor loads business plugins. */
export class HomeDashboard {
  private book: HomePolicyBook | null = null;
  private layout: LayoutDocument | null = null;
  private readonly cache = new Map<string, Projection | null>();
  private readonly runs = new Map<string, Run>();
  private readonly usedRunIds = new Set<string>();
  private readonly cursors = new Map<string, Cursor>();
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closed = false;
  private broken = false;
  private closeResult: Promise<void> | null = null;
  private metadata = '';
  private catalogRevision: string;
  constructor(private readonly options: HomeDashboardOptions) {
    identifier(options.backendEpoch); this.catalogRevision = this.id();
  }
  private id(): string { return identifier(this.options.newId(), 'generatedId'); }
  private now(): number {
    const now = this.options.now(); if (!Number.isFinite(new Date(now).getTime())) invalid('now'); return now;
  }
  private usable(): void {
    if (this.closed) throw new DashboardFault('dashboard/unavailable');
    if (this.broken) throw new DashboardFault('dashboard/storage-failed');
    this.options.assertOwner();
  }
  private run<T>(work: () => Promise<T>): Promise<T> {
    try { this.usable(); } catch (error) { return Promise.reject(error); }
    if (this.queued >= 64) return Promise.reject(new DashboardFault('dashboard/rate-limited'));
    this.queued++;
    const result = this.tail.then(async () => { this.usable(); return work(); });
    this.tail = result.then(() => { this.queued--; }, () => { this.queued--; });
    return result;
  }
  private async policies(): Promise<HomePolicyBook> {
    if (!this.book) {
      try { const value = await this.options.store.readPolicies(); this.book = value === null ? { schemaVersion: 1, policies: [] } : parseHomePolicyBook(value); }
      catch { this.broken = true; throw new DashboardFault('dashboard/storage-failed'); }
    }
    return this.book;
  }
  private async layouts(): Promise<LayoutDocument> {
    if (!this.layout) {
      try { const value = await this.options.store.readLayout(); this.layout = value === null ? emptyLayout() : parseLayoutDocument(value); }
      catch { this.broken = true; throw new DashboardFault('dashboard/storage-failed'); }
    }
    return this.layout;
  }
  private policy(space: string, provider: string): StoredPublicationPolicy | undefined {
    return this.book?.policies.find(value => value.spaceId === space && value.providerId === provider);
  }
  private allowed(ref: InstanceRef): boolean {
    return selectionAllows(this.policy(ref.spaceId, ref.providerId)?.selection ?? null, ref.instanceId);
  }
  private async projection(policy: StoredPublicationPolicy): Promise<Projection | null> {
    // Authorization precedes all cache and disk access, including after cleanup failure.
    if (!policy.selection) return null;
    const id = key(policy.spaceId, policy.providerId);
    if (!this.cache.has(id)) {
      try {
        const value = await this.options.store.readProjection(policy.spaceId, policy.providerId);
        const projection = value === null ? null : parseHomeProjection(value, policy.spaceId, policy.providerId);
        let bytes = projection ? byteLength(canonicalJson(projection)) : 0;
        for (const cached of this.cache.values()) if (cached) bytes += byteLength(canonicalJson(cached));
        limit(bytes, DASHBOARD_LIMITS.maxHomeProjectionBytes, 'homeProjectionBytes');
        this.cache.set(id, projection);
      } catch { throw new DashboardFault('dashboard/storage-failed'); }
    }
    const value = this.cache.get(id)!;
    return value?.request.grantRevision === policy.revision ? value : null;
  }
  private authorize(auth: HomeAuthorizer, subject?: string): HomeReader {
    this.usable(); const principal = auth();
    if (!principal) throw new DashboardFault('dashboard/unauthenticated');
    identifier(principal.subjectId);
    if (typeof principal.layoutWrite !== 'boolean' || typeof principal.publicationsManage !== 'boolean' ||
        (subject !== undefined && principal.subjectId !== subject)) throw new DashboardFault('dashboard/forbidden');
    return { ...principal };
  }
  private sources(): SourceSummary[] {
    const sources = this.options.sources();
    limit(sources.length, MAX_POLICIES, 'sources');
    const ids = new Set<string>();
    for (const source of sources) {
      identifier(source.spaceId); if (ids.has(source.spaceId)) invalid('sources'); ids.add(source.spaceId);
      if (typeof source.title !== 'string' || !source.title.trim() || Array.from(source.title).length > 200) invalid('source.title');
      if (!['running', 'stopped', 'failed', 'unknown'].includes(source.sourceState)) invalid('sourceState');
    }
    return sources;
  }
  private pending(policy: StoredPublicationPolicy): boolean {
    return policy.selection !== null && !this.runs.get(policy.spaceId)?.grants.some(g => g.providerId === policy.providerId && g.revision === policy.revision);
  }
  /** Invoke ONLY inside existing preview/plan.execute after its epoch/revision/generation checks. */
  applyPublication(input: PublicationPlanInput, assertPlanExecution: () => void): Promise<PublicationPolicy> {
    return this.run(async () => {
      assertPlanExecution(); const request = parsePublicationPlan(input); await this.policies();
      if (!this.sources().some(s => s.spaceId === request.spaceId) || request.spaceId === 'web') throw new DashboardFault('dashboard/not-found');
      const previous = this.policy(request.spaceId, request.providerId);
      if ((previous?.revision ?? 'absent') !== request.expectedGrantRevision) throw new DashboardFault('dashboard/revision-conflict');
      const revision = this.id(); if (revision === 'absent' || revision === previous?.revision) invalid('revision');
      const next = { spaceId: request.spaceId, providerId: request.providerId, revision, selection: request.selection };
      const candidate = parseHomePolicyBook({ schemaVersion: 1, policies: [...this.book!.policies.filter(p => key(p.spaceId, p.providerId) !== key(next.spaceId, next.providerId)), next] });
      this.usable(); assertPlanExecution();
      try { await this.options.store.writePolicies(candidate); }
      catch { this.broken = true; throw new DashboardFault('dashboard/storage-failed'); }
      // From this point the old grant is unusable, even if deleting its file fails.
      this.book = candidate; this.cache.delete(key(next.spaceId, next.providerId)); this.cursors.clear(); this.metadata = '';
      const run = this.runs.get(next.spaceId); run?.failedProviders.add(next.providerId); run?.providerActivity.delete(next.providerId);
      try { await this.options.store.deleteProjection(next.spaceId, next.providerId); }
      catch { throw new DashboardFault('dashboard/storage-failed'); }
      this.usable();
      return { ...copyJson(next), pendingStart: next.selection !== null };
    });
  }
  /** A fresh user-requested process start. No calls from discovery, reads or failure handlers. */
  beginRun(input: OwnedDashboardRun): Promise<HomeRunPublisher> {
    const binding = copyJson(input); identifier(binding.spaceId); identifier(binding.runId);
    if (binding.spaceId === 'web' || !Number.isSafeInteger(binding.generation) || binding.generation < 1) throw new DashboardFault('dashboard/forbidden');
    return this.run(async () => {
      this.options.assertRun(binding); await this.policies(); this.options.assertRun(binding);
      if (this.usedRunIds.has(binding.runId)) throw new DashboardFault('dashboard/request-conflict');
      if (this.usedRunIds.size >= 10000) throw new DashboardFault('dashboard/limit-exceeded');
      if (this.runs.get(binding.spaceId)?.open) throw new DashboardFault('dashboard/request-conflict');
      const grants = this.book!.policies.filter(p => p.spaceId === binding.spaceId && p.selection !== null)
        .map(p => ({ providerId: p.providerId, revision: p.revision, selection: copyJson(p.selection!) }));
      const state: Run = { binding, grants, open: true, lastActivity: this.now(), failedProviders: new Set(), providerActivity: new Map(), sentAt: [], publishedAt: new Map() };
      this.usedRunIds.add(binding.runId); this.runs.set(binding.spaceId, state); this.cursors.clear(); this.metadata = '';
      return {
        grant: () => this.run(async () => { this.checkRun(state); this.rate(state); return { protocolVersion: 1, runId: binding.runId, spaceId: binding.spaceId, grants: copyJson(grants.filter(g => this.policy(binding.spaceId, g.providerId)?.revision === g.revision && !state.failedProviders.has(g.providerId))) }; }),
        publish: value => this.publish(state, value),
        heartbeat: value => this.heartbeat(state, value),
        close: () => { state.open = false; state.providerActivity.clear(); this.cursors.clear(); this.metadata = ''; },
      };
    });
  }
  private checkRun(run: Run): void {
    this.usable();
    if (!run.open || this.runs.get(run.binding.spaceId) !== run) throw new DashboardFault('dashboard/stale-run');
    this.options.assertRun(run.binding);
    if (this.now() - run.lastActivity >= CHANNEL_STALE_MS) { run.open = false; throw new DashboardFault('dashboard/unavailable'); }
  }
  private rate(run: Run, provider?: string): void {
    const now = this.now(); run.sentAt = run.sentAt.filter(at => now - at < 1000);
    if (run.sentAt.length >= 5 || (provider !== undefined && now - (run.publishedAt.get(provider) ?? -Infinity) < 1000)) throw new DashboardFault('dashboard/rate-limited');
    run.sentAt.push(now); if (provider !== undefined) run.publishedAt.set(provider, now);
  }
  private publish(run: Run, input: unknown): Promise<PublishAck> {
    return this.run(async () => {
      this.checkRun(run);
      const request = parsePublishRequest(input);
      const provider = request.providerId;
      const grant = run.grants.find(g => g.providerId === provider), policy = this.policy(run.binding.spaceId, provider);
      if (request.runId !== run.binding.runId) throw new DashboardFault('dashboard/stale-run');
      if (!grant || !policy || policy.revision !== grant.revision || request.grantRevision !== grant.revision) throw new DashboardFault('dashboard/stale-grant');
      if (run.failedProviders.has(provider)) throw new DashboardFault('dashboard/unavailable');
      try {
        this.rate(run, provider);
        const previous = await this.projection(policy);
        const prepared = preparePublication(previous, request, { ...run.binding, providerId: provider, grantRevision: grant.revision, selection: policy.selection }, new Date(this.now()).toISOString());
        if (prepared.changed) {
          let count = prepared.projection.request.instances.length, bytes = byteLength(canonicalJson(prepared.projection));
          for (const other of this.book!.policies) {
            if (!other.selection || key(other.spaceId, other.providerId) === key(policy.spaceId, provider)) continue;
            const existing = await this.projection(other);
            if (existing) { count += existing.request.instances.length; bytes += byteLength(canonicalJson(existing)); }
          }
          limit(count, DASHBOARD_LIMITS.maxHomeInstances, 'homeInstances'); limit(bytes, DASHBOARD_LIMITS.maxHomeProjectionBytes, 'homeProjectionBytes');
          this.checkRun(run);
          try { await this.options.store.writeProjection(prepared.projection); }
          catch { throw new DashboardFault('dashboard/storage-failed'); }
          this.cache.set(key(policy.spaceId, provider), copyJson(prepared.projection));
          run.lastActivity = this.now(); run.providerActivity.set(provider, this.now());
        }
        this.checkRun(run); return copyJson(prepared.ack);
      } catch (error) { run.failedProviders.add(provider); run.providerActivity.delete(provider); throw error; }
    });
  }
  private heartbeat(run: Run, input: unknown): Promise<HeartbeatAck> {
    return this.run(async () => {
      this.checkRun(run); this.rate(run); const heartbeat = parseHeartbeat(input);
      if (heartbeat.runId !== run.binding.runId) throw new DashboardFault('dashboard/stale-run');
      const updates: Array<{ id: string; state: 'ready' | 'failed' }> = [];
      for (const p of heartbeat.providers) {
        const grant = run.grants.find(g => g.providerId === p.providerId);
        if (!grant) throw new DashboardFault('dashboard/forbidden');
        const policy = this.policy(run.binding.spaceId, p.providerId);
        if (!policy || policy.revision !== grant.revision) continue;
        const projection = await this.projection(policy);
        const accepted = projection?.request.runId === run.binding.runId ? projection.request.sequence : 0;
        if (p.lastSequence > accepted) throw new DashboardFault('dashboard/stale-sequence');
        updates.push({ id: p.providerId, state: p.state });
      }
      this.checkRun(run); const now = this.now(); run.lastActivity = now;
      for (const update of updates) {
        if (update.state === 'failed') { run.failedProviders.add(update.id); run.providerActivity.delete(update.id); }
        else if (!run.failedProviders.has(update.id)) run.providerActivity.set(update.id, now);
      }
      return { protocolVersion: 1, receivedAt: new Date(now).toISOString() };
    });
  }
  private async view(ref: InstanceRef): Promise<InstanceView> {
    const denied: InstanceView = { state: 'unavailable', ref: copyJson(ref), reason: 'not-found' };
    if (!this.allowed(ref)) return denied;
    const policy = this.policy(ref.spaceId, ref.providerId)!;
    const projection = await this.projection(policy);
    const source = this.sources().find(source => source.spaceId === ref.spaceId);
    if (!source) return denied;
    const run = this.runs.get(ref.spaceId);
    const active = run?.open && this.now() - run.lastActivity < CHANNEL_STALE_MS && projection?.request.runId === run.binding.runId;
    return readProjection(projection, ref, { ...policy, grantRevision: policy.revision }, {
      now: this.now(), sourceState: source.sourceState,
      lastActivityAt: active ? run.providerActivity.get(ref.providerId) ?? null : null,
    });
  }
  private async catalog(): Promise<CatalogEntry[]> {
    const entries: CatalogEntry[] = [];
    const sources = this.sources();
    for (const policy of this.book!.policies) {
      const source = sources.find(s => s.spaceId === policy.spaceId);
      if (!source || !policy.selection) continue;
      const projection = await this.projection(policy); if (!projection) continue;
      for (const instance of projection.request.instances) if (selectionAllows(policy.selection, instance.instanceId)) entries.push({
        ref: { spaceId: policy.spaceId, providerId: policy.providerId, instanceId: instance.instanceId },
        typeId: instance.typeId, typeVersion: instance.typeVersion, kind: instance.content.kind, title: instance.title, sourceState: source.sourceState,
      });
    }
    entries.sort((a, b) => refKey(a.ref) < refKey(b.ref) ? -1 : refKey(a.ref) > refKey(b.ref) ? 1 : 0);
    const metadata = canonicalJson(entries);
    if (metadata !== this.metadata) { this.catalogRevision = this.id(); this.metadata = metadata; this.cursors.clear(); }
    return entries;
  }
  private async queryData(request: DashboardQuery, reader: HomeReader): Promise<DashboardQueryData> {
    const layout = await this.layouts();
    switch (request.kind) {
      case 'overview': {
        let defaultBoardId = layout.boards[0]?.id ?? 'home', n = 1;
        while (!layout.boards.length && layout.tombstones.some(t => t.id === defaultBoardId)) defaultBoardId = `home-${++n}`;
        return { kind: 'overview', mode: 'home', defaultBoardId, boards: layout.boards.map(({ id, title, revision }) => ({ id, title, revision })),
          sources: this.sources().map(source => {
            const policies = this.book!.policies.filter(p => p.spaceId === source.spaceId && p.selection !== null), run = this.runs.get(source.spaceId);
            return { ...source, publishing: !policies.length ? 'disabled' : policies.some(p => this.pending(p)) ? 'pending-start' : run?.open && this.now() - run.lastActivity < CHANNEL_STALE_MS ? 'active' : 'unavailable' };
          }), limits: { ...DASHBOARD_LIMITS }, capabilities: { layoutWrite: reader.layoutWrite, publicationsManage: reader.publicationsManage, executeActions: false } };
      }
      case 'catalog': {
        const entries = await this.catalog(), count = request.limit ?? 50;
        const filter = canonicalJson(request.spaceIds === undefined ? null : [...request.spaceIds].sort());
        let offset = 0;
        if (request.cursor !== undefined) {
          const cursor = this.cursors.get(request.cursor);
          if (!cursor || cursor.subject !== reader.subjectId || cursor.filter !== filter || cursor.count !== count || cursor.revision !== this.catalogRevision || cursor.expires <= this.now()) throw new DashboardFault('dashboard/cursor-invalid');
          offset = cursor.offset;
        }
        const filtered = request.spaceIds === undefined ? entries : entries.filter(e => request.spaceIds!.includes(e.ref.spaceId));
        let nextCursor: string | null = null;
        if (offset + count < filtered.length) {
          for (const [id, cursor] of this.cursors) if (cursor.expires <= this.now()) this.cursors.delete(id);
          if (this.cursors.size >= 256) throw new DashboardFault('dashboard/unavailable');
          nextCursor = this.id(); if (this.cursors.has(nextCursor)) throw new DashboardFault('dashboard/unavailable');
          this.cursors.set(nextCursor, { subject: reader.subjectId, filter, revision: this.catalogRevision, offset: offset + count, count, expires: this.now() + 300000 });
        }
        return { kind: 'catalog', entries: filtered.slice(offset, offset + count), catalogRevision: this.catalogRevision, nextCursor };
      }
      case 'instances': return { kind: 'instances', items: await Promise.all(request.refs.map(ref => this.view(ref))) };
      case 'board': {
        const board = copyJson(layout.boards.find(b => b.id === request.boardId) ?? null);
        if (board) board.placements = board.placements.filter(p => this.allowed(p.ref));
        return { kind: 'board', board };
      }
      case 'receipt': return { kind: 'receipt', receipt: readReceipt(layout, request.requestId, { subjectId: reader.subjectId, now: this.now(), canRead: ref => this.allowed(ref) }) };
      case 'publications':
        if (!reader.publicationsManage) throw new DashboardFault('dashboard/forbidden');
        return { kind: 'publications', policies: this.book!.policies.filter(p => p.spaceId === request.spaceId).map(p => ({ ...copyJson(p), pendingStart: this.pending(p) })) };
      case 'navigation': {
        const view = await this.view(request.ref);
        const target = view.state === 'present' && view.sourceState === 'running' ? view.instance.sourceTarget : null;
        const available = target !== null && (this.options.targetExists ? await this.options.targetExists(request.ref.spaceId, copyJson(target)) : target.kind === 'space');
        return { kind: 'navigation', ref: copyJson(request.ref), available, target: available ? target : null };
      }
    }
  }
  /** Optional delivery is synchronous under the policy lock, preventing revoke-vs-response races. */
  query(input: DashboardQuery, auth: HomeAuthorizer, deliver?: (value: DashboardQueryResponse) => void): Promise<DashboardQueryResponse> {
    let subject: string; try { subject = this.authorize(auth).subjectId; } catch (error) { return Promise.reject(error); }
    const request = parseQuery(input);
    return this.run(async () => {
      const reader = this.authorize(auth, subject); await this.policies();
      const data = await this.queryData(request, reader); this.authorize(auth, subject);
      const value: DashboardQueryResponse = { protocolVersion: 1, backendEpoch: this.options.backendEpoch, data };
      limit(byteLength(canonicalJson(value)), 8 * 1024 * 1024, 'response');
      const response = copyJson(value); deliver?.(response); return response;
    });
  }
  mutate(input: BoardMutation, auth: HomeAuthorizer, deliver?: (value: BoardMutationReceipt) => void): Promise<BoardMutationReceipt> {
    let subject: string; try { subject = this.authorize(auth).subjectId; } catch (error) { return Promise.reject(error); }
    return this.run(async () => {
      const reader = this.authorize(auth, subject); if (!reader.layoutWrite) throw new DashboardFault('dashboard/forbidden');
      await this.policies(); const layout = await this.layouts();
      // New references require real currently authorized projections, not just policy entries.
      const readable = new Set((await this.catalog()).map(e => refKey(e.ref)));
      const prepared = prepareLayout(layout, input, { backendEpoch: this.options.backendEpoch, subjectId: reader.subjectId, now: this.now(), newRevision: this.id(), canRead: ref => readable.has(refKey(ref)) });
      this.authorize(auth, reader.subjectId);
      if (prepared.changed) {
        try { await this.options.store.writeLayout(prepared.document); }
        catch { this.broken = true; throw new DashboardFault('dashboard/storage-failed'); }
        this.layout = prepared.document;
      }
      this.authorize(auth, reader.subjectId); const response = copyJson(prepared.receipt); deliver?.(response); return response;
    });
  }
  client(auth: HomeAuthorizer): DashboardBackend { return { query: input => this.query(input, auth), mutate: input => this.mutate(input, auth) }; }
  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.closed = true; for (const run of this.runs.values()) run.open = false;
    this.cursors.clear();
    this.closeResult = this.tail.then(() => this.options.store.close()).finally(() => { this.cache.clear(); this.book = null; this.layout = null; this.runs.clear(); });
    return this.closeResult;
  }
}
