import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as nodeRequest } from 'node:http';
import { dashboardHttpHandler, QUERY_PATH, COMMAND_PATH, BODY_DRAIN_CAP } from '../packages/dashboard/src/host/http.ts';
import { DASHBOARD_LIMITS } from '../src/core/domain/dashboard/limits.ts';
import { createDashboardHttpBackend } from '../packages/dashboard/src/http-client.ts';
import { LocalDashboard, type LocalDashboardDocument } from '../src/core/domain/dashboard/local-backend.ts';

async function fixture() {
  let document: LocalDashboardDocument | null = null, writes = 0, next = 0, active = true, authenticated = true;
  const local = new LocalDashboard({ spaceId: 'local', title: 'Local', backendEpoch: 'epoch', now: Date.now, newId: () => `id-${++next}`, store: {
    read: async () => document, write: async value => { writes++; document = structuredClone(value); }, close: async () => {},
  } });
  const server = createServer();
  const ports = { port: () => (server.address() as { port: number }).port,
    rejection: (req: import('node:http').IncomingMessage) => authenticated && req.headers.cookie === 'fixture=session' ? undefined : 401 as const,
    active: () => active,
    backend: () => local.client(() => active && authenticated ? { subjectId: 'fixture-operator', layoutWrite: true } : null),
  };
  const query = dashboardHttpHandler(QUERY_PATH, ports), commands = dashboardHttpHandler(COMMAND_PATH, ports);
  server.on('request', (req, res) => { void (req.url === COMMAND_PATH ? commands : query)(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${ports.port()}`;
  async function post(body: string | Uint8Array = '{"kind":"overview"}', overrides: Record<string, string> = {}, path = QUERY_PATH): Promise<Response> {
    // node:http deliberately preserves the hostile Host override. Fetch may
    // normalize forbidden request headers and would not exercise this fence.
    return new Promise((resolve, reject) => {
      const request = nodeRequest(origin + path, { method: 'POST', headers: { Origin: origin, Cookie: 'fixture=session', 'X-DSH-Dashboard': '1', 'Content-Type': 'application/json', ...overrides } }, response => {
        const parts: Buffer[] = [];
        response.on('data', chunk => parts.push(chunk)); response.on('error', reject);
        response.on('end', () => {
          const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
          resolve(new Response(Buffer.concat(parts).toString(), { status: response.statusCode, headers }));
        });
      });
      request.on('error', reject); request.end(body);
    });
  }
  return { origin, post, local, get writes() { return writes; }, revoke: () => { authenticated = false; }, stop: () => { active = false; }, async close() {
    await local.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
test('authenticated HTTP query returns a noncached local overview without writes', async () => {
  const f = await fixture(); try { const response = await f.post(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('access-control-allow-origin'), null); assert.equal((await response.json()).data.mode, 'local'); assert.equal(f.writes, 0); } finally { await f.close(); }
});
test('authentication, origin, custom header and actual hostile Host reject without writing', async () => {
  const f = await fixture(); try {
    for (const [headers, status] of [[{ Cookie: 'wrong' }, 401], [{ Origin: 'http://evil.invalid' }, 403], [{ 'X-DSH-Dashboard': '0' }, 403], [{ Host: 'evil.invalid' }, 403]] as const) {
      const response = await f.post(undefined, headers); assert.equal(response.status, status, JSON.stringify(headers)); assert.equal(f.writes, 0);
    }
  } finally { await f.close(); }
});
test('strict JSON and size validation happen at the real HTTP boundary', async () => {
  const f = await fixture(); try {
    for (const body of ['{"kind":"overview","kind":"board"}', '{"kind":"overview","spaceId":"other"}', Uint8Array.of(255)]) {
      const response = await f.post(body); assert.equal(response.status, 400);
    }
    const response = await f.post(' '.repeat(1024 * 1024 + 1)); assert.equal(response.status, 413); assert.equal(f.writes, 0);
  } finally { await f.close(); }
});
test('layout command persists once and repeated request returns the original receipt', async () => {
  const f = await fixture(); try {
    const request = JSON.stringify({ requestId: 'one', backendEpoch: 'epoch', issuedAt: new Date().toISOString(), command: { kind: 'board.create', boardId: 'home', title: 'Home', placements: [] } });
    const response = await f.post(request, {}, COMMAND_PATH); assert.equal(response.status, 200); const receipt = await response.json();
    assert.deepEqual(await (await f.post(request, {}, COMMAND_PATH)).json(), receipt); assert.equal(f.writes, 1);
    f.revoke(); assert.equal((await f.post()).status, 401);
  } finally { await f.close(); }
});
test('unsupported routes and body encodings cannot become alternate entrypoints', async () => {
  const f = await fixture(); try {
    for (const [headers, path, status] of [[{ 'Content-Type': 'text/plain' }, QUERY_PATH, 400], [{ 'Content-Encoding': 'gzip' }, QUERY_PATH, 400], [{}, QUERY_PATH + '?extra=1', 501]] as const) {
      assert.equal((await f.post(undefined, headers, path)).status, status);
    }
    f.stop(); assert.equal((await f.post()).status, 503);
  } finally { await f.close(); }
});
test('HTTP client uses same-origin cookies, no redirects and explicit abort without retry', async () => {
  let calls = 0;
  const backend = createDashboardHttpBackend('http://127.0.0.1:8080', async (_url, init) => {
    calls++; assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.redirect, 'error'); assert.equal(init?.mode, 'same-origin'); assert.equal(init?.cache, 'no-store');
    throw new Error('private network details');
  });
  await assert.rejects(backend.query({ kind: 'overview' }), /dashboard\/unavailable/); assert.equal(calls, 1);
});
test('HTTP client preserves authorization errors but never upstream error text', async () => {
  for (const status of [401, 403]) {
    const backend = createDashboardHttpBackend('http://localhost:8080', async () => new Response('private error', { status }));
    await assert.rejects(backend.query({ kind: 'overview' }), new RegExp(status === 401 ? 'dashboard/unauthenticated' : 'dashboard/forbidden'));
  }
  assert.throws(() => createDashboardHttpBackend('https://example.invalid'), /dashboard\/forbidden/);
});
test('oversized declared body is fully drained before the 413 response', async () => {
  const f = await fixture(); try {
    const oversized = DASHBOARD_LIMITS.maxRequestBytes + 2;
    const order: string[] = [];
    const response = await new Promise<Response>((resolve, reject) => {
      const request = nodeRequest(f.origin + QUERY_PATH, { method: 'POST', headers: {
        Origin: f.origin, Cookie: 'fixture=session', 'X-DSH-Dashboard': '1', 'Content-Type': 'application/json',
        'Content-Length': String(oversized),
      } }, res => {
        const parts: Buffer[] = [];
        res.on('data', chunk => parts.push(chunk)); res.on('error', reject);
        res.on('end', () => { order.push('response'); resolve(new Response(Buffer.concat(parts).toString(), { status: res.statusCode })); });
      });
      request.on('error', reject); request.on('finish', () => order.push('finish'));
      request.write(' '.repeat(oversized - 1));
      setTimeout(() => request.end(' '), 100);
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'dashboard/limit-exceeded');
    assert.deepEqual(order, ['finish', 'response']);
    assert.equal(f.writes, 0);
  } finally { await f.close(); }
});
test('oversized streamed body without content-length is fully drained before the 413 response', async () => {
  const f = await fixture(); try {
    const order: string[] = [];
    const response = await new Promise<Response>((resolve, reject) => {
      const request = nodeRequest(f.origin + QUERY_PATH, { method: 'POST', headers: {
        Origin: f.origin, Cookie: 'fixture=session', 'X-DSH-Dashboard': '1', 'Content-Type': 'application/json',
      } }, res => {
        const parts: Buffer[] = [];
        res.on('data', chunk => parts.push(chunk)); res.on('error', reject);
        res.on('end', () => { order.push('response'); resolve(new Response(Buffer.concat(parts).toString(), { status: res.statusCode })); });
      });
      request.on('error', reject); request.on('finish', () => order.push('finish'));
      request.write(' '.repeat(DASHBOARD_LIMITS.maxRequestBytes + 1));
      setTimeout(() => request.end(' '), 100);
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'dashboard/limit-exceeded');
    assert.deepEqual(order, ['finish', 'response']);
    assert.equal(f.writes, 0);
  } finally { await f.close(); }
});
test('bodies beyond the drain cap are rejected without waiting for the upload', async () => {
  const f = await fixture(); try {
    const declared = await new Promise<Response>((resolve, reject) => {
      const request = nodeRequest(f.origin + QUERY_PATH, { method: 'POST', headers: {
        Origin: f.origin, Cookie: 'fixture=session', 'X-DSH-Dashboard': '1', 'Content-Type': 'application/json',
        'Content-Length': String(BODY_DRAIN_CAP + 1),
      } }, res => {
        const parts: Buffer[] = [];
        res.on('data', chunk => parts.push(chunk)); res.on('error', reject);
        res.on('end', () => resolve(new Response(Buffer.concat(parts).toString(), { status: res.statusCode })));
      });
      request.on('error', () => {});
      request.write(' '.repeat(4096));
      request.once('response', () => request.destroy());
    });
    assert.equal(declared.status, 413); assert.equal(f.writes, 0);
    const outcome = await new Promise<string>((resolve) => {
      const request = nodeRequest(f.origin + QUERY_PATH, { method: 'POST', headers: {
        Origin: f.origin, Cookie: 'fixture=session', 'X-DSH-Dashboard': '1', 'Content-Type': 'application/json',
      } }, res => {
        res.resume(); res.on('end', () => resolve(`status-${res.statusCode}`));
      });
      request.on('error', () => resolve('socket-error'));
      let sent = 0;
      const write = () => {
        while (sent < BODY_DRAIN_CAP + 1024 * 1024 && !request.destroyed) { sent += 1024 * 1024; if (!request.write(' '.repeat(1024 * 1024))) break; }
        if (sent >= BODY_DRAIN_CAP + 1024 * 1024 && !request.destroyed) request.end();
      };
      write(); request.on('drain', write);
    });
    assert.equal(outcome, 'socket-error'); assert.equal(f.writes, 0);
  } finally { await f.close(); }
});
