import { randomUUID } from 'node:crypto';
import { session, WebContentsView, type BrowserWindow, type Session } from 'electron';
import { BROWSER_RESULT, browserUrl, browserNavigationAllowed, boundedBrowserTitle, clipBrowserViewport, type BrowserRelay, type BrowserGuestResult, type BrowserViewport, type BrowserIdentity } from '../shared/browser-guest';
import { TITLEBAR_HEIGHT } from '../shared/layout';

type Tab = { view: WebContentsView; requestedUrl: string; failed: boolean };
/** Guests never receive preload, IPC, Node, workbench cookies, downloads or permissions. */
export class BrowserGuests {
  private readonly tabs = new Map<string, Tab>();
  private owner = '';
  private active: Tab | null = null;
  private bounds: BrowserViewport | null = null;
  private lease: ReturnType<typeof setTimeout> | null = null;
  private partition = '';
  private ownedSession: Session | null = null;
  private protectedOrigins: readonly string[] = [];
  constructor(private readonly window: BrowserWindow) {}
  present(request: Extract<BrowserRelay, { kind: 'present' }>, protectedOrigins: readonly string[] = [request.identity.origin]): BrowserGuestResult {
    const owner = `${request.identity.serviceEpoch}:${request.identity.spaceId}:${request.identity.generation}:${request.identity.channel}`;
    if (owner !== this.owner) { this.clear(); this.owner = owner; this.partition = `dsh-browser-${randomUUID()}`; }
    this.protectedOrigins = [...protectedOrigins];
    if (!browserNavigationAllowed(request.url, this.protectedOrigins)) throw new Error('invalid-input');
    const content = this.window.getContentBounds();
    const bounds = clipBrowserViewport({ ...request.viewport, y: request.viewport.y + TITLEBAR_HEIGHT },
      { x: 0, y: TITLEBAR_HEIGHT, width: content.width, height: Math.max(0, content.height - TITLEBAR_HEIGHT) });
    if (!bounds) throw new Error('invalid-input');
    let tab = this.tabs.get(request.tabId);
    if (!tab) {
      if (this.tabs.size >= 16) throw new Error('unavailable');
      const target = this.ownedSession ??= session.fromPartition(this.partition);
      target.setPermissionRequestHandler((_c, _p, cb) => cb(false)); target.setPermissionCheckHandler(() => false); target.setDevicePermissionHandler(() => false);
      if (this.tabs.size === 0) target.on('will-download', event => event.preventDefault());
      const view = new WebContentsView({ webPreferences: { session: target, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, webviewTag: false, navigateOnDragDrop: false } });
      tab = { view, requestedUrl: '', failed: false };
      this.tabs.set(request.tabId, tab); this.window.contentView.addChildView(view);
      const current = tab;
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', (event, url) => { if (!browserNavigationAllowed(url, this.protectedOrigins)) event.preventDefault(); });
      view.webContents.on('will-redirect', (event, url) => { if (!browserNavigationAllowed(url, this.protectedOrigins)) event.preventDefault(); });
      view.webContents.on('will-frame-navigate', event => { if (!browserNavigationAllowed(event.url, this.protectedOrigins)) event.preventDefault(); });
      view.webContents.on('will-attach-webview', event => event.preventDefault());
      view.webContents.on('render-process-gone', () => { current.failed = true; view.setVisible(false); });
      view.webContents.on('did-fail-load', (_event, code, _desc, _url, main) => { if (main && code !== -3) { current.failed = true; view.setVisible(false); } });
    }
    if (tab.failed || tab.view.webContents.isDestroyed()) throw new Error('unavailable');
    for (const other of this.tabs.values()) other.view.setVisible(other === tab);
    this.active = tab; this.bounds = bounds; tab.view.setBounds(bounds);
    if (tab.requestedUrl !== request.url) {
      tab.requestedUrl = request.url;
      const current = tab;
      void tab.view.webContents.loadURL(request.url).catch(() => { current.failed = true; if (!current.view.webContents.isDestroyed()) current.view.setVisible(false); });
    }
    if (this.lease) clearTimeout(this.lease);
    this.lease = setTimeout(() => this.clear(), 2500);
    const observations = [...this.tabs.entries()].flatMap(([tabId, item]) => {
      if (item.failed || item.view.webContents.isDestroyed()) return [];
      const url = item.view.webContents.getURL();
      if (!browserNavigationAllowed(url, this.protectedOrigins)) return [];
      return [{ tabId, url, title: boundedBrowserTitle(item.view.webContents.getTitle()) }];
    });
    return { source: BROWSER_RESULT, requestId: request.requestId, ok: true, tabId: request.tabId, mode: 'native', observations };
  }
  resize(): void {
    if (!this.active || !this.bounds) return;
    const content = this.window.getContentBounds();
    const clipped = clipBrowserViewport(this.bounds, { x: 0, y: TITLEBAR_HEIGHT, width: content.width, height: Math.max(0, content.height - TITLEBAR_HEIGHT) });
    if (!clipped) { this.clear(); return; }
    this.active.view.setBounds(clipped);
  }
  hide(identity: BrowserIdentity): void {
    if (this.owner !== `${identity.serviceEpoch}:${identity.spaceId}:${identity.generation}:${identity.channel}`) return;
    for (const tab of this.tabs.values()) tab.view.setVisible(false);
    this.active = null; this.bounds = null; // keep healthy tabs until the presentation lease expires
  }
  clear(): void {
    if (this.lease) clearTimeout(this.lease); this.lease = null;
    for (const tab of this.tabs.values()) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear(); this.owner = ''; this.active = null; this.bounds = null;
    const retiredSession = this.ownedSession; this.ownedSession = null;
    if (retiredSession) void Promise.all([retiredSession.clearStorageData(), retiredSession.closeAllConnections()])
      .catch(() => console.error('Browser guest session cleanup failed.'));
  }
}
