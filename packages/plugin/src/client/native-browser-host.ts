import { BROWSER_RESULT, boundedBrowserTitle, browserUrl, clipBrowserViewport,
  type BrowserGuestObservation, type BrowserGuestResult, type BrowserIdentity, type BrowserRelay } from '../../../../src/shared/browser-guest';
import type { DesktopBrowserBridge } from './ui/native-controller';

interface BrowserGuest extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
}
interface TabGuest { element?: BrowserGuest; lease?: string; requestedUrl: string; failed: boolean; ready: Promise<void> }
interface Group { identity: BrowserIdentity; workspace: string; tabs: Map<string, TabGuest> }
const identityKey = (v: BrowserIdentity) => JSON.stringify([v.serviceEpoch, v.spaceId, v.generation, v.channel, v.origin]);
const sameIdentity = (a: BrowserIdentity, b: BrowserIdentity) => identityKey(a) === identityKey(b);

/** Official Desktop owns isolation and permissions; this presenter owns only bounded tab leases. */
export class NativeBrowserHost {
  private group?: Group;
  private expiry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private revision = 0;
  private failures = new Set<string>();
  constructor(private bridge: DesktopBrowserBridge, private container: HTMLElement) {}

  async present(request: Extract<BrowserRelay, { kind: 'present' }>): Promise<BrowserGuestResult> {
    const unavailable = (): BrowserGuestResult => ({ source: BROWSER_RESULT, requestId: request.requestId, ok: false, error: 'unavailable' });
    if (this.stopped) return unavailable();
    if (this.failures.has(identityKey(request.identity) + ':' + request.tabId) || this.failures.size >= 1024) {
      this.hide(); return unavailable();
    }
    if (this.group && !sameIdentity(this.group.identity, request.identity)) this.retire();
    const group = this.group ??= { identity: request.identity,
      workspace: 'dsh-spaces-browser:' + request.identity.serviceEpoch + ':' + request.identity.spaceId + ':' + crypto.randomUUID(), tabs: new Map() };
    const revision = ++this.revision;
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.retire(), 2500);
    let row = group.tabs.get(request.tabId);
    if (!row) {
      if (group.tabs.size >= 16) return unavailable();
      row = { requestedUrl: request.url, failed: false, ready: Promise.resolve() };
      group.tabs.set(request.tabId, row);
      row.ready = this.create(group, row, request.tabId);
    }
    // A tab's opening address is immutable. Page navigation is observed, never replayed.
    if (row.requestedUrl !== request.url || row.failed) return unavailable();
    for (const tab of group.tabs.values()) if (tab.element && tab !== row) tab.element.hidden = true;
    try { await row.ready; } catch { return unavailable(); }
    if (this.stopped || this.group !== group || revision !== this.revision || row.failed || !row.element) return unavailable();
    const rect = this.container.getBoundingClientRect();
    const viewport = clipBrowserViewport(request.viewport, { x: 0, y: 0, width: rect.width, height: rect.height });
    if (!viewport || this.container.hidden) { this.hide(); return { source: BROWSER_RESULT, requestId: request.requestId, ok: false, error: 'not-visible' }; }
    for (const tab of group.tabs.values()) if (tab.element) tab.element.hidden = tab !== row;
    Object.assign(row.element.style, { left: viewport.x + 'px', top: viewport.y + 'px', width: viewport.width + 'px', height: viewport.height + 'px' });
    row.element.hidden = false;
    const observations: BrowserGuestObservation[] = [];
    for (const [tabId, tab] of group.tabs) if (tab.element && !tab.failed) {
      const url = tab.element.getURL();
      if (browserUrl(url)) observations.push({ tabId, url, title: boundedBrowserTitle(tab.element.getTitle()) });
    }
    return { source: BROWSER_RESULT, requestId: request.requestId, ok: true, mode: 'native', tabId: request.tabId, observations };
  }

  private async create(group: Group, row: TabGuest, tabId: string) {
    try {
      const reservation = await this.bridge.acquire(group.workspace);
      if (this.stopped || this.group !== group) { await this.bridge.release(reservation.lease); return; }
      row.lease = reservation.lease;
      const element = document.createElement('webview') as BrowserGuest;
      row.element = element;
      element.className = 'dsh-native-browser-tab';
      element.hidden = true;
      element.setAttribute('data-browser-tab', tabId);
      element.setAttribute('aria-label', 'Browser page');
      element.setAttribute('partition', reservation.partition);
      element.setAttribute('name', reservation.lease);
      element.setAttribute('src', 'about:blank#' + reservation.lease);
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Browser attachment deadline')), 1800);
        element.addEventListener('dom-ready', () => { clearTimeout(timeout); resolve(); }, { once: true });
      });
      element.addEventListener('did-fail-load', event => {
        const failure = event as Event & { isMainFrame?: boolean; errorCode?: number };
        if (failure.isMainFrame !== false && failure.errorCode !== -3) this.fail(group, row, tabId);
      });
      element.addEventListener('render-process-gone', () => this.fail(group, row, tabId));
      this.container.append(element);
      await ready;
      if (this.stopped || this.group !== group || row.failed) return;
      void element.loadURL(row.requestedUrl).catch((error: unknown) => {
        if ((error as { code?: string })?.code !== 'ERR_ABORTED' && this.group === group) this.fail(group, row, tabId);
      });
    } catch {
      if (this.stopped || this.group !== group) return;
      this.fail(group, row, tabId);
      throw Error('Browser guest unavailable');
    }
  }

  hide(identity?: BrowserIdentity) {
    if (identity && this.group && !sameIdentity(identity, this.group.identity)) return;
    this.revision++;
    for (const row of this.group?.tabs.values() ?? []) if (row.element) row.element.hidden = true;
  }
  private fail(group: Group, row: TabGuest, tabId: string) {
    row.failed = true; this.failures.add(identityKey(group.identity) + ':' + tabId); this.release(row);
  }
  private release(row: TabGuest) {
    row.element?.remove(); row.element = undefined;
    const lease = row.lease; row.lease = undefined;
    if (lease) void this.bridge.release(lease).catch(() => console.error('Spaces Browser lease release failed.'));
  }
  private retire() {
    clearTimeout(this.expiry); this.revision++;
    const group = this.group; this.group = undefined;
    for (const row of group?.tabs.values() ?? []) this.release(row);
  }
  stop() { this.stopped = true; this.retire(); }
}
