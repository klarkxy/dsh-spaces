import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MAX_SHARE } from '../codec.mjs';
import { registerHostRpc } from '../host-rpc.mjs';

async function host(t, authorize = () => undefined, call = async () => ({ ok: true, value: true })) {
  let route, dispatched = 0;
  const ctx = {
    connection: { requestRejection: authorize },
    webServer: { register(value) { route = value; return () => { route = undefined; }; } },
  };
  const dispose = registerHostRpc(ctx, async (...args) => { dispatched++; return call(...args); });
  const server = createServer((req, res) => route ? void route.handler(req, res) : (res.writeHead(404), res.end()));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { dispose(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { ctx, dispose, get dispatched() { return dispatched; },
    url: `http://127.0.0.1:${server.address().port}/dsh-blueprint/catalog` };
}

function request(url, payload = {}, options = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'catalog', payload }), ...options });
}

test('host route applies Connection authentication and Host/Origin policy before dispatch', async t => {
  for (const rejection of [401, 403]) {
    const h = await host(t, () => rejection);
    assert.equal((await request(h.url)).status, rejection);
    assert.equal(h.dispatched, 0);
  }
  const missing = await host(t);
  delete missing.ctx.connection.requestRejection;
  assert.equal((await request(missing.url)).status, 503);
  assert.equal(missing.dispatched, 0);
});

test('host route accepts native Connection envelope and supports a full share code', async t => {
  const h = await host(t, () => undefined, async (_endpoint, payload) => ({ ok: true, value: payload.text.length }));
  const response = await request(h.url, { text: 'a'.repeat(MAX_SHARE) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'r1', result: { ok: true, value: MAX_SHARE } });
  assert.equal(h.dispatched, 1);
});

test('host route rejects oversized, malformed and mismatched requests before dispatch', async t => {
  const h = await host(t);
  assert.equal((await request(h.url, { text: 'a'.repeat(MAX_SHARE + 65536 + 1024) })).status, 413);
  assert.equal((await request(h.url, {}, { body: '{' })).status, 400);
  assert.equal((await request(h.url, {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request(h.url, {}, { body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'apply', payload: {} }) })).status, 400);
  assert.equal(h.dispatched, 0);
});

test('closing a request aborts its active operation', async t => {
  let called;
  const active = new Promise(resolve => { called = resolve; });
  let aborted;
  const done = new Promise(resolve => { aborted = resolve; });
  const h = await host(t, () => undefined, async (_endpoint, _payload, signal) => {
    called();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted(signal.aborted);
    return { ok: false, error: { code: 'aborted', message: 'cancelled', details: {} } };
  });
  const controller = new AbortController();
  const pending = request(h.url, {}, { signal: controller.signal }).catch(() => undefined);
  await active; controller.abort();
  assert.equal(await done, true);
  await pending;
});
