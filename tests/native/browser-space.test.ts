import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserTabs, parseBrowserUrl } from '../../packages/browser/src/tabs';
import { Context, Service } from '@deepseek-ai/cordis';
import { apply as applyBrowser } from '../../packages/browser/src/index';
import type { SpaceOperation } from '../../packages/view-bridge/src/message-bus';
import { busJson } from '../../src/shared/space-message-bus';
import { mergeTabSnapshots } from '../../packages/browser/src/client';
import { apply as applyBrowserClient } from '../../packages/browser/src/client';
import { BrowserFailurePanel } from '../../packages/browser/src/ui/failure-panel';
import { BrowserTabStrip } from '../../packages/browser/src/ui/tab-strip';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowserRequestFailure, displayBrowserFailure, listTabs } from '../../packages/browser/src/remote-client';

test('Browser preserves a known HTTP authentication failure without replay or raw exception text', async () => {
  let calls = 0;
  const connection = { rpc: { call: async () => {
    calls++;
    throw new Error('transport failure for /api/spacesBrowser/listTabs: HTTP 401');
  } } };
  await assert.rejects(listTabs(connection as never), error => {
    assert(error instanceof BrowserRequestFailure);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'browser/unauthenticated');
    assert.match(displayBrowserFailure(error, 'Browser tabs are unavailable.'), /HTTP 401/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(displayBrowserFailure(new Error('secret=private-value https://private.example'),
    'Browser tabs are unavailable.'), 'Browser tabs are unavailable.');
});

test('Browser keeps known Remote codes and distinguishes malformed data without exposing remote details', async () => {
  for (const [result, phase, code] of [
    [{ ok: false, error: { code: 'gateway/cancelled', message: 'secret=private-value', details: {} } }, 'remote', 'gateway/cancelled'],
    [{ ok: false, error: { code: 'private-secret-code', message: 'secret=private-value', details: {} } }, 'remote', 'browser/remote-failed'],
    [{ ok: true, value: [{ id: 'x' }] }, 'decode', 'browser/response-invalid'],
  ] as const) {
    let calls = 0;
    await assert.rejects(listTabs({ rpc: { call: async () => { calls++; return result; } } } as never), error => {
      assert(error instanceof BrowserRequestFailure);
      assert.equal(error.phase, phase);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /private-value|private-secret/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('official DSH root slot elects Browser-only UI ahead of the Web layout', () => {
  const slots = new SlotCore();
  slots.register({ name: 'root' }, () => createElement('div', { 'data-dsh-layout': true }));
  applyBrowserClient({
    get: () => ({ rpc: { call: async () => ({ ok: true, value: [] }) } }),
    slots: { inject: (_name: string, register: () => void) => register(), register: slots.register.bind(slots),
      installScope: (_name: string, adapter: { current: { getSnapshot(): { key?: string } } }) => assert.equal(adapter.current.getSnapshot().key, undefined) },
  } as never);
  const winner = slots.entriesOfSlot('root')[0];
  assert.equal(winner?.options.priority, -2);
  const html = renderToStaticMarkup(createElement(winner!.component as never, { renderSlot: () => null } as never));
  assert.match(html, /data-spaces-browser-root="true"/);
  assert.doesNotMatch(html, /data-dsh-layout/);
});

test('a delayed pre-open UI snapshot cannot remove the newly opened tab', () => {
  const tabs = new BrowserTabs();
  const oldSnapshot = tabs.listTabs();
  const opened = tabs.openURL('https://example.com/');
  const merged = mergeTabSnapshots([...oldSnapshot, opened], oldSnapshot);
  assert.deepEqual(merged.map(tab => tab.id), [oldSnapshot[0]!.id, opened.id]);
  assert.equal(merged[1]?.requestedUrl, 'https://example.com/');
});
test('a navigation failure is announced at once, keeps the remote wording and offers no retry', () => {
  const message = displayBrowserFailure(new BrowserRequestFailure('listTabs', 'http', 'browser/unauthenticated', 401), 'Browser tabs are unavailable.');
  const html = renderToStaticMarkup(createElement(BrowserFailurePanel, { message }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Browser tabs are unavailable\./);
  assert.match(html, /HTTP 401/);
  assert.doesNotMatch(html, /opacity:0/, 'a failure must not start hidden behind an entrance');
  assert.doesNotMatch(html, /retry|重试/i, 'a failure must not offer a retry');
});
test('the tab strip marks the active tab and keeps every tab title', () => {
  const tabs = [
    { id: 'a', requestedUrl: null, url: null, title: 'Home' },
    { id: 'b', requestedUrl: 'https://example.com/', url: 'https://example.com/', title: 'Example' },
  ];
  const html = renderToStaticMarkup(createElement(BrowserTabStrip, { tabs, selected: 'b', onSelect: () => {} }));
  assert.match(html, /aria-label="Browser tabs"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /Example/);
  assert.match(html, /Home/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
});

test('Browser starts with one blank home and opens separate tabs', () => {
  const tabs = new BrowserTabs();
  const home = tabs.listTabs();
  assert.equal(home.length, 1);
  assert.equal(home[0]?.url, null);
  const opened = tabs.openURL('example.com/path');
  assert.equal(opened.url, 'https://example.com/path');
  assert.equal(opened.requestedUrl, opened.url);
  assert.notEqual(opened.id, home[0]?.id);
  assert.deepEqual(tabs.listTabs().map(tab => tab.url), [null, 'https://example.com/path']);
  home[0] = { id: 'forged', requestedUrl: 'https://evil.example/', url: 'https://evil.example/', title: 'forged' };
  assert.notEqual(tabs.listTabs()[0]?.id, 'forged');
});

test('native observations update live URL/title without mutating the requested load address', () => {
  const tabs = new BrowserTabs(new Set(['4100']));
  const one = tabs.openURL('https://example.com/');
  const two = tabs.openURL('https://example.org/');
  const observed = tabs.observe([{ tabId: one.id, url: 'https://example.com/redirected', title: 'Redirected' }]);
  assert.equal(observed[1]?.requestedUrl, 'https://example.com/');
  assert.equal(observed[1]?.url, 'https://example.com/redirected');
  assert.equal(observed[1]?.title, 'Redirected');
  for (const bad of [
    [{ tabId: two.id, url: 'file:///etc/passwd', title: 'bad' }],
    [{ tabId: two.id, url: 'http://127.0.0.1:4100/', title: 'bad' }],
    [{ tabId: 'unknown', url: 'https://example.com/', title: 'bad' }],
    [{ tabId: two.id, url: 'https://example.com/', title: 'x'.repeat(129) }],
  ]) assert.throws(() => tabs.observe(bad));
  assert.equal(tabs.listTabs()[2]?.url, 'https://example.org/');
});

test('Browser URL policy rejects non-web schemes, credentials and application origins', () => {
  const blocked = new Set(['3080', '4567']);
  for (const value of [
    '', ' https://example.com', 'http://user:pass@example.com', 'file:///etc/passwd',
    'javascript:alert(1)', 'data:text/html,hi', 'http://127.0.0.1:3080/',
    'https://localhost:4567/', 'http://[::1]:3080/', '\u0000https://example.com',
  ]) assert.throws(() => parseBrowserUrl(value, blocked));
  assert.equal(parseBrowserUrl('http://127.0.0.1:8080/', blocked), 'http://127.0.0.1:8080/');
  assert.equal(parseBrowserUrl('https://example.com/a', blocked), 'https://example.com/a');
});

test('Browser bounds tab count', () => {
  const tabs = new BrowserTabs();
  for (let i = 1; i < 16; i++) tabs.openURL(`https://example.com/${i}`);
  assert.equal(tabs.listTabs().length, 16);
  assert.throws(() => tabs.openURL('https://example.com/overflow'));
});

test('maximal Browser tabs and native observations fit one private bus response', () => {
  const tabs = new BrowserTabs();
  const prefix = 'https://example.com/';
  const url = prefix + 'a'.repeat(2048 - prefix.length);
  const opened = Array.from({ length: 15 }, () => tabs.openURL(url));
  tabs.observe(opened.map(tab => ({ tabId: tab.id, url, title: 'T'.repeat(126) })));
  assert.equal(tabs.listTabs().length, 16);
  assert.doesNotThrow(() => busJson(tabs.listTabs().map(tab => ({ id: tab.id, requestedUrl: tab.requestedUrl, url: tab.url, title: tab.title }))));
});

test('Browser Host registers only exact-source operations and denies all by default', async () => {
  class Messages extends Service {
    readonly operations = new Map<string, { allowed: readonly string[]; handler: SpaceOperation; description: string }>();
    constructor(ctx: Context) { super(ctx, 'spaceMessages'); }
    handle(operation: string, allowed: readonly string[], handler: SpaceOperation, declaration: { description: string }): () => void {
      this.operations.set(operation, { allowed, handler, description: declaration.description });
      return () => { this.operations.delete(operation); };
    }
  }
  const ctx = new Context();
  await ctx.plugin({ name: 'server-fixture', apply: plugin => { class Server extends Service { port = 3200; constructor() { super(plugin, 'webServer'); } } new Server(); } });
  await ctx.plugin({ name: 'messages-fixture', apply: plugin => { new Messages(plugin); } });
  try {
    const empty = ctx.spaceMessages as unknown as Messages;
    await ctx.plugin({ name: 'browser-empty-fixture', inject: ['spaceMessages'], apply: plugin => { applyBrowser(plugin); } });
    assert.deepEqual(empty.operations.get('browser.openURL')?.allowed, []);
    assert.deepEqual(empty.operations.get('browser.listTabs')?.allowed, []);
    const opened = empty.operations.get('browser.openURL')!.handler({ url: 'https://example.com' }, { spaceId: 'coding' });
    assert.equal((opened as { url: string }).url, 'https://example.com/');
    assert.equal((empty.operations.get('browser.listTabs')!.handler(null, { spaceId: 'coding' }) as unknown[]).length, 2);
    assert.throws(() => empty.operations.get('browser.openURL')!.handler({ url: 'file:///etc/passwd' }, { spaceId: 'coding' }));
  } finally { await ctx.fiber.dispose(); }
});
