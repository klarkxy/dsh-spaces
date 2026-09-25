import type { DashboardBackend, PublicationPlanInput, PublicationPolicy, PublicationSelection } from '../../../../src/shared/dashboard';
import type { WorkbenchApi, WorkbenchView } from '../../../../src/shared/workbench';
import type { DashboardReadBackend } from '../../../dashboard/src/model';
import { createDashboardHttpBackend } from '../../../dashboard/src/http-client';
import { DashboardFault } from '../../../../src/core/domain/dashboard/errors';
import { copyJson, identifier, object, parseSelection } from '../../../../src/core/domain/dashboard/validation';
import { authorizedViewSrc } from './view-session';

/** Resolve the endpoint through a real authenticated manager view. No token, path
 * discovery, parent-window scraping or trust in arbitrary window globals. */
export function dashboardEndpoint(view: WorkbenchView, expected: { managerId: string; epoch: string; generation: number; pageOrigin: string }): string {
  authorizedViewSrc(view); // Existing clean endpoint/path validation also rejects credentials.
  const child = new URL(view.origin), supervisor = new URL(view.entryOrigin);
  if (view.spaceId !== expected.managerId || view.serviceEpoch !== expected.epoch || view.generation !== expected.generation ||
      view.origin !== expected.pageOrigin || child.protocol !== 'http:' || child.hostname !== '127.0.0.1' ||
      supervisor.protocol !== 'http:' || supervisor.hostname !== '127.0.0.1' || supervisor.origin !== view.entryOrigin) {
    throw new DashboardFault('dashboard/forbidden');
  }
  return view.entryOrigin;
}
export async function connectWorkbenchDashboard(api: Pick<WorkbenchApi, 'view'>, expected: Parameters<typeof dashboardEndpoint>[1], request: typeof fetch = fetch): Promise<DashboardReadBackend> {
  const view = await api.view(expected.managerId);
  return createDashboardHttpBackend(dashboardEndpoint(view, expected), request, 'owned-manager');
}

export function readPublicationPolicies(value: unknown, epoch: string, spaceId: string): PublicationPolicy[] {
  const envelope = object(copyJson(value), ['protocolVersion', 'backendEpoch', 'data']);
  if (envelope.protocolVersion !== 1) throw new DashboardFault('dashboard/unsupported-version');
  if (envelope.backendEpoch !== epoch) throw new DashboardFault('dashboard/stale-epoch');
  const data = object(envelope.data, ['kind', 'policies']);
  if (data.kind !== 'publications' || !Array.isArray(data.policies) || data.policies.length > 32) throw new DashboardFault('dashboard/invalid-input');
  const seen = new Set<string>();
  return data.policies.map(input => {
    const p = object(input, ['spaceId', 'providerId', 'revision', 'selection', 'pendingStart']);
    const providerId = identifier(p.providerId), revision = identifier(p.revision);
    if (p.spaceId !== spaceId || seen.has(providerId) || typeof p.pendingStart !== 'boolean') throw new DashboardFault('dashboard/invalid-input');
    seen.add(providerId);
    return { spaceId, providerId, revision, selection: parseSelection(p.selection), pendingStart: p.pendingStart };
  });
}
export function publicationInput(spaceId: string, providerId: string, revision: string, mode: 'disabled' | 'selected' | 'all', selectedText: string): PublicationPlanInput {
  identifier(spaceId); identifier(providerId); identifier(revision);
  // Blank/duplicate lines are errors, not silently normalized into broader access.
  let selection: PublicationSelection | null = null;
  if (mode === 'all') selection = { kind: 'all' };
  else if (mode === 'selected') selection = parseSelection({ kind: 'selected', instanceIds: selectedText.split('\n').map(v => v.trim()) });
  else if (mode !== 'disabled') throw new DashboardFault('dashboard/invalid-input');
  return { kind: 'dashboard.publication.set', spaceId, providerId, expectedGrantRevision: revision, selection };
}
