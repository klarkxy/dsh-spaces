import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SnapshotStore } from '../src/main/snapshot-store.ts';
import { describeRuntime, readRuntimeRef } from '../src/main/runtime-descriptor.ts';
const resume = process.env.DSH_SNAPSHOT_RESUME_ROOT;
const { bin, home } = resume ? {
  home: process.env.DSH_SNAPSHOT_RESUME_HOME,
  bin: join(process.env.APPDATA, 'dsh-spaces', 'dsh-cli', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
} : await import('./real-config-check.mjs');
assert.ok(home && relative(tmpdir(), home).startsWith('spaces-real-config-'));
const root = resume || mkdtempSync(join(tmpdir(), 'spaces-real-snapshots-'));
const runtime = describeRuntime(readRuntimeRef(bin));
const store = new SnapshotStore({ home, root });
console.log('Creating snapshot of the real installed DSH dependency tree');
const first = resume ? store.list().find(row => row.reason === 'acceptance') : store.create(runtime, 'acceptance');
console.log(`Snapshot ${first.id}: ${(first.size/1048576).toFixed(1)} MiB`);
function verifyLinks(dir, boundary) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name); const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const delta = relative(boundary, realpathSync(path));
      assert.ok(!isAbsolute(delta) && !delta.startsWith('..'), `snapshot link escapes: ${path}`);
    } else if (stat.isDirectory()) verifyLinks(path, boundary);
  }
}
if (!resume) verifyLinks(join(root, first.id), join(root, first.id));
mkdirSync(join(home, 'hub'), { recursive: true });
writeFileSync(join(home, 'hub', 'new-after-snapshot.txt'), 'later');
writeFileSync(join(home, '.anonymous-user-id'), 'same-machine');
const restore = store.restore(first.id, runtime);
store.completeRestore();
assert.ok(!existsSync(join(home, 'hub', 'new-after-snapshot.txt')));
assert.equal(readFileSync(join(home, '.anonymous-user-id'), 'utf8'), 'same-machine');
const selected = { root: store.runtimeRoot(first.id), version: first.runtimeVersion, binRelative: first.binRelative };
const check = spawnSync(process.execPath, [store.runtimeBin(first.id), '--profile', 'coding', '--dump-config'], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
assert.equal(check.status, 0, check.stderr);
assert.ok(check.stdout.includes('hub/coding/sessions'));
console.log('PASS restored snapshot CLI independently loads real offline dependencies');
store.restore(first.id, selected); store.completeRestore();
assert.ok(store.preview(restore.beforeRestore.id));
console.log('PASS real snapshot links, restore-before backup, identity preservation and consecutive offline restore');
console.log(`SNAPSHOT_TEST_ROOT=${root}`);
