/** Design-only v1 contract. Not a published SDK or runtime validator. */
export type Id = string;
export type Revision = string;
export type Timestamp = string;
export type Mode = 'local' | 'home';
export type WidgetKind = 'progress' | 'metric' | 'list' | 'markdown';
export type SourceState = 'running' | 'stopped' | 'failed' | 'unknown';
export type WorkState = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

export interface InstanceRef {
  spaceId: Id;
  providerId: Id;
  instanceId: Id;
}
export interface WidgetType {
  typeId: Id;
  version: number;
  kind: WidgetKind;
  title: string;
}
export type WidgetContent =
  | { kind: 'progress'; value: number; max: number; unit: string; status: WorkState }
  | { kind: 'metric'; value: number; unit: string }
  | { kind: 'list'; items: Array<{ id: Id; label: string; state: 'todo' | 'doing' | 'done' | 'blocked' }> }
  | { kind: 'markdown'; text: string };
export type SourceTarget =
  | { kind: 'space' }
  | { kind: 'session'; id: Id }
  | { kind: 'artifact'; id: Id };
export interface WidgetInstance {
  instanceId: Id;
  typeId: Id;
  typeVersion: number;
  title: string;
  content: WidgetContent;
  sourceTarget: SourceTarget | null;
  updatedAt: Timestamp;
  staleAfterSeconds: number | null;
}

/** spaceId/homeId must NOT be accepted from this request body. */
export interface PublishRequest {
  protocolVersion: 1;
  runId: Id;
  providerId: Id;
  sequence: number;
  grantRevision: Revision;
  types: WidgetType[];
  instances: WidgetInstance[];
}
export interface PublishAck {
  protocolVersion: 1;
  runId: Id;
  providerId: Id;
  sequence: number;
  receivedAt: Timestamp;
  accepted: true;
}
export type PublicationSelection =
  | { kind: 'all' }
  | { kind: 'selected'; instanceIds: Id[] };
export interface PublisherGrant {
  protocolVersion: 1;
  runId: Id;
  spaceId: Id;
  grants: Array<{ providerId: Id; revision: Revision; selection: PublicationSelection }>;
}
export interface PublisherHeartbeat {
  protocolVersion: 1;
  runId: Id;
  providers: Array<{ providerId: Id; lastSequence: number; state: 'ready' | 'failed' }>;
}
export interface HeartbeatAck {
  protocolVersion: 1;
  receivedAt: Timestamp;
}
export interface PublicationPolicy {
  spaceId: Id;
  providerId: Id;
  revision: Revision;
  selection: PublicationSelection | null;
  pendingStart: boolean;
}
/** Proposed addition to WorkbenchPlanRequest, not an existing command. */
export interface PublicationPlanInput {
  kind: 'dashboard.publication.set';
  spaceId: Id;
  providerId: Id;
  expectedGrantRevision: Revision;
  selection: PublicationSelection | null;
}

export interface Placement {
  id: Id;
  ref: InstanceRef;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Board {
  id: Id;
  title: string;
  revision: Revision;
  placements: Placement[];
}
export interface Limits {
  maxRequestBytes: number;
  maxProvidersPerSpace: number;
  maxLayoutBytes: number;
  maxReceipts: number;
  maxBoardIds: number;
  maxTypesPerProvider: number;
  maxInstancesPerProvider: number;
  maxContentBytes: number;
  maxPublishBytes: number;
  maxQueryRefs: number;
  maxHomeInstances: number;
  maxHomeProjectionBytes: number;
  maxBoards: number;
  maxPlacementsPerBoard: number;
  maxCatalogPageSize: number;
}
export interface CatalogEntry {
  ref: InstanceRef;
  typeId: Id;
  typeVersion: number;
  kind: WidgetKind;
  title: string;
  sourceState: SourceState;
}
export type InstanceView =
  | {
      state: 'present';
      ref: InstanceRef;
      instance: WidgetInstance;
      runId: Id;
      sequence: number;
      receivedAt: Timestamp;
      freshness: 'current' | 'stale';
      sourceState: SourceState;
    }
  | {
      state: 'unavailable';
      ref: InstanceRef;
      reason: 'not-found' | 'source-removed' | 'unsupported';
    };
export interface SourceSummary {
  spaceId: Id;
  title: string;
  sourceState: SourceState;
  publishing: 'disabled' | 'active' | 'pending-start' | 'failed' | 'unavailable';
}
export type DashboardQuery =
  | { kind: 'overview' }
  | { kind: 'catalog'; spaceIds?: Id[]; cursor?: string; limit?: number }
  | { kind: 'instances'; refs: InstanceRef[] }
  | { kind: 'board'; boardId: Id }
  | { kind: 'receipt'; requestId: Id }
  | { kind: 'navigation'; ref: InstanceRef }
  | { kind: 'publications'; spaceId: Id };
export type DashboardQueryData =
  | {
      kind: 'overview';
      mode: Mode;
      defaultBoardId: Id;
      boards: Array<{ id: Id; title: string; revision: Revision }>;
      sources: SourceSummary[];
      limits: Limits;
      capabilities: { layoutWrite: boolean; publicationsManage: boolean; executeActions: false };
    }
  | { kind: 'catalog'; entries: CatalogEntry[]; catalogRevision: Revision; nextCursor: string | null }
  | { kind: 'instances'; items: InstanceView[] }
  | { kind: 'board'; board: Board | null }
  | { kind: 'receipt'; receipt: BoardMutationReceipt | null }
  | { kind: 'navigation'; ref: InstanceRef; target: SourceTarget | null; available: boolean }
  | { kind: 'publications'; policies: PublicationPolicy[] };
export interface DashboardQueryResponse {
  protocolVersion: 1;
  backendEpoch: Id;
  data: DashboardQueryData;
}
export type BoardCommand =
  | { kind: 'board.create'; boardId: Id; title: string; placements: Placement[] }
  | { kind: 'board.replace'; boardId: Id; expectedRevision: Revision; title: string; placements: Placement[] }
  | { kind: 'board.delete'; boardId: Id; expectedRevision: Revision };
export interface BoardMutation {
  requestId: Id;
  issuedAt: Timestamp;
  backendEpoch: Id;
  command: BoardCommand;
}
export interface BoardMutationReceipt {
  protocolVersion: 1;
  backendEpoch: Id;
  requestId: Id;
  result:
    | { kind: 'board.saved'; board: Board }
    | { kind: 'board.deleted'; boardId: Id; revision: Revision };
}
export type ErrorCode =
  | 'dashboard/invalid-input'
  | 'dashboard/unauthenticated'
  | 'dashboard/forbidden'
  | 'dashboard/not-found'
  | 'dashboard/stale-epoch'
  | 'dashboard/stale-run'
  | 'dashboard/stale-grant'
  | 'dashboard/stale-sequence'
  | 'dashboard/sequence-conflict'
  | 'dashboard/revision-conflict'
  | 'dashboard/request-conflict'
  | 'dashboard/request-expired'
  | 'dashboard/cursor-invalid'
  | 'dashboard/limit-exceeded'
  | 'dashboard/rate-limited'
  | 'dashboard/unsupported-version'
  | 'dashboard/unsupported-operation'
  | 'dashboard/unavailable'
  | 'dashboard/storage-failed';
export interface DashboardError {
  code: ErrorCode;
  message: string;
  requestId?: Id;
  details?: { field?: string; limit?: number; actual?: number };
}
export interface ErrorResponse {
  protocolVersion: 1;
  error: DashboardError;
}
export interface DashboardBackend {
  query(request: DashboardQuery): Promise<DashboardQueryResponse>;
  mutate(request: BoardMutation): Promise<BoardMutationReceipt>;
}

/** The Host binds provider identity; a business plugin cannot choose another ID. */
export interface ProviderRegistration {
  types: WidgetType[];
  snapshot(): Promise<WidgetInstance[]> | WidgetInstance[];
}
export type LocalPublishResult = {
  localRevision: Revision;
  home:
    | { state: 'not-configured' }
    | { state: 'not-authorized' }
    | { state: 'published'; sequence: number }
    | { state: 'failed'; error: DashboardError };
};
export interface ProviderHandle {
  publish(): Promise<LocalPublishResult>;
  dispose(): Promise<void>;
}
export interface BoundProviderRegistry {
  register(provider: ProviderRegistration): ProviderHandle;
}
