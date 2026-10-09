import { randomUUID } from 'node:crypto';

export interface BrowserTab {
  readonly id: string;
  /** The immutable address that created this tab; native present never uses live navigation as a load command. */
  readonly requestedUrl: string | null;
  /** Last native-observed page address, or the requested address before an observation. */
  readonly url: string | null;
  readonly title: string;
}

export interface BrowserObservation { readonly tabId: string; readonly url: string; readonly title: string }

/** Process-local Browser Space state. One blank home tab exists at launch. */
export class BrowserTabs {
  private readonly tabs: BrowserTab[] = [{ id: randomUUID(), requestedUrl: null, url: null, title: '' }];

  constructor(private readonly applicationPorts: ReadonlySet<string> | (() => ReadonlySet<string>) = new Set()) {}

  listTabs(): BrowserTab[] {
    return this.tabs.map(tab => ({ ...tab }));
  }

  openURL(raw: unknown): BrowserTab {
    const url = parseBrowserUrl(raw, typeof this.applicationPorts === 'function' ? this.applicationPorts() : this.applicationPorts);
    if (this.tabs.length >= 16) throw new Error('Browser tab limit reached');
    const tab = { id: randomUUID(), requestedUrl: url, url, title: '' };
    this.tabs.push(tab);
    return { ...tab };
  }

  /** Accept only known tab IDs and bounded URL/title observations from the native presentation bridge. */
  observe(raw: unknown): BrowserTab[] {
    if (!Array.isArray(raw) || raw.length > 16) throw new Error('Invalid Browser observations');
    const next = [...this.tabs];
    const seen = new Set<string>();
    for (const value of raw) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Browser observation');
      const row = value as Record<string, unknown>;
      if (Object.keys(row).length !== 3 || typeof row.tabId !== 'string' || seen.has(row.tabId) ||
        typeof row.url !== 'string' || row.url.length > 2048 || typeof row.title !== 'string' ||
        new TextEncoder().encode(JSON.stringify(row.title)).length > 128) throw new Error('Invalid Browser observation');
      seen.add(row.tabId);
      const index = next.findIndex(tab => tab.id === row.tabId && tab.requestedUrl !== null);
      if (index < 0 || parseBrowserUrl(row.url, typeof this.applicationPorts === 'function' ? this.applicationPorts() : this.applicationPorts) !== row.url) {
        throw new Error('Invalid Browser observation');
      }
      next[index] = { ...next[index]!, url: row.url, title: row.title };
    }
    this.tabs.splice(0, this.tabs.length, ...next);
    return this.listTabs();
  }
}

/** Match the official Browser's HTTP(S)-only, credential-free address boundary. */
export function parseBrowserUrl(raw: unknown, applicationPorts: ReadonlySet<string> = new Set()): string {
  if (typeof raw !== 'string' || !raw || raw.length > 2048 || raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('Invalid Browser URL');
  }
  // The official address bar accepts a host without a scheme as HTTPS.
  const value = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Invalid Browser URL'); }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password ||
    parsed.href.length > 2048 ||
    (applicationPorts.has(parsed.port) && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error('Browser URL is not allowed');
  }
  return parsed.href;
}
