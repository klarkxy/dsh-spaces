/** Narrow, non-secret presentation protocol; no generic Electron or webview API. */
export const BROWSER_PRESENT = 'dsh-spaces-browser:present';
export const BROWSER_HIDE = 'dsh-spaces-browser:hide';
export const BROWSER_RELAY = 'dsh-spaces-browser:relay';
export const BROWSER_RESULT = 'dsh-spaces-browser:result';
export interface BrowserViewport { x: number; y: number; width: number; height: number }
export interface BrowserIdentity { spaceId: string; generation: number; serviceEpoch: string; origin: string; channel: string }
export type BrowserChildRequest = { source: typeof BROWSER_PRESENT; requestId: string; spaceId: string; generation: number; channel: string; tabId: string; url: string; viewport: BrowserViewport }
  | { source: typeof BROWSER_HIDE; requestId: string; spaceId: string; generation: number; channel: string };
export type BrowserRelay = { source: typeof BROWSER_RELAY; requestId: string; kind: 'present'; identity: BrowserIdentity; tabId: string; url: string; viewport: BrowserViewport }
  | { source: typeof BROWSER_RELAY; requestId: string; kind: 'hide'; identity: BrowserIdentity };
export interface BrowserGuestObservation { tabId: string; url: string; title: string }
export type BrowserGuestResult = { source: typeof BROWSER_RESULT; requestId: string; ok: true; tabId: string; mode: 'native'; observations: BrowserGuestObservation[] }
  | { source: typeof BROWSER_RESULT; requestId: string; ok: false; error: 'unavailable' | 'unauthorized' | 'invalid-input' | 'not-visible' };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export function browserUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.href === value; } catch { return false; }
}
export function browserViewport(value: unknown): value is BrowserViewport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as BrowserViewport;
  return Object.keys(v).length === 4 && [v.x, v.y, v.width, v.height].every(n => Number.isFinite(n) && n >= 0 && n <= 32768) && v.width > 0 && v.height > 0;
}
export function browserIdentity(value: unknown): value is BrowserIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as BrowserIdentity;
  if (Object.keys(v).length !== 5 || !id(v.spaceId) || !id(v.channel) || !Number.isSafeInteger(v.generation) || v.generation < 0 || !/^[a-f0-9]{64}$/.test(v.serviceEpoch)) return false;
  try { const u = new URL(v.origin); return u.origin === v.origin && u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password; } catch { return false; }
}
export function parseBrowserChild(value: unknown): BrowserChildRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as BrowserChildRequest;
  if (!id(v.requestId) || !id(v.spaceId) || !id(v.channel) || !Number.isSafeInteger(v.generation) || v.generation < 0) return null;
  if (v.source === BROWSER_HIDE && Object.keys(v).length === 5) return v;
  if (v.source === BROWSER_PRESENT && Object.keys(v).length === 8 && id(v.tabId) && browserUrl(v.url) && browserViewport(v.viewport)) return v;
  return null;
}
export function clipBrowserViewport(value: BrowserViewport, container: BrowserViewport): BrowserViewport | null {
  if (!browserViewport(value) || !browserViewport(container)) return null;
  const x = Math.max(value.x, container.x), y = Math.max(value.y, container.y);
  const width = Math.min(value.x + value.width, container.x + container.width) - x;
  const height = Math.min(value.y + value.height, container.y + container.height) - y;
  return width >= 1 && height >= 1 ? { x: Math.ceil(x), y: Math.ceil(y), width: Math.floor(width), height: Math.floor(height) } : null;
}

export function boundedBrowserTitle(value: string): string {
  let title = '';
  for (const character of value.replace(/[\u0000-\u001f\u007f]/g, ' ')) {
    if (new TextEncoder().encode(JSON.stringify(title + character)).length > 128) break;
    title += character;
  }
  return title;
}
export function parseBrowserObservations(value: unknown): BrowserGuestObservation[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const ids = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Object.keys(row).length !== 3 || !id(row.tabId) || ids.has(row.tabId) ||
      !browserUrl(row.url) || typeof row.title !== 'string' || boundedBrowserTitle(row.title) !== row.title) return null;
    ids.add(row.tabId);
  }
  return value as BrowserGuestObservation[];
}
