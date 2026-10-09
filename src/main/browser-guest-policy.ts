import type { WorkbenchApi } from '../shared/workbench';
import type { BrowserIdentity } from '../shared/browser-guest';
/** Management authority is re-read; a renderer-supplied origin is never sufficient. */
export async function authorizeBrowserGuest(api: WorkbenchApi, managerOrigin: string, identity: BrowserIdentity): Promise<boolean> {
  const state = await api.state();
  const space = state.spaces.find(s => s.id === identity.spaceId);
  if (!state.managerId || state.availability !== 'ready' || state.serviceEpoch !== identity.serviceEpoch ||
    !space?.managed || space.isHost || space.status !== 'running' || space.generation !== identity.generation) return false;
  const [manager, target, detail] = await Promise.all([api.view(state.managerId), api.view(space.id), api.detail(space.id)]);
  if (manager.origin !== managerOrigin || manager.serviceEpoch !== identity.serviceEpoch ||
    !(['spaceId', 'generation', 'serviceEpoch', 'origin', 'channel'] as const).every(key => target[key] === identity[key]) ||
    !detail.plugins.some(p => p.name === '@dsh-spaces/browser')) return false;
  const latest = await api.state();
  const current = latest.spaces.find(s => s.id === identity.spaceId);
  return latest.availability === 'ready' && latest.serviceEpoch === state.serviceEpoch && latest.managerId === state.managerId &&
    current?.managed === true && current.status === 'running' && current.generation === identity.generation;
}
