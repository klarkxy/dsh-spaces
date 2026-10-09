import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { applyBundleOrder } from '../order.mjs';

async function fixture(t, { live = false, order = ['protected', 'a', 'b'], protectedNames = ['protected'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-blueprint-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'package.json');
  const manifest = { name: 'profile', private: true, dependencies: { a: '1.0.0', b: '2.0.0' },
    custom: { retained: [1, true] }, dsh: { other: 'retain', profile: { bundles: order, nested: { retained: true } } } };
  await writeFile(path, JSON.stringify(manifest));
  const events = [];
  let locked = false, queued = false;
  const packages = order.map(name => ({ name, readonly: protectedNames.includes(name), enabled: true, reason: null }));
  const root = {};
  const ctx = { root, profileContext: { dir }, get: name => name === 'hmr' && live ? hmr : undefined };
  const hmr = { async runExclusive(operation) {
    events.push('queue-enter'); queued = true;
    try { return await operation(); } finally { queued = false; events.push('queue-exit'); }
  } };
  const libs = {
    async withFileLock(filename, operation) {
      assert.equal(filename, path); if (live) assert.equal(queued, true);
      events.push('lock-enter'); locked = true;
      try { return await operation(); } finally { locked = false; events.push('lock-exit'); }
    },
    async snapshot() {
      const text = await readFile(path, 'utf8');
      return { stamp: createHash('sha256').update(text + JSON.stringify(packages)).digest('hex'),
        order: JSON.parse(text).dsh.profile.bundles, packages };
    },
    async saveManifest(directory, next) {
      assert.equal(directory, dir); assert.equal(locked, true); events.push('save');
      await writeFile(path + '.next', JSON.stringify(next, null, 2) + '\n');
      await rename(path + '.next', path);
    },
    readProfilePatches(bin, profile) {
      assert.equal(bin, 'dsh'); assert.equal(profile, ctx.profileContext);
      assert.equal(locked, true); events.push('read-patches'); return ['patches'];
    },
    async reconcileProfilePatches(context, patches, bin) {
      assert.equal(context, root); assert.deepEqual(patches, ['patches']); assert.equal(bin, 'dsh');
      assert.equal(locked, true); if (live) assert.equal(queued, true);
      events.push('reconcile'); return [];
    },
  };
  const stamp = (await libs.snapshot()).stamp;
  return { ctx, libs, path, manifest, packages, events, stamp, request: { order: ['protected', 'b', 'a'], stamp },
    read: async () => JSON.parse(await readFile(path, 'utf8')) };
}

test('offline module import and startup save preserve all unrelated metadata', async t => {
  const f = await fixture(t);
  assert.deepEqual(await applyBundleOrder(f.ctx, f.request, undefined, f.libs),
    { saved: true, changed: true, application: 'restart-required' });
  assert.deepEqual(await f.read(), { ...f.manifest, dsh: { ...f.manifest.dsh,
    profile: { ...f.manifest.dsh.profile, bundles: f.request.order } } });
  assert.deepEqual(f.events, ['lock-enter', 'save', 'lock-exit']);
});

test('no-op is applied without writing or reloading', async t => {
  const f = await fixture(t, { live: true });
  const before = await readFile(f.path, 'utf8');
  assert.deepEqual(await applyBundleOrder(f.ctx, { order: f.manifest.dsh.profile.bundles, stamp: f.stamp }, undefined, f.libs),
    { saved: false, changed: false, application: 'applied' });
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.deepEqual(f.events, ['queue-enter', 'lock-enter', 'lock-exit', 'queue-exit']);
});

test('live save and reconcile use outer HMR queue, file lock and root context', async t => {
  const f = await fixture(t, { live: true });
  f.libs.reconcileProfilePatches = async (root, patches, bin) => {
    assert.equal(root, f.ctx.root); assert.equal(bin, 'dsh'); assert.deepEqual(patches, ['patches']);
    f.events.push('reconcile'); return ['unchanged inactive entry'];
  };
  assert.deepEqual(await applyBundleOrder(f.ctx, f.request, undefined, f.libs),
    { saved: true, changed: true, application: 'applied', warnings: ['unchanged inactive entry'] });
  assert.deepEqual(f.events, ['queue-enter', 'lock-enter', 'save', 'read-patches', 'reconcile', 'lock-exit', 'queue-exit']);
});

test('stale stamp is checked after entering lock, not before', async t => {
  const f = await fixture(t);
  const lock = f.libs.withFileLock;
  f.libs.withFileLock = async (path, operation) => {
    await writeFile(f.path, JSON.stringify({ ...f.manifest, concurrent: true }));
    return lock(path, operation);
  };
  await assert.rejects(applyBundleOrder(f.ctx, f.request, undefined, f.libs), { code: 'stale' });
  assert.equal((await f.read()).concurrent, true); assert.ok(!f.events.includes('save'));
});

for (const [label, order] of [
  ['addition', ['protected', 'b', 'a', 'c']], ['removal', ['protected', 'a']],
  ['replacement', ['protected', 'a', 'c']], ['duplicate', ['protected', 'a', 'a']],
  ['empty name', ['protected', 'a', '']], ['non-string', ['protected', 'a', 1]],
]) test(`reject ${label} instead of changing selections`, async t => {
  const f = await fixture(t);
  await assert.rejects(applyBundleOrder(f.ctx, { order, stamp: f.stamp }, undefined, f.libs), { code: 'order' });
  assert.deepEqual(await f.read(), f.manifest); assert.ok(!f.events.includes('save'));
});

test('protected layer cannot move', async t => {
  const f = await fixture(t);
  await assert.rejects(applyBundleOrder(f.ctx, { order: ['a', 'protected', 'b'], stamp: f.stamp }, undefined, f.libs), { code: 'protected' });
});

test('movable layers cannot cross a protected position even when its index stays fixed', async t => {
  const f = await fixture(t, { order: ['a', 'protected', 'b'] });
  await assert.rejects(applyBundleOrder(f.ctx, { order: ['b', 'protected', 'a'], stamp: f.stamp }, undefined, f.libs), { code: 'protected' });
});

for (const state of ['missing', 'disabled', 'error', 'unrecognized']) test(`fail closed for ${state} catalog identity`, async t => {
  const f = await fixture(t);
  if (state === 'missing') f.packages.pop();
  if (state === 'disabled') f.packages[2].enabled = false;
  if (state === 'error') f.packages[2].reason = 'native-bundle-error';
  if (state === 'unrecognized') delete f.packages[2].readonly;
  const stamp = (await f.libs.snapshot()).stamp;
  await assert.rejects(applyBundleOrder(f.ctx, { ...f.request, stamp }, undefined, f.libs), { code: 'order' });
  assert.ok(!f.events.includes('save'));
});

test('manifest/snapshot disagreement fails stale', async t => {
  const f = await fixture(t);
  const snapshot = await f.libs.snapshot();
  f.libs.snapshot = async () => snapshot;
  await writeFile(f.path, JSON.stringify({ ...f.manifest, dsh: { profile: { bundles: ['protected', 'b', 'a'] } } }));
  await assert.rejects(applyBundleOrder(f.ctx, f.request, undefined, f.libs), { code: 'stale' });
});

for (const phase of ['before', 'queue', 'lock', 'snapshot', 'after-save', 'read-patches']) test(`cancellation ${phase} is truthful about commit`, async t => {
  const f = await fixture(t, { live: true });
  const controller = new AbortController();
  if (phase === 'before') controller.abort();
  if (phase === 'queue') {
    const hmr = f.ctx.get('hmr');
    f.ctx.get = () => ({ runExclusive: operation => hmr.runExclusive(() => { controller.abort(); return operation(); }) });
  }
  for (const [label, method] of [['lock', 'withFileLock'], ['snapshot', 'snapshot'], ['after-save', 'saveManifest'], ['read-patches', 'readProfilePatches']]) {
    if (phase !== label) continue;
    const original = f.libs[method];
    f.libs[method] = async (...args) => {
      if (label === 'lock') controller.abort();
      const result = await original(...args);
      if (label !== 'lock') controller.abort();
      return result;
    };
  }
  const result = await applyBundleOrder(f.ctx, f.request, controller.signal, f.libs);
  const saved = ['after-save', 'read-patches'].includes(phase);
  assert.deepEqual(result, { saved, changed: saved, application: 'cancelled', code: 'interrupted' });
  assert.deepEqual((await f.read()).dsh.profile.bundles, saved ? f.request.order : f.manifest.dsh.profile.bundles);
  assert.ok(!f.events.includes('reconcile'));
});

for (const phase of ['saveManifest', 'readProfilePatches', 'reconcileProfilePatches', 'withFileLock']) test(`${phase} failure has no retry or rollback and hides private messages`, async t => {
  const f = await fixture(t, { live: true });
  let calls = 0;
  f.libs[phase] = async () => { calls++; throw new Error('secret environment credentials'); };
  const result = await applyBundleOrder(f.ctx, f.request, undefined, f.libs);
  const saved = ['readProfilePatches', 'reconcileProfilePatches'].includes(phase);
  assert.deepEqual(result, { saved, changed: saved, application: 'failed', code: saved ? 'application-failed' : 'save-failed' });
  assert.equal(calls, 1);
  assert.deepEqual((await f.read()).dsh.profile.bundles, saved ? f.request.order : f.manifest.dsh.profile.bundles);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('queued request detaches caller order before asynchronous work', async t => {
  const f = await fixture(t, { live: true });
  const hmr = f.ctx.get('hmr');
  f.ctx.get = () => ({ runExclusive: operation => hmr.runExclusive(() => { f.request.order.reverse(); return operation(); }) });
  const expected = [...f.request.order];
  const result = await applyBundleOrder(f.ctx, f.request, undefined, f.libs);
  assert.equal(result.application, 'applied'); assert.deepEqual((await f.read()).dsh.profile.bundles, expected);
});

test('missing live queue or reconciliation contract cannot save the profile', async t => {
  const f = await fixture(t, { live: true });
  f.ctx.get = () => ({});
  await assert.rejects(applyBundleOrder(f.ctx, f.request, undefined, f.libs), { code: 'capability' });
  f.ctx.get = () => ({ runExclusive: operation => operation() });
  f.libs.withFileLock = async (_path, operation) => operation();
  f.libs.readProfilePatches = {};
  await assert.rejects(applyBundleOrder(f.ctx, f.request, undefined, f.libs), { code: 'capability' });
  assert.deepEqual(await f.read(), f.manifest);
});

test('reject extra request keys and missing stamp before filesystem operations', async t => {
  const f = await fixture(t);
  await assert.rejects(applyBundleOrder(f.ctx, { ...f.request, enabled: true }, undefined, f.libs), { code: 'order' });
  await assert.rejects(applyBundleOrder(f.ctx, { order: f.request.order }, undefined, f.libs), { code: 'stale' });
  assert.deepEqual(f.events, []);
});
