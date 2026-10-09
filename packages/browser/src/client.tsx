import React, { createElement, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { readViewHint } from '../../view-bridge/src/env';
import { BROWSER_HIDE, BROWSER_PRESENT, BROWSER_RESULT, type BrowserChildRequest, type BrowserGuestResult } from '../../../src/shared/browser-guest';

interface Tab { id: string; requestedUrl: string | null; url: string | null; title: string }
type BrowserConnection = Pick<ConnectionHandle, 'rpc'>;

/** Tabs are append-only for this process; an older RPC snapshot must not unmount a newer tab. */
export function mergeTabSnapshots(previous: readonly Tab[], incoming: readonly Tab[]): Tab[] {
  const byId = new Map(previous.map(tab => [tab.id, tab]));
  for (const tab of incoming) byId.set(tab.id, tab);
  return [...byId.values()];
}

export const inject = ['slots', 'connection'];

/** Browser Space has its own root. It does not embed the DSH chat application. */
export function apply(ctx: Context): void {
  const connection: BrowserConnection = ctx.get('connection');
  ctx.slots.inject('root', () => ctx.slots.register({ name: 'root', priority: -2 },
    () => createElement(BrowserApp, { connection })));
}

export function BrowserApp({ connection }: { connection: BrowserConnection }): ReactElement {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  const seenCount = useRef(0);
  const localVersion = useRef(0);
  const nativeDesktop = typeof window !== 'undefined' && window.parent !== window && /Electron\//.test(navigator.userAgent);
  const view = nativeDesktop ? readViewHint() : null;
  const active = tabs.find(tab => tab.id === selected);

  useEffect(() => {
    if (!nativeDesktop || !view || !active?.requestedUrl) return;
    const pageUrl = active.requestedUrl;
    let disposed = false;
    let pending = false;
    let stopped = false;
    const present = async (): Promise<void> => {
      if (disposed || pending || stopped || !pageRef.current) return;
      const rect = pageRef.current.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      pending = true;
      try {
        const result = await postBrowserRequest({ source: BROWSER_PRESENT, requestId: crypto.randomUUID(),
          spaceId: view.spaceId, generation: view.generation, channel: view.channel,
          tabId: active.id, url: pageUrl,
          viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }, view.parentOrigin);
        if (disposed) return;
        if (result && !result.ok && result.error === 'not-visible') return;
        if (!result?.ok || result.tabId !== active.id) { stopped = true; setError('Native Browser is unavailable.'); return; }
        const next = await observe(connection, result.observations);
        if (!disposed) { localVersion.current++; setTabs(previous => mergeTabSnapshots(previous, next)); setError(null); }
      } catch { if (!disposed) { stopped = true; setError('Native Browser navigation is unavailable.'); } }
      finally { pending = false; }
    };
    void present();
    const timer = window.setInterval(() => { void present(); }, 750);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [connection, nativeDesktop, view?.spaceId, view?.generation, view?.channel, view?.parentOrigin, active?.id, active?.requestedUrl]);

  useEffect(() => {
    if (!nativeDesktop || !view || active?.requestedUrl) return;
    void postBrowserRequest({ source: BROWSER_HIDE, requestId: crypto.randomUUID(),
      spaceId: view.spaceId, generation: view.generation, channel: view.channel }, view.parentOrigin);
  }, [nativeDesktop, view?.spaceId, view?.generation, view?.channel, view?.parentOrigin, active?.requestedUrl]);

  useEffect(() => {
    if (!nativeDesktop || !view) return;
    return () => {
      void postBrowserRequest({ source: BROWSER_HIDE, requestId: crypto.randomUUID(),
        spaceId: view.spaceId, generation: view.generation, channel: view.channel }, view.parentOrigin);
    };
  }, [nativeDesktop, view?.spaceId, view?.generation, view?.channel, view?.parentOrigin]);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let failed = false;
    const load = async (): Promise<void> => {
      if (pending || failed) return;
      pending = true;
      const version = localVersion.current;
      try {
        const next = await listTabs(connection);
        if (disposed || localVersion.current !== version) return;
        setTabs(previous => mergeTabSnapshots(previous, next));
        const arrived = seenCount.current > 0 && next.length > seenCount.current;
        seenCount.current = Math.max(seenCount.current, next.length);
        setSelected(previous => arrived ? next.at(-1)?.id ?? null : previous ?? next[0]?.id ?? null);
      } catch {
        if (!disposed) { failed = true; setError('Browser tabs are unavailable.'); }
      } finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [connection]);

  const open = async (value: string): Promise<void> => {
    try {
      const tab = await openURL(connection, value);
      localVersion.current++;
      setTabs(previous => mergeTabSnapshots(previous, [tab]));
      setSelected(tab.id);
      setDraft(''); setError(null);
    } catch { setError('That URL could not be opened.'); }
  };
  return <div style={appStyle} data-spaces-browser-root="true">
    <nav aria-label="Browser tabs" style={tabsStyle}>
      {tabs.map(tab => <button type="button" key={tab.id} onClick={() => setSelected(tab.id)}
        aria-current={tab.id === selected ? 'page' : undefined} style={tabStyle(tab.id === selected)}>
        {tab.title || (tab.url ? new URL(tab.url).hostname : 'Home')}
      </button>)}
    </nav>
    <form style={addressStyle} onSubmit={event => { event.preventDefault(); void open(draft); }}>
      <input aria-label="Address" value={draft} onChange={event => setDraft(event.currentTarget.value)}
        placeholder={active?.url ?? 'Enter a website address'} style={inputStyle} />
      <button type="submit">Open new tab</button>
      {active?.url && <a href={active.url} target="_blank" rel="noopener noreferrer">Open externally</a>}
      {!nativeDesktop && active?.requestedUrl && <span style={hintStyle}>Web preview: this address may not track links or redirects.</span>}
    </form>
    {error && <p role="alert" style={errorStyle}>{error}</p>}
    <main ref={pageRef} style={pageStyle}>
      {!nativeDesktop && tabs.map(tab => tab.requestedUrl && <iframe key={tab.id} title={tab.title || tab.url || tab.requestedUrl} src={tab.requestedUrl}
        hidden={tab.id !== selected} style={frameStyle} referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox" />)}
      {nativeDesktop && active?.requestedUrl && <div style={homeStyle}>Opening native Browser page…</div>}
      {!active?.requestedUrl && <div style={homeStyle}>Enter an address to open a Browser tab.</div>}
    </main>
  </div>;
}

function postBrowserRequest(request: BrowserChildRequest, parentOrigin: string): Promise<BrowserGuestResult | null> {
  return new Promise(resolve => {
    const timer = window.setTimeout(() => { finish(null); }, 5000);
    const receive = (event: MessageEvent): void => {
      if (event.source !== window.parent || event.origin !== parentOrigin) return;
      const value = event.data as Partial<BrowserGuestResult> | undefined;
      if (!value || value.source !== BROWSER_RESULT || value.requestId !== request.requestId || typeof value.ok !== 'boolean') return;
      finish(value as BrowserGuestResult);
    };
    const finish = (result: BrowserGuestResult | null): void => {
      window.clearTimeout(timer); window.removeEventListener('message', receive); resolve(result);
    };
    window.addEventListener('message', receive);
    window.parent.postMessage(request, parentOrigin);
  });
}

async function call(connection: BrowserConnection, method: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await connection.rpc.call('/api', `spacesBrowser/${method}`, { args });
  if (!result.ok) throw new Error('Browser request failed');
  return result.value;
}

function parseTab(value: unknown): Tab {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Browser tab');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || (row.requestedUrl !== null && typeof row.requestedUrl !== 'string') ||
    (row.url !== null && typeof row.url !== 'string') || typeof row.title !== 'string') throw new Error('Invalid Browser tab');
  return { id: row.id, requestedUrl: row.requestedUrl, url: row.url, title: row.title } as Tab;
}

async function listTabs(connection: BrowserConnection): Promise<Tab[]> {
  const value = await call(connection, 'listTabs', {});
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid Browser tabs');
  return value.map(parseTab);
}

async function openURL(connection: BrowserConnection, url: string): Promise<Tab> {
  return parseTab(await call(connection, 'openURL', { url }));
}

async function observe(connection: BrowserConnection, observations: unknown): Promise<Tab[]> {
  if (!Array.isArray(observations) || observations.length > 16) throw new Error('Invalid Browser observations');
  const value = await call(connection, 'observe', { observations });
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid Browser tabs');
  return value.map(parseTab);
}

const appStyle: CSSProperties = { display: 'flex', flexDirection: 'column', height: '100vh', width: '100%', background: '#f6f7f9', color: '#20242a', font: '14px system-ui,sans-serif' };
const tabsStyle: CSSProperties = { display: 'flex', gap: 4, padding: '8px 10px 0', overflowX: 'auto', flexShrink: 0 };
const tabStyle = (active: boolean): CSSProperties => ({ border: '1px solid #d9dce2', background: active ? '#fff' : '#e9ebef', borderBottom: 0, borderRadius: '8px 8px 0 0', padding: '8px 12px', whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' });
const addressStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: 10, background: '#fff', borderBottom: '1px solid #d9dce2', flexShrink: 0 };
const inputStyle: CSSProperties = { flex: 1, minWidth: 0, padding: '8px 10px' };
const errorStyle: CSSProperties = { color: '#a00', margin: '6px 10px' };
const hintStyle: CSSProperties = { color: '#5f6874', fontSize: 12, maxWidth: 210 };
const pageStyle: CSSProperties = { position: 'relative', flex: 1, minHeight: 0 };
const frameStyle: CSSProperties = { border: 0, width: '100%', height: '100%', background: '#fff' };
const homeStyle: CSSProperties = { padding: 32, textAlign: 'center' };
