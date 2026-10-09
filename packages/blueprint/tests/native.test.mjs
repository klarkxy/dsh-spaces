import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { officialPort } from '../official.mjs';
import { apply, inject } from '../index.mjs';
import { PACKAGE } from '../blueprint.mjs';
import { encode, decode } from '../codec.mjs';
function fixture(t) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-blueprint-contract-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const manifest = { dependencies: { 'example-a': '1.2.3', [PACKAGE]: '0.1.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'example-a', PACKAGE] } } };
  const save = () => writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest)); save();
  const bundles = [
    { name: '@deepseek-ai/dsh-base', version: '0.1.7-rc.2', installed: false, optional: false, enabled: true, readOnlyReason: 'management-required', rows: [] },
    { name: 'example-a', version: '1.2.3', installed: true, optional: false, enabled: true, rows: [{ moduleName: 'example-a' }] },
    { name: PACKAGE, version: '0.1.0', installed: true, optional: false, enabled: true, rows: [{ moduleName: PACKAGE }] },
  ];
  const disposers = [], deferred = []; let route, server;
  const ctx = {
    inject(services, callback) { if (services.includes('webServer')) callback(ctx); else deferred.push({ services, callback }); },
    profileContext: { dir: profile }, pluginManager: { listBundles: async () => bundles },
    effect(factory) { const off = factory(); disposers.push(off); return off; },
    connection: { requestRejection: () => undefined },
    webServer: { register(value) { route = value; return () => { route = undefined; }; } },
  };
  for (const name of ['settings', 'loader', 'credentials', 'storage']) Object.defineProperty(ctx, name, { get() { throw new Error(name + ' forbidden'); } });
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });
  const request = async (endpoint, payload) => {
    if (!server) { server = createServer((req, res) => route ? void route.handler(req, res) : (res.writeHead(404), res.end())); server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
    return fetch('http://127.0.0.1:' + server.address().port + '/dsh-blueprint/' + endpoint,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: endpoint, payload }) });
  };
  return { ctx, bundles, manifest, save, disposers, deferred, request, rpc: async (...args) => (await (await request(...args)).json()).result };
}
test('Core plugin has no hard Web or profile dependencies', () => {
  assert.deepEqual(inject, []); const calls = [];
  apply({ inject: (services, callback) => calls.push({ services, callback }) });
  assert.ok(calls.some(call => call.services.includes('tools')));
  assert.ok(calls.some(call => call.services.includes('systemPrompt')));
  assert.ok(calls.some(call => call.services.includes('webServer')));
});
test('native adapter reads only and never recasts local sources as npm', async t => {
  const f = fixture(t); f.manifest.dependencies['example-a'] = 'link:/private/plugin'; f.save();
  const port = officialPort(f.ctx);
  assert.deepEqual(Object.keys(port), ['snapshot']);
  assert.equal((await port.snapshot()).packages.find(p => p.name === 'example-a').source, null);
});
test('native catalog stamp ignores enumeration order but detects manifest drift', async t => {
  const f = fixture(t), port = officialPort(f.ctx), first = await port.snapshot();
  f.bundles.reverse(); assert.equal((await port.snapshot()).stamp, first.stamp);
  f.ctx.pluginManager.listBundles = async () => { f.manifest.dsh.profile.bundles.reverse(); f.save(); return f.bundles; };
  await assert.rejects(() => port.snapshot(), /Profile changed/);
});
test('page RPC exposes only read-only operations and retires execution endpoints', async t => {
  const f = fixture(t); apply(f.ctx);
  for (const endpoint of ['preview', 'apply', 'result', 'run-shell']) assert.equal((await f.rpc(endpoint, {})).error.code, 'endpoint');
  const catalog = (await f.rpc('catalog', {})).value;
  assert.deepEqual(catalog.order, f.manifest.dsh.profile.bundles); assert.equal(typeof catalog.stamp, 'string');
  assert.equal(catalog.packages.find(p => p.name === PACKAGE).readonly, true);
  const generated = (await f.rpc('generate', { name: 'demo', packages: ['example-a'] })).value;
  assert.deepEqual(Object.keys(generated), ['code']);
  assert.deepEqual((await f.rpc('parse', { text: generated.code })).value, decode(generated.code));
  f.disposers.forEach(off => off?.()); assert.equal((await f.request('catalog', {})).status, 404);
});
test('strict parsing and unknown request fields fail without native mutation', async t => {
  const f = fixture(t); apply(f.ctx);
  for (const [endpoint, payload] of [['catalog', { mode: 'settings' }], ['generate', { name: 'x', packages: [], forms: [] }],
    ['parse', { text: encode({ kind: 'dsh-settings', formatVersion: 1, settings: [] }) }], ['parse', { text: 'invalid' }],
    ['parse', { text: encode({ kind: 'dsh-blueprint', formatVersion: 2, metadata: { name: 'x' }, packages: [], bundles: [] }), execute: true }]]) {
    assert.equal((await f.rpc(endpoint, payload)).ok, false);
  }
  assert.deepEqual(Object.keys(f.ctx.pluginManager), ['listBundles']);
});
