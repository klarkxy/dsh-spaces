import React, { createElement, useEffect, useRef, useState, type ReactElement } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { readViewHint } from '../../view-bridge/src/env';
import { BROWSER_HIDE, BROWSER_PRESENT, BROWSER_RESULT, type BrowserChildRequest, type BrowserGuestResult } from '../../../src/shared/browser-guest';
import { MotionRoot } from '../../../src/shared/ui/motion.js';
import { displayBrowserFailure, listTabs, openURL, observe, type Tab } from './remote-client';
import { BrowserAddressBar } from './ui/address-bar.js';
import { BrowserFailurePanel } from './ui/failure-panel.js';
import { BrowserTabStrip } from './ui/tab-strip.js';
import { BROWSER_CSS } from './ui/styles.js';
import { noSessionScope } from './ui/no-session-scope.js';

type BrowserConnection = Pick<ConnectionHandle, 'rpc'>;

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'browser.toolbar': { kind: 'list'; scope: 'root' };
    'browser.overlay': { kind: 'list'; scope: 'root' };
  }
}

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
  ctx.slots.installScope('session', noSessionScope);
  ctx.slots.inject('root', () => ctx.slots.register({ name: 'root', priority: -2, children: {
    'browser.toolbar': { kind: 'list', scope: 'root' },
    'browser.overlay': { kind: 'list', scope: 'root' },
  } }, ({ renderSlot }) => createElement(BrowserApp, { connection,
    toolbar: renderSlot('browser.toolbar', {}), overlay: renderSlot('browser.overlay', {}) })));
}

export function BrowserApp({ connection, toolbar, overlay }: { connection: BrowserConnection; toolbar?: React.ReactNode; overlay?: React.ReactNode }): ReactElement {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [booting, setBooting] = useState(true);
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
    let inFlight = false;
    let stopped = false;
    const present = async (): Promise<void> => {
      if (disposed || inFlight || stopped || !pageRef.current) return;
      const rect = pageRef.current.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      inFlight = true;
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
      finally { inFlight = false; }
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
    let inFlight = false;
    let failed = false;
    const load = async (): Promise<void> => {
      if (inFlight || failed) return;
      inFlight = true;
      const version = localVersion.current;
      try {
        const next = await listTabs(connection);
        if (disposed || localVersion.current !== version) return;
        setTabs(previous => mergeTabSnapshots(previous, next));
        const arrived = seenCount.current > 0 && next.length > seenCount.current;
        seenCount.current = Math.max(seenCount.current, next.length);
        setSelected(previous => arrived ? next.at(-1)?.id ?? null : previous ?? next[0]?.id ?? null);
      } catch (error) {
        if (!disposed) { failed = true; setError(displayBrowserFailure(error, 'Browser tabs are unavailable.')); }
      } finally { inFlight = false; setBooting(false); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [connection]);

  const open = async (value: string): Promise<void> => {
    setPending(true);
    try {
      const tab = await openURL(connection, value);
      localVersion.current++;
      setTabs(previous => mergeTabSnapshots(previous, [tab]));
      setSelected(tab.id);
      setDraft(''); setError(null);
    } catch (error) { setError(displayBrowserFailure(error, 'That URL could not be opened.')); }
    finally { setPending(false); }
  };
  return <MotionRoot>
    <div className="dsh-spaces-browser dsh-ui" data-spaces-browser-root="true">
      <style>{BROWSER_CSS}</style>
      <BrowserTabStrip tabs={tabs} selected={selected} onSelect={setSelected} />
      <BrowserAddressBar value={draft} placeholder={active?.url ?? 'Enter a website address'}
        externalUrl={active?.url ?? null} pending={pending || booting}
        onChange={setDraft} onSubmit={() => { void open(draft); }} />
      {toolbar}
      {!nativeDesktop && active?.requestedUrl && <p role="note" className="dsh-browser-hint">If a site refuses embedding, use Open externally.</p>}
      {error && <BrowserFailurePanel message={error} />}
      <main ref={pageRef} className="dsh-browser-page">
        {!nativeDesktop && tabs.map(tab => tab.requestedUrl && <iframe key={tab.id} title={tab.title || tab.url || tab.requestedUrl} src={tab.requestedUrl}
          hidden={tab.id !== selected} className="dsh-browser-frame" referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox" />)}
        {nativeDesktop && active?.requestedUrl && !error && <div className="dsh-browser-home">Opening native Browser page…</div>}
        {!active?.requestedUrl && <div className="dsh-browser-home">Enter an address to open a Browser tab.</div>}
      </main>
      {overlay}
    </div>
  </MotionRoot>;
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
