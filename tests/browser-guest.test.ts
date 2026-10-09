import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { BROWSER_PRESENT, BROWSER_RELAY, browserUrl, parseBrowserChild, parseBrowserRelay, clipBrowserViewport, type BrowserIdentity } from '../src/shared/browser-guest.ts';
import { authorizeBrowserGuest } from '../src/main/browser-guest-policy.ts';
import { browserFrameVisible } from '../packages/plugin/src/workbench/browser-relay.ts';
const identity: BrowserIdentity = { spaceId: 'browser', generation: 2, serviceEpoch: 'a'.repeat(64), origin: 'http://127.0.0.1:3102', channel: 'channel-2' };
const request = () => ({ source: BROWSER_RELAY, requestId: 'req', kind: 'present', identity, tabId: 'tab1', url: 'https://example.com/', viewport: { x: 72, y: 80, width: 400, height: 300 } } as const);

test('browser bridge has a closed HTTP(S), identity and bounded viewport contract', () => {
  for (const url of ['file:///tmp/x', 'javascript:alert(1)', 'data:text/html,hi', 'https://u:p@example.com/', 'https://example.com']) assert.equal(browserUrl(url), false);
  assert.equal(browserUrl('https://example.com/'), true);
  const child = { source: BROWSER_PRESENT, requestId: 'req', spaceId: 'browser', generation: 2, channel: 'channel-2', tabId: 'tab1', url: 'https://example.com/', viewport: { x: 0, y: 60, width: 400, height: 300 } };
  assert.ok(parseBrowserChild(child)); assert.equal(parseBrowserChild({ ...child, preload: '/tmp/evil' }), null);
  assert.equal(parseBrowserChild({ ...child, viewport: { ...child.viewport, x: -1 } }), null);
  assert.ok(parseBrowserRelay(request()));
  assert.equal(parseBrowserRelay({ ...request(), identity: { ...identity, origin: 'https://evil.example' } }), null);
  assert.equal(parseBrowserRelay({ ...request(), identity: { ...identity, generation: 1.1 } }), null);
  assert.deepEqual(clipBrowserViewport({ x: 10, y: 10, width: 500, height: 500 }, { x: 70, y: 50, width: 100, height: 100 }), { x: 70, y: 50, width: 100, height: 100 });
  assert.equal(clipBrowserViewport({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 }), null);
});
function authority(overrides: Record<string, unknown> = {}) {
  const state = { serviceEpoch: identity.serviceEpoch, availability: 'ready', managerId: 'spaces-hub', spaces: [{ id: 'browser', generation: 2, managed: true, isHost: false, status: 'running' }] };
  return { state: async () => state, view: async (id: string) => id === 'spaces-hub' ? { origin: 'http://127.0.0.1:3101', serviceEpoch: identity.serviceEpoch } : { ...identity },
    detail: async () => ({ plugins: [{ name: '@dsh-spaces/browser' }] }), ...overrides } as any;
}
test('native guest authority rechecks actual manager, target run and installed Browser', async () => {
  assert.equal(await authorizeBrowserGuest(authority(), 'http://127.0.0.1:3101', identity), true);
  assert.equal(await authorizeBrowserGuest(authority(), 'http://127.0.0.1:9', identity), false);
  assert.equal(await authorizeBrowserGuest(authority(), 'http://127.0.0.1:3101', { ...identity, channel: 'stale' }), false);
  assert.equal(await authorizeBrowserGuest(authority({ detail: async () => ({ plugins: [] }) }), 'http://127.0.0.1:3101', identity), false);
  const base = authority(); let reads = 0;
  const changed = authority({ state: async () => ++reads === 1 ? base.state() : { ...await base.state(), serviceEpoch: 'b'.repeat(64) } });
  assert.equal(await authorizeBrowserGuest(changed, 'http://127.0.0.1:3101', identity), false);
  const stopped = authority({ state: async () => ({ ...await base.state(), spaces: [{ id: 'browser', managed: true, status: 'stopped', generation: 2 }] }) });
  assert.equal(await authorizeBrowserGuest(stopped, 'http://127.0.0.1:3101', identity), false);
});

test('manager visibility rejects every overlay, hidden selection, pending plan and stale epoch', () => {
  const frame = { spaceId: 'browser', generation: 2, status: 'ready', view: identity } as any;
  const ui = { boot: 'ready', state: { availability: 'ready', serviceEpoch: identity.serviceEpoch }, selected: 'browser', visibleSpaceId: 'browser' } as any;
  assert.equal(browserFrameVisible(ui, frame), true);
  for (const patch of [{ selected: 'other' }, { visibleSpaceId: null }, { overlay: { type: 'settings' } }, { pendingPlan: {} }, { commandPending: true }, { pendingId: 'other' }, { viewError: {} }, { state: { availability: 'ready', serviceEpoch: 'b'.repeat(64) } }]) assert.equal(browserFrameVisible({ ...ui, ...patch }, frame), false);
});

const mockElectron = `import {EventEmitter} from 'node:events';
export const sessions=[];export const views=[];export const shell={openExternal:async()=>{}};
export const session={fromPartition(partition){const found=sessions.find(s=>s.partition===partition);if(found)return found;const s=new EventEmitter();s.partition=partition;s.clearStorageData=async()=>{s.storageCleared=true};s.closeAllConnections=async()=>{s.connectionsClosed=true};s.setPermissionRequestHandler=f=>s.request=f;s.setPermissionCheckHandler=f=>s.check=f;s.setDevicePermissionHandler=f=>s.device=f;sessions.push(s);return s}};
export class WebContentsView{constructor(options){this.options=options;this.visible=false;this.webContents=new EventEmitter();const c=this.webContents;c.destroyed=false;c.urls=[];c.mainFrame={url:'http://127.0.0.1:3100/'};c.mainFrame.top=c.mainFrame;c.setVisualZoomLevelLimits=()=>{};c.focus=()=>{};c.isDestroyed=()=>c.destroyed;c.close=()=>{c.destroyed=true};c.loadURL=url=>{c.urls.push(url);c.url=url;c.mainFrame.url=url;return Promise.resolve()};c.setWindowOpenHandler=f=>c.open=f;c.getURL=()=>c.url??'';c.getTitle=()=>c.title??'';views.push(this)}setVisible(v){this.visible=v}setBounds(v){this.bounds=v}}
globalThis.__browserGuestMocks={views,sessions};`;
const compiled = await build({ entryPoints: ['src/main/browser-guest.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'electron-test-port', setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' })); b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: mockElectron, loader: 'js' })); } }] });
const { BrowserGuests } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function fixture() {
  const attached: any[] = [];
  const window = { isDestroyed: () => false, getContentBounds: () => ({ width: 800, height: 600 }), contentView: {
    addChildView: (v: any) => attached.push(v), removeChildView: (v: any) => { const i = attached.indexOf(v); if (i >= 0) attached.splice(i, 1); } } };
  return { attached, guests: new BrowserGuests(window), mocks: (globalThis as any).__browserGuestMocks };
}
test('actual native adapter creates hardened separate guests and denies permissions, popup and download', t => {
  const f = fixture(); t.after(() => f.guests.clear());
  const result = f.guests.present(request()); assert.equal(result.mode, 'native');
  const view = f.attached[0], prefs = view.options.webPreferences;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true); assert.equal(prefs.webviewTag, false); assert.equal(prefs.preload, undefined);
  assert.match(prefs.session.partition, /^dsh-browser-/); assert.ok(!prefs.session.partition.startsWith('persist:'));
  assert.deepEqual(view.webContents.open(), { action: 'deny' });
  let permitted = true; prefs.session.request(null, 'media', (v: boolean) => { permitted = v; }); assert.equal(permitted, false); assert.equal(prefs.session.check(), false); assert.equal(prefs.session.device(), false);
  let prevented = false; prefs.session.emit('will-download', { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  let navBlocked = false; view.webContents.emit('will-navigate', { preventDefault() { navBlocked = true; } }, 'file:///tmp/private'); assert.equal(navBlocked, true);
  assert.equal(view.bounds.y, request().viewport.y + 32); assert.equal(view.visible, true);
  f.guests.present({ ...request(), requestId: 'heartbeat' }); assert.equal(view.webContents.urls.length, 1, 'heartbeats do not replay navigation');
});
test('tab switch, same-name new run, hide and clear retire native resources without crossing sessions', t => {
  const f = fixture(); t.after(() => f.guests.clear());
  f.guests.present(request()); const first = f.attached[0];
  f.guests.present({ ...request(), tabId: 'tab2' }); assert.equal(first.visible, false); assert.equal(f.attached.length, 2);
  f.guests.hide({ ...identity, generation: 1 }); assert.equal(f.attached.length, 2);
  const partition = first.options.webPreferences.session;
  f.guests.hide(identity); assert.equal(f.attached.length, 2); assert.equal(first.visible, false);
  f.guests.present(request()); assert.equal(f.attached[0], first); assert.equal(first.visible, true);
  assert.equal(first.options.webPreferences.session, partition); assert.equal(first.webContents.urls.length, 1);
  f.guests.present({ ...request(), identity: { ...identity, generation: 3 } }); assert.equal(first.webContents.destroyed, true); assert.equal(f.attached.length, 1);
  assert.equal(partition.storageCleared, true); assert.equal(partition.connectionsClosed, true);
  f.guests.clear(); assert.equal(f.attached.length, 0);
});
test('guest failure is an actual failure, and stale presentation expires instead of surviving its owner', async t => {
  const f = fixture(); t.after(() => f.guests.clear());
  f.guests.present(request()); const first = f.attached[0];
  first.webContents.emit('render-process-gone'); assert.equal(first.visible, false); assert.throws(() => f.guests.present(request()), /unavailable/);
  f.guests.clear(); f.guests.present(request());
  await new Promise(resolve => setTimeout(resolve, 2600)); assert.equal(f.attached.length, 0);
});
test('preload and main wiring never grant a child frame generic Electron access', () => {
  const preload = readFileSync('src/preload/browser-guest.ts', 'utf8');
  assert.match(preload, /event.source !== frame.contentWindow/); assert.doesNotMatch(preload, /exposeInMainWorld/);
  const main = readFileSync('src/main/view-manager.ts', 'utf8');
  assert.match(main, /frame !== view.webContents.mainFrame/); assert.match(main, /event.sender !== view.webContents/);
  assert.doesNotMatch(main, /nodeIntegrationInSubFrames:\s*true|webviewTag:\s*true/);
});

test('manager relay binds actual iframe window/origin and revokes pending presentation before overlays', async () => {
  const { installBrowserRelay } = await import('../packages/plugin/src/workbench/browser-relay.ts');
  const { WorkbenchController } = await import('../packages/plugin/src/workbench/store.ts');
  const controller = new WorkbenchController({} as any, { storage: { getItem: () => null, setItem: () => {} } });
  const delivered: any[] = [], forwarded: any[] = [];
  const child = { postMessage: (data: unknown, origin: string) => delivered.push({ data, origin }) };
  const top = { postMessage: (data: unknown, origin: string) => forwarded.push({ data, origin }) };
  const listeners = new Map<string, Set<(event: any) => void>>();
  const fakeWindow = { top, addEventListener(name: string, fn: (e: any) => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener(name: string, fn: (e: any) => void) { listeners.get(name)?.delete(fn); } };
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), beforeDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const element = { contentWindow: child, hidden: false, getBoundingClientRect: () => ({ x: 72, y: 0, width: 500, height: 500 }) };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [element] } });
  const frame = { spaceId: 'browser', generation: 2, status: 'ready', view: { ...identity, entryOrigin: 'http://127.0.0.1:3100' } } as any;
  let ui = { boot: 'ready', state: { availability: 'ready', serviceEpoch: identity.serviceEpoch }, selected: 'browser', visibleSpaceId: 'browser' } as any;
  controller.views.list = () => [frame]; controller.getSnapshot = () => ui;
  controller.registerIframeWindow('browser', 2, child);
  const dispatch = (data: unknown, source: unknown = child, origin = identity.origin) => { for (const fn of listeners.get('message') ?? []) fn({ data, source, origin }); };
  const dispose = installBrowserRelay(controller);
  const data = { source: BROWSER_PRESENT, requestId: 'relay-1', spaceId: 'browser', generation: 2, channel: 'channel-2', tabId: 'tab1', url: 'https://example.com/', viewport: { x: 0, y: 60, width: 900, height: 900 } };
  try {
    dispatch(data, {}, identity.origin); dispatch(data, child, 'http://127.0.0.1:3999'); dispatch({ ...data, generation: 1 });
    assert.equal(forwarded.length, 0);
    dispatch(data); assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0].data.viewport, { x: 72, y: 60, width: 500, height: 440 });
    const result = { source: 'dsh-spaces-browser:result', requestId: 'relay-1', ok: true, mode: 'native', tabId: 'tab1', observations: [] };
    dispatch(result, top, 'http://127.0.0.1:3999'); assert.equal(delivered.length, 0);
    dispatch(result, top, frame.view.entryOrigin); assert.equal(delivered[0].data.ok, true);
    dispatch({ ...data, requestId: 'relay-2' });
    ui = { ...ui, overlay: { type: 'settings' } };
    for (const fn of (controller as any).listeners) fn();
    assert.equal(forwarded.at(-1).data.kind, 'hide'); assert.equal(delivered.at(-1).data.error, 'not-visible');
    const count = forwarded.length; dispatch({ ...data, requestId: 'hidden' });
    assert.equal(forwarded.length, count); assert.equal(delivered.at(-1).data.error, 'not-visible');
    ui = { ...ui, overlay: null }; dispatch({ ...data, requestId: 'visible-again' });
    assert.equal(forwarded.at(-1).data.kind, 'present');
  } finally {
    dispose();
    if (beforeWindow) Object.defineProperty(globalThis, 'window', beforeWindow); else delete (globalThis as any).window;
    if (beforeDocument) Object.defineProperty(globalThis, 'document', beforeDocument); else delete (globalThis as any).document;
  }
});

test('native observations sample live URL/title without replay and exclude retired guests', t => {
  const f = fixture(); t.after(() => f.guests.clear());
  f.guests.present(request(), [identity.origin, 'http://127.0.0.1:3101']); const first = f.attached[0];
  first.webContents.url = 'https://example.org/redirected'; first.webContents.title = 'Live title';
  const observed = f.guests.present(request(), [identity.origin, 'http://127.0.0.1:3101']);
  assert.deepEqual(observed.observations, [{ tabId: 'tab1', url: 'https://example.org/redirected', title: 'Live title' }]);
  assert.equal(first.webContents.urls.length, 1);
  let denied = false; first.webContents.emit('will-redirect', { preventDefault() { denied = true; } }, 'http://localhost:3101/private'); assert.equal(denied, true);
  f.guests.present({ ...request(), identity: { ...identity, generation: 3 }, tabId: 'new-tab' });
  first.webContents.url = 'https://example.org/stale';
  assert.equal(f.guests.present({ ...request(), identity: { ...identity, generation: 3 }, tabId: 'new-tab' }).observations.some((v: any) => v.tabId === 'tab1'), false);
});

test('actual ViewManager hides synchronously without authority IO and invalidates delayed present', async t => {
  const output = await build({ entryPoints: ['src/main/view-manager.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'electron-view-manager-test-port', setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' })); b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: mockElectron, loader: 'js' })); } }] });
  const { ViewManager } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  const attached: any[] = [];
  const window = { on() {}, isDestroyed: () => false, getContentBounds: () => ({ width: 800, height: 600 }), contentView: {
    addChildView: (v: any) => attached.push(v), removeChildView: (v: any) => { const i = attached.indexOf(v); if (i >= 0) attached.splice(i, 1); } } };
  const workbenchSession = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {} };
  const api = authority();
  const manager = new ViewManager(window, workbenchSession, { preloadPath: '/safe/browser-guest.cjs', api: () => api }); t.after(() => manager.destroy());
  manager.presentWorkbench({ entryUrl: 'http://127.0.0.1:3100/', managerOrigin: 'http://127.0.0.1:3100', onError() {} });
  const contents = attached[0].webContents, event = { sender: contents, senderFrame: contents.mainFrame };
  const input = { managerOrigin: 'http://127.0.0.1:3101', relay: request() };
  assert.equal((await manager.browserRequest(event, input)).ok, true); const guest = attached[1];
  const originalState = api.state; let resolveRead!: (value: any) => void; let calls = 0;
  api.state = () => { calls++; return new Promise(resolve => { resolveRead = resolve; }); };
  const pending = manager.browserRequest(event, { ...input, relay: { ...request(), requestId: 'delayed' } });
  const hidden = await manager.browserRequest(event, { managerOrigin: input.managerOrigin, relay: { source: BROWSER_RELAY, requestId: 'hide-now', kind: 'hide', identity } });
  assert.equal(hidden.ok, true); assert.equal(guest.visible, false); assert.equal(calls, 1, 'hide must not read the unavailable Supervisor');
  api.state = originalState; resolveRead(await originalState());
  assert.equal((await pending).ok, false); assert.equal(guest.visible, false, 'old authorization must not re-show the guest');
});
