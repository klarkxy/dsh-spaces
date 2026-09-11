import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { RuntimeStore } from '../src/main/runtime-store.ts';
import { SnapshotStore } from '../src/main/snapshot-store.ts';
import { CoordinatedUpgrade } from '../src/main/coordinated-upgrade.ts';
import { ProcessManager } from '../src/main/process-manager.ts';
import { PatchWriter } from '../src/main/patch-writer.ts';
import { describeRuntime, readRuntimeRef } from '../src/main/runtime-descriptor.ts';
import { setSelectedDshResolver } from '../src/main/dsh-cli.ts';
import { dshSessionCookie, dshSessionList } from '../src/main/dsh-endpoint.ts';

// A successful real-runtime-install run supplies the candidate. No mock installer,
// CLI, network response, snapshot implementation, or readiness probe is used here.
const candidate = JSON.parse(readFileSync(process.env.DSH_TEST_INSTALL_RESULT || 'tasks/runtime-install-result.json', 'utf8'));
const delta = relative(resolve(tmpdir()), resolve(candidate.root));
assert.ok(!isAbsolute(delta) && !delta.startsWith('..') && /^spaces-runtime-install-[^\\/]+$/.test(delta),
  'Candidate store must be an acceptance-created temporary directory');
const { bin, home } = await import('./real-config-check.mjs');
const original = readRuntimeRef(bin);
assert.ok(original);
assert.notEqual(candidate.installed.version, original.version,
  'Use DSH_TEST_RUNTIME_VERSION to install a different version before cross-version acceptance');
const root = mkdtempSync(join(tmpdir(), 'spaces-real-upgrade-'));
const snapshotRoot = join(root, 'snapshots');
const runtimes = new RuntimeStore({ root: candidate.root, snapshotRoot,
  source: () => candidate.source || 'official', legacy: () => original });
assert.ok(runtimes.inventory().installed.some(row => row.version === candidate.installed.version));
await runtimes.selectExisting(original);
setSelectedDshResolver(() => runtimes.current()?.bin);
const manager = new ProcessManager(home, new PatchWriter(home), 3410, 3439);
const snapshots = new SnapshotStore({ home, root: snapshotRoot });
const names = ['web', 'coding', 'writing'];
const ports = new Set();
const phases = [];
const upgrade = new CoordinatedUpgrade({ home, profiles: () => names,
  stopAll: () => manager.stopAll(), snapshots, runtimes,
  runtimeDescriptor: () => describeRuntime(runtimes.current()),
  onProgress: progress => { phases.push(progress.phase); console.log('UPGRADE', JSON.stringify(progress)); },
});
async function rpc(port, method, payload = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const name = names.find(name => manager.portOf(name) === port);
  const cookie = await dshSessionCookie(manager.urlOf(name), fetch, AbortSignal.timeout(10000));
  if(method==='session.list') return dshSessionList(port,fetch,AbortSignal.timeout(10000),cookie);
  const response = await fetch(`${origin}/api/${method}`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin, connection: 'close', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.result?.ok, JSON.stringify(body));
  return body.result.value;
}
async function startAll() {
  const rows = await Promise.all(names.map(name => manager.start(name)));
  rows.forEach(row => ports.add(row.port));
  return rows;
}
async function assertClosed() {
  for (const port of ports) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }));
  }
}
async function assertSessions(rows, sessions) {
  for (const [index, row] of rows.entries()) {
    const ids = (await rpc(row.port, 'session.list')).items.map(item => item.sessionId);
    assert.ok(ids.includes(sessions[index]));
    sessions.forEach((id, other) => { if (other !== index) assert.ok(!ids.includes(id)); });
  }
}
console.log(`UPGRADE_TEST_ROOT=${root}\nUPGRADE_TEST_HOME=${home}`);
try {
  const initial = await startAll();
  const sessions = [];
  for (const [index, row] of initial.entries()) {
    const cwd = join(root, `workspace-${names[index]}`); mkdirSync(cwd);
    sessions.push((await rpc(row.port, 'session.create', { cwd })).sessionId);
  }
  assert.ok(sessions.every(Boolean));
  const patches = names.map(name => readFileSync(join(home, 'profiles', name, 'cordis.patch.yml')));
  const preview = upgrade.preview(candidate.installed.version);
  assert.equal(preview.profiles.length, names.length);
  assert.ok(preview.officialTargets);
  const result = await upgrade.upgrade(candidate.installed.version);
  assert.equal(runtimes.current().version, candidate.installed.version);
  assert.ok(phases.includes('done'));
  await assertClosed(); // Upgrade must leave spaces stopped until the user starts them.
  names.forEach((name, index) => assert.deepEqual(readFileSync(join(home, 'profiles', name, 'cordis.patch.yml')), patches[index]));
  await assertSessions(await startAll(), sessions);
  console.log('PASS real cross-version upgrade: preserved patches and isolated sessions; explicit restart succeeds');
  await manager.stopAll();
  const marker = join(home, 'hub', 'after-upgrade-acceptance.txt');
  writeFileSync(marker, 'post-upgrade state');
  const restored = await upgrade.restore(result.snapshotId);
  assert.equal(runtimes.current().version, original.version);
  assert.equal(runtimes.current().origin, 'snapshot');
  assert.equal(existsSync(marker), false);
  assert.ok(snapshots.preview(restored.beforeRestore.id));
  await assertSessions(await startAll(), sessions);
  console.log('PASS upgrade snapshot restores the prior version and sessions, retaining a before-restore backup');
  writeFileSync(join(root, 'result.json'), JSON.stringify({ home, original: original.version,
    candidate: candidate.installed.version, result, restored, phases }, null, 2));
} finally { await manager.stopAll(); }
await assertClosed();
console.log('PASS all acceptance-owned API ports closed');
