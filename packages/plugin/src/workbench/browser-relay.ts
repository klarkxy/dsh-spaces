import { BROWSER_HIDE, BROWSER_RELAY, BROWSER_RESULT, clipBrowserViewport, parseBrowserChild, parseBrowserObservations,
  type BrowserIdentity, type BrowserRelay, type BrowserGuestResult } from '../../../../src/shared/browser-guest';
import type { WorkbenchController, WorkbenchUiState } from './store';
import type { ViewFrameState } from './view-session';
export function browserFrameVisible(ui: WorkbenchUiState, frame: ViewFrameState): boolean {
  return ui.boot === 'ready' && ui.state?.availability === 'ready' && ui.selected === frame.spaceId &&
    ui.visibleSpaceId === frame.spaceId && !ui.pendingId && !ui.overlay && !ui.pendingPlan && !ui.commandPending &&
    !ui.viewError && frame.status === 'ready' && frame.view?.serviceEpoch === ui.state.serviceEpoch;
}
const identityOf = (frame: ViewFrameState): BrowserIdentity => ({ spaceId: frame.view!.spaceId, generation: frame.view!.generation,
  serviceEpoch: frame.view!.serviceEpoch, origin: frame.view!.origin, channel: frame.view!.channel });
const installed = new WeakMap<WorkbenchController, { references: number; close(): void }>();
/** Multiple manager surfaces sharing a controller must not duplicate requests. */
export function installBrowserRelay(controller: WorkbenchController): () => void {
  let entry = installed.get(controller);
  if (!entry) { entry = { references: 0, close: startBrowserRelay(controller) }; installed.set(controller, entry); }
  entry.references++;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--entry!.references === 0) { installed.delete(controller); entry!.close(); }
  };
}
/** A trusted manager relays only its selected, registered child; it grants no iframe Electron APIs. */
function startBrowserRelay(controller: WorkbenchController): () => void {
  if (typeof window === 'undefined' || window.top === window) return () => {};
  const pending = new Map<string, { source: Window; origin: string; topOrigin: string; identity: BrowserIdentity; timer: ReturnType<typeof setTimeout> }>();
  let current: { identity: BrowserIdentity; topOrigin: string } | null = null;
  const reply = (source: Window, origin: string, requestId: string, error: 'unavailable' | 'unauthorized' | 'not-visible') =>
    source.postMessage({ source: BROWSER_RESULT, requestId, ok: false, error }, origin);
  const hide = () => {
    if (current) {
      const relay: BrowserRelay = { source: BROWSER_RELAY, requestId: crypto.randomUUID(), kind: 'hide', identity: current.identity };
      window.top!.postMessage(relay, current.topOrigin); current = null;
    }
    for (const [id, p] of pending) { clearTimeout(p.timer); reply(p.source, p.origin, id, 'not-visible'); }
    pending.clear();
  };
  const update = () => {
    if (!current) return;
    const frame = controller.views.list().find(f => f.spaceId === current!.identity.spaceId);
    if (!frame || !browserFrameVisible(controller.getSnapshot(), frame) || frame.view?.channel !== current.identity.channel) hide();
  };
  const receive = (event: MessageEvent) => {
    if (event.data?.source === BROWSER_RESULT && event.source === window.top) {
      const result = event.data as BrowserGuestResult, p = pending.get(result.requestId);
      if (!p || event.origin !== p.topOrigin || typeof result.ok !== 'boolean' ||
        (result.ok && (result.mode !== 'native' || !parseBrowserObservations(result.observations)))) return;
      pending.delete(result.requestId); clearTimeout(p.timer);
      const frame = controller.views.list().find(f => f.spaceId === p.identity.spaceId);
      if (!frame || !browserFrameVisible(controller.getSnapshot(), frame) || frame.view?.channel !== p.identity.channel) { reply(p.source, p.origin, result.requestId, 'not-visible'); return; }
      p.source.postMessage(result, p.origin); return;
    }
    const request = parseBrowserChild(event.data);
    if (!request || !event.source) return;
    const frame = controller.views.list().find(f => f.spaceId === request.spaceId && f.generation === request.generation);
    if (!frame?.view || frame.view.channel !== request.channel || !controller.isRegisteredViewSource(event, frame)) return;
    if (request.source === BROWSER_HIDE) {
      if (current?.identity.channel === frame.view.channel) hide();
      (event.source as Window).postMessage({ source: BROWSER_RESULT, requestId: request.requestId, ok: true, tabId: '', mode: 'native', observations: [] }, event.origin); return;
    }
    if (!browserFrameVisible(controller.getSnapshot(), frame)) { reply(event.source as Window, event.origin, request.requestId, 'not-visible'); return; }
    if (pending.size >= 32 || pending.has(request.requestId)) {
      reply(event.source as Window, event.origin, request.requestId, 'unauthorized'); return;
    }
    const element = [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-space-id]')].find(el => el.contentWindow === event.source);
    if (!element || element.hidden) { reply(event.source as Window, event.origin, request.requestId, 'unavailable'); return; }
    const rect = element.getBoundingClientRect();
    const viewport = clipBrowserViewport({ ...request.viewport, x: rect.x + request.viewport.x, y: rect.y + request.viewport.y },
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    if (!viewport) { reply(event.source as Window, event.origin, request.requestId, 'unavailable'); return; }
    const identity = identityOf(frame);
    if (current && current.identity.channel !== identity.channel) hide();
    current = { identity, topOrigin: frame.view.entryOrigin };
    const timer = setTimeout(() => {
      pending.delete(request.requestId); reply(event.source as Window, event.origin, request.requestId, 'unavailable');
    }, 2500);
    pending.set(request.requestId, { source: event.source as Window, origin: event.origin, topOrigin: frame.view.entryOrigin, identity, timer });
    window.top!.postMessage({ source: BROWSER_RELAY, requestId: request.requestId, kind: 'present', identity,
      tabId: request.tabId, url: request.url, viewport } satisfies BrowserRelay, frame.view.entryOrigin);
  };
  window.addEventListener('message', receive); window.addEventListener('pagehide', hide);
  const unsubscribe = controller.subscribe(update);
  return () => { unsubscribe(); window.removeEventListener('message', receive); window.removeEventListener('pagehide', hide); hide(); };
}
