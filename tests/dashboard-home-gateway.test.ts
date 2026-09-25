import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { HomeDashboard, type HomeReader } from '../src/core/domain/dashboard/home-backend.ts';
import { HomeDashboardGateway } from '../src/adapters/node/dashboard/gateway.ts';
import { HomeDashboardFileStore } from '../src/adapters/node/dashboard/file-store.ts';
import { DashboardFault } from '../src/core/domain/dashboard/errors.ts';

async function fixture() {
  mkdirSync('.sandbox', { recursive: true }); const directory = mkdtempSync(resolve('.sandbox/dashboard-gateway-'));
  const roles: Record<string, HomeReader> = {
    reader: { subjectId: 'reader', layoutWrite: false, publicationsManage: false },
    writer: { subjectId: 'writer', layoutWrite: true, publicationsManage: false },
    manager: { subjectId: 'manager', layoutWrite: true, publicationsManage: true },
  };
  let origin = '', authorized = true;
  const hub = new HomeDashboard({ backendEpoch: 'gateway-epoch', store: new HomeDashboardFileStore(join(directory, 'state'), () => {}), now: Date.now, newId: randomUUID,
    sources: () => [{ spaceId: 'space', title: 'Space', sourceState: 'running', publishing: 'disabled' }], assertOwner: () => {}, assertRun: binding => { if (binding.spaceId !== 'space') throw new DashboardFault('dashboard/stale-run'); } });
  const gateway = new HomeDashboardGateway(hub, { origin: () => origin, authorize: req => authorized ? roles[req.headers.cookie ?? ''] ?? null : null });
  const server = createServer((req, res) => { void gateway.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (body: unknown, role = 'reader', path = '/api/dashboard/v1/query', extra: Record<string, string> = {}) => new Promise<{ status: number; data: any; headers: import('node:http').IncomingHttpHeaders }>((yes, no) => {
    const req = httpRequest(origin + path, { method: 'POST', headers: { Host: new URL(origin).host, Origin: origin, Cookie: role, 'X-DSH-Dashboard': '1', 'Content-Type': 'application/json', ...extra } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('error', no); res.on('end', () => yes({ status: res.statusCode!, data: text ? JSON.parse(text) : null, headers: res.headers }));
    }); req.on('error', no); req.end(JSON.stringify(body));
  });
  return { hub, gateway, call, revokeSession: () => { authorized = false; }, async close() { gateway.close(); await hub.close(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); rmSync(directory, { recursive: true, force: true }); } };
}
const mutation = () => ({ requestId: randomUUID(), backendEpoch: 'gateway-epoch', issuedAt: new Date().toISOString(), command: { kind: 'board.create', boardId: randomUUID(), title: 'Board', placements: [] } });

test('Home gateway distinguishes reader, layout writer and publication manager', async () => {
  const f = await fixture(); try {
    const overview = await f.call({ kind: 'overview' }); assert.equal(overview.status, 200); assert.equal(overview.data.data.mode, 'home'); assert.equal(overview.data.data.capabilities.layoutWrite, false);
    assert.equal(overview.headers['cache-control'], 'no-store'); assert.equal(overview.headers['access-control-allow-origin'], undefined);
    assert.equal((await f.call(mutation(), 'reader', '/api/dashboard/v1/commands')).status, 403);
    assert.equal((await f.call(mutation(), 'writer', '/api/dashboard/v1/commands')).status, 200);
    assert.equal((await f.call({ kind: 'publications', spaceId: 'space' }, 'writer')).status, 403);
    assert.equal((await f.call({ kind: 'publications', spaceId: 'space' }, 'manager')).status, 200);
  } finally { await f.close(); }
});
test('publisher bearer never authenticates public queries, layout writes or manager operations', async () => {
  const f = await fixture(); try {
    const issued = await f.gateway.publishers.issue({ spaceId: 'space', runId: 'run', generation: 1 });
    const headers = { Authorization: `Bearer ${issued.bootstrap.bearer}` };
    assert.equal((await f.call({ kind: 'overview' }, '', undefined, headers)).status, 401);
    assert.equal((await f.call(mutation(), '', '/api/dashboard/v1/commands', headers)).status, 401);
    assert.equal((await f.call({ ...mutation(), command: { kind: 'dashboard.publication.set' } }, 'manager', '/api/dashboard/v1/commands')).status, 501);
    issued.dispose();
  } finally { await f.close(); }
});
test('Home gateway checks real hostile Host and Origin before touching application data', async () => {
  const f = await fixture(); try {
    for (const headers of ([{ Host: 'other.invalid' }, { Origin: 'http://other.invalid' }, { 'X-DSH-Dashboard': '0' }] as Array<Record<string, string>>)) assert.equal((await f.call({ kind: 'overview' }, 'reader', undefined, headers)).status, 403);
    f.revokeSession(); assert.equal((await f.call({ kind: 'overview' })).status, 401);
  } finally { await f.close(); }
});
test('a closed gateway cannot serve previously authenticated cached data', async () => {
  const f = await fixture(); try {
    assert.equal((await f.call({ kind: 'overview' })).status, 200);
    f.gateway.close(); assert.equal((await f.call({ kind: 'overview' })).status, 503);
  } finally { await f.close(); }
});
