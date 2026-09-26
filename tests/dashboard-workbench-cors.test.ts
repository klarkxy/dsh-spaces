import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HomeDashboard } from '../src/core/domain/dashboard/home-backend.ts';
import { HomeDashboardGateway, handleDashboardUnavailable, type HomeDashboardGatewayOptions } from '../src/adapters/node/dashboard/gateway.ts';
import { HomeDashboardFileStore } from '../src/adapters/node/dashboard/file-store.ts';
async function setup() {
  mkdirSync('.sandbox', { recursive: true }); const root = mkdtempSync(resolve('.sandbox/dashboard-manager-cors-'));
  let origin = '', manager: string | null = 'http://127.0.0.1:43210';
  const hub = new HomeDashboard({ backendEpoch: randomUUID(), store: new HomeDashboardFileStore(join(root, 'data'), () => {}), newId: randomUUID, now: Date.now,
    sources: () => [], assertOwner: () => {}, assertRun: () => {} });
  const options: HomeDashboardGatewayOptions = { origin: () => origin, managerOrigin: () => manager,
    authorize: req => req.headers.cookie === 'fixture=operator' ? { subjectId: 'operator', layoutWrite: true, publicationsManage: true } : null };
  const gateway = new HomeDashboardGateway(hub, options);
  let missing = false;
  const server = createServer((req, res) => { void Promise.resolve(missing ? handleDashboardUnavailable(req, res, options) : gateway.handle(req, res)).then(ok => { if (!ok) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  function call(method = 'POST', headers: Record<string, string> = {}, path = '/api/dashboard/v1/query') {
    return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((yes, no) => {
      const req = request(origin + path, { method, headers: { Origin: 'http://127.0.0.1:43210', ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-DSH-Dashboard': '1' } : {}), ...headers } }, res => {
        let body = ''; res.on('data', b => { body += b; }); res.on('end', () => yes({ status: res.statusCode!, headers: res.headers, body })); res.on('error', no);
      }); req.on('error', no); req.end(method === 'POST' ? '{"kind":"overview"}' : undefined);
    });
  }
  return { call, stop: () => gateway.close(), removeDashboard: () => { missing = true; }, removeManager: () => { manager = null; }, async close() { gateway.close(); await hub.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); } };
}
const preflight = { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-dsh-dashboard' };
test('manager preflight admits only two exact headers and no data or authentication', async () => {
  const f = await setup(); try {
    const response = await f.call('OPTIONS', preflight); assert.equal(response.status, 204); assert.equal(response.body, '');
    assert.equal(response.headers['access-control-allow-origin'], 'http://127.0.0.1:43210'); assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.equal(response.headers['access-control-max-age'], '0');
    assert.equal((await f.call('OPTIONS', { ...preflight, 'Access-Control-Request-Headers': 'authorization' })).status, 403);
  } finally { await f.close(); }
});
test('manager origin is not authentication: only operator Cookie can read', async () => {
  const f = await setup(); try {
    assert.equal((await f.call()).status, 401);
    assert.equal((await f.call('POST', { Authorization: 'Bearer publisher-secret' })).status, 401);
    const response = await f.call('POST', { Cookie: 'fixture=operator' }); assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], 'http://127.0.0.1:43210'); assert.equal(response.headers.vary, 'Origin');
  } finally { await f.close(); }
});
test('ordinary loopback origins and stale manager origins receive neither data nor CORS', async () => {
  const f = await setup(); try {
    const denied = await f.call('POST', { Cookie: 'fixture=operator', Origin: 'http://127.0.0.1:43211' });
    assert.equal(denied.status, 403); assert.equal(denied.headers['access-control-allow-origin'], undefined);
    assert.equal((await f.call('OPTIONS', { ...preflight, Origin: 'http://127.0.0.1:43211' })).status, 403);
    f.removeManager(); const old = await f.call('POST', { Cookie: 'fixture=operator' }); assert.equal(old.status, 403); assert.equal(old.headers['access-control-allow-origin'], undefined);
  } finally { await f.close(); }
});
test('new cross-origin permission never applies to internal bearer endpoints', async () => {
  const f = await setup(); try {
    const response = await f.call('OPTIONS', preflight, '/internal/dashboard/v1/grant');
    assert.equal(response.status, 403); assert.equal(response.headers['access-control-allow-origin'], undefined);
  } finally { await f.close(); }
});

for (const mode of ['closed', 'missing'] as const) test(`${mode} dashboard keeps errors readable without widening authentication or origins`, async () => {
  const f = await setup(); try {
    if (mode === 'closed') f.stop(); else f.removeDashboard();
    assert.equal((await f.call('OPTIONS', preflight)).status, 204);
    const result = await f.call('POST', { Cookie: 'fixture=operator' });
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).error.code, 'dashboard/unavailable');
    assert.equal(result.headers['access-control-allow-origin'], 'http://127.0.0.1:43210');
    assert.equal(result.headers['access-control-allow-credentials'], 'true');
    assert.equal((await f.call()).status, 401);
    assert.equal((await f.call('POST', { Authorization: `Bearer ${'a'.repeat(64)}` })).status, 401);
    for (const Origin of ['null', 'http://untrusted.invalid', 'http://127.0.0.1:43211']) {
      const denied = await f.call('POST', { Origin, Cookie: 'fixture=operator' });
      assert.equal(denied.status, 403); assert.equal(denied.headers['access-control-allow-origin'], undefined);
    }
    const wrongHost = await f.call('POST', { Host: 'evil.invalid', Cookie: 'fixture=operator' });
    assert.equal(wrongHost.status, 403); assert.equal(wrongHost.headers['access-control-allow-origin'], undefined);
    const internal = await f.call('OPTIONS', preflight, '/internal/dashboard/v1/grant');
    assert.equal(internal.status, 403); assert.equal(internal.headers['access-control-allow-origin'], undefined);
    f.removeManager(); const old = await f.call('POST', { Cookie: 'fixture=operator' });
    assert.equal(old.status, 403); assert.equal(old.headers['access-control-allow-origin'], undefined);
  } finally { await f.close(); }
});
