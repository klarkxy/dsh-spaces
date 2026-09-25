import type {
  InstanceRef, InstanceView, Limits, PublicationSelection, PublishAck, PublishRequest, SourceState,
} from '../../../shared/dashboard.js';
import { DashboardFault } from './errors.js';
import { CHANNEL_STALE_MS, DASHBOARD_LIMITS } from './limits.js';
import { canonicalJson, copyJson, identifier, parsePublishRequest, parseSelection, timestampMillis } from './validation.js';

/** Supplied ONLY by the authenticated Host adapter, never by a request body. */
export interface PublishAuthority {
  spaceId: string;
  providerId: string;
  runId: string;
  grantRevision: string;
  selection: PublicationSelection | null;
}
export interface Projection {
  spaceId: string;
  request: PublishRequest;
  ack: PublishAck;
}
export interface PreparedPublication {
  projection: Projection;
  ack: PublishAck;
  changed: boolean;
}
export interface ProjectionAccess {
  spaceId: string;
  providerId: string;
  grantRevision: string;
  selection: PublicationSelection | null;
}
export function selectionAllows(selection: PublicationSelection | null, instanceId: string): boolean {
  return selection !== null && (selection.kind === 'all' || selection.instanceIds.includes(instanceId));
}

/** Pure candidate preparation, NOT durable acceptance. Commit under the Home lock before sending ack. */
export function preparePublication(
  previous: Projection | null,
  input: unknown,
  authority: PublishAuthority,
  receivedAt: string,
  limits: Readonly<Limits> = DASHBOARD_LIMITS,
): PreparedPublication {
  identifier(authority.spaceId, 'authority.spaceId'); identifier(authority.providerId, 'authority.providerId');
  identifier(authority.runId, 'authority.runId'); identifier(authority.grantRevision, 'authority.grantRevision');
  const selection = parseSelection(authority.selection);
  const request = parsePublishRequest(input, limits);
  timestampMillis(receivedAt, 'receivedAt');
  if (request.runId !== authority.runId) throw new DashboardFault('dashboard/stale-run');
  if (request.providerId !== authority.providerId) throw new DashboardFault('dashboard/forbidden');
  if (selection === null || request.grantRevision !== authority.grantRevision) throw new DashboardFault('dashboard/stale-grant');
  if (request.instances.some(instance => !selectionAllows(selection, instance.instanceId))) throw new DashboardFault('dashboard/forbidden');
  if (previous && (previous.spaceId !== authority.spaceId || previous.request.providerId !== authority.providerId)) throw new DashboardFault('dashboard/forbidden');
  if (previous?.request.runId === request.runId) {
    if (request.sequence < previous.request.sequence) throw new DashboardFault('dashboard/stale-sequence');
    if (request.sequence === previous.request.sequence) {
      if (canonicalJson(previous.request) !== canonicalJson(request)) throw new DashboardFault('dashboard/sequence-conflict');
      return { projection: copyJson(previous), ack: copyJson(previous.ack), changed: false };
    }
  } else if (request.sequence !== 1) throw new DashboardFault('dashboard/stale-sequence');
  const ack: PublishAck = {
    protocolVersion: 1, runId: request.runId, providerId: request.providerId,
    sequence: request.sequence, receivedAt, accepted: true,
  };
  return { projection: { spaceId: authority.spaceId, request, ack: copyJson(ack) }, ack, changed: true };
}

/** Call with CURRENT committed policy on every read, including cached/receipt/navigation reads. */
export function readProjection(
  projection: Projection | null,
  ref: InstanceRef,
  access: ProjectionAccess | null,
  observation: { now: number; sourceState: SourceState; lastActivityAt: number | null },
): InstanceView {
  const hidden: InstanceView = { state: 'unavailable', ref: copyJson(ref), reason: 'not-found' };
  if (!access || access.spaceId !== ref.spaceId || access.providerId !== ref.providerId || !selectionAllows(access.selection, ref.instanceId)) return hidden;
  if (!projection || projection.spaceId !== ref.spaceId || projection.request.providerId !== ref.providerId || projection.request.grantRevision !== access.grantRevision) return hidden;
  const instance = projection.request.instances.find(value => value.instanceId === ref.instanceId);
  if (!instance) return { ...hidden, reason: 'source-removed' };
  const received = timestampMillis(projection.ack.receivedAt);
  const activity = observation.lastActivityAt;
  const stale = observation.sourceState !== 'running' || activity === null ||
    observation.now - activity >= CHANNEL_STALE_MS ||
    (instance.staleAfterSeconds !== null && observation.now - received >= instance.staleAfterSeconds * 1000);
  return {
    state: 'present', ref: copyJson(ref), instance: copyJson(instance),
    runId: projection.request.runId, sequence: projection.request.sequence,
    receivedAt: projection.ack.receivedAt, freshness: stale ? 'stale' : 'current', sourceState: observation.sourceState,
  };
}
