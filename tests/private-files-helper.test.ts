import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WindowsPrivateFileHelper } from '../src/shared/node/private-files.ts';
import { HomeDashboardFileStore } from '../src/adapters/node/dashboard/file-store.ts';

const request = { directory: resolve('.sandbox/helper-protocol'), files: [], createDirectory: false, createFile: null };
// Metadata-only protocol fixture. Test workers never touch the requested filesystem paths.
const fixtureScript = String.raw`
const behavior = process.argv[1];
if (behavior === 'startup-exit') process.exit(7);
if (behavior !== 'no-ready') process.stdout.write('{"ready":1}\n');
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\n'); if (end < 0) break;
    const row = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
    if (behavior === 'inflight-exit') process.exit(9);
    if (behavior === 'hang' || behavior === 'ignore-eof') continue;
    if (behavior === 'malformed') { process.stdout.write('not-json\n'); continue; }
    if (behavior === 'duplicate-key') { process.stdout.write('{"id":1,"id":1,"ok":true}\n'); continue; }
    if (behavior === 'unknown-id') { process.stdout.write('{"id":9999,"ok":true}\n'); continue; }
    if (behavior === 'oversized') { process.stdout.write('x'.repeat(5000)); continue; }
    if (behavior === 'stderr-overflow') { process.stderr.write('x'.repeat(70000)); continue; }
    if (behavior === 'wrong-shape') { process.stdout.write(JSON.stringify({ id: row.id, ok: true, extra: true }) + '\n'); continue; }
    process.stdout.write(JSON.stringify({ id: row.id, ok: behavior !== 'reject' }) + '\n');
    if (behavior === 'idle-exit') setImmediate(() => process.exit(6));
  }
});
process.stdin.on('end', () => { if (behavior !== 'ignore-eof') process.exit(0); });
if (behavior === 'ignore-eof') setInterval(() => {}, 1000);
`;
function fixture(behavior = 'ok', timeout = 2000) {
  const children: ChildProcessWithoutNullStreams[] = [];
  const helper = new WindowsPrivateFileHelper({ launch: () => {
    const child = spawn(process.execPath, ['-e', fixtureScript, behavior], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.push(child); return child;
  }, requestTimeoutMs: timeout, closeTimeoutMs: 1500 });
  return { helper, children, async finish() {
    await helper.close();
    for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned helper was not terminated');
  } };
}

test('helper starts lazily once, correlates queued requests, and EOF close is shared and final', async () => {
  const f = fixture();
  assert.equal(f.children.length, 0); assert.equal(f.helper.status, 'new');
  await Promise.all(Array.from({ length: 8 }, () => f.helper.request(request)));
  assert.equal(f.helper.status, 'ready'); assert.equal(f.children.length, 1);
  const closed = f.helper.close(); assert.equal(f.helper.close(), closed); assert.equal(f.helper.status, 'closed');
  await closed; await assert.rejects(f.helper.request(request)); await f.finish();
  assert.equal(f.children.length, 1);
});

test('synchronous spawn failure and asynchronous startup exit never trigger a second spawn', async () => {
  let starts = 0;
  const helper = new WindowsPrivateFileHelper({ launch: () => { starts++; throw new Error('injected spawn failure'); } });
  await assert.rejects(helper.request(request)); await assert.rejects(helper.request(request));
  assert.equal(starts, 1); assert.equal(helper.status, 'failed'); await helper.close();
  const f = fixture('startup-exit');
  await assert.rejects(f.helper.request(request)); await assert.rejects(f.helper.request(request));
  assert.equal(f.children.length, 1); await f.finish();
});

test('idle helper exit and in-flight helper exit are terminal', async () => {
  const idle = fixture('idle-exit');
  const first = idle.helper.request(request), exited = once(idle.children[0], 'exit');
  await first; await exited; assert.equal(idle.helper.status, 'failed');
  await assert.rejects(idle.helper.request(request)); assert.equal(idle.children.length, 1); await idle.finish();
  const flight = fixture('inflight-exit');
  await assert.rejects(flight.helper.request(request)); assert.equal(flight.helper.status, 'failed');
  await assert.rejects(flight.helper.request(request)); assert.equal(flight.children.length, 1); await flight.finish();
});

for (const behavior of ['malformed', 'duplicate-key', 'unknown-id', 'oversized', 'stderr-overflow', 'wrong-shape']) {
  test(`helper ${behavior} output terminates pending work without relaunch`, async () => {
    const f = fixture(behavior);
    await assert.rejects(f.helper.request(request)); assert.equal(f.helper.status, 'failed');
    await assert.rejects(f.helper.request(request)); assert.equal(f.children.length, 1); await f.finish();
  });
}

test('startup and queue-inclusive request deadlines terminate the helper and reject all queued work', async () => {
  for (const behavior of ['no-ready', 'hang']) {
    const f = fixture(behavior, 250);
    const started = performance.now();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => f.helper.request(request)));
    assert.ok(results.every(result => result.status === 'rejected')); assert.equal(f.helper.status, 'failed');
    assert.ok(performance.now() - started < 1500); await assert.rejects(f.helper.request(request));
    assert.equal(f.children.length, 1); await f.finish();
  }
});

test('helper input and pending queue bounds reject excess work without an extra process', async () => {
  const f = fixture('no-ready', 1000);
  const pending = Array.from({ length: 32 }, () => f.helper.request(request));
  // Attach handlers before closing rejects every accepted request.
  const settled = Promise.allSettled(pending);
  await assert.rejects(f.helper.request(request), /limit-exceeded/);
  await f.helper.close(); assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.equal(f.children.length, 1); await f.finish();
  const g = fixture();
  await assert.rejects(g.helper.request({ ...request, directory: resolve('.sandbox', 'x'.repeat(66000)) }), /limit-exceeded/);
  assert.equal(g.children.length, 0); await g.finish();
});

test('stdin backpressure pauses sending until drain and stream errors fail closed', async () => {
  const f = fixture();
  const first = f.helper.request(request); await first;
  const child = f.children[0], original = child.stdin.write.bind(child.stdin);
  let writes = 0;
  child.stdin.write = ((...args: Parameters<typeof child.stdin.write>) => { writes++; original(...args); return false; }) as typeof child.stdin.write;
  const second = f.helper.request(request), third = f.helper.request(request);
  await second; assert.equal(writes, 1);
  child.stdin.emit('drain'); await third; assert.equal(writes, 2); await f.finish();
  for (const stream of ['stdin', 'stdout', 'stderr'] as const) {
    const g = fixture('hang'); const pending = g.helper.request(request);
    const rejected = assert.rejects(pending);
    g.children[0][stream].destroy(new Error('injected stream error'));
    await rejected; assert.equal(g.helper.status, 'failed'); await assert.rejects(g.helper.request(request)); await g.finish();
  }
});

test('closing pending work marks closed immediately, shares its promise and bounds an unresponsive child', async () => {
  for (const behavior of ['no-ready', 'ignore-eof']) {
    const f = fixture(behavior);
    const pending = f.helper.request(request), rejected = assert.rejects(pending);
    // Ensure ignore-eof has entered its program before sending EOF.
    if (behavior === 'ignore-eof') await once(f.children[0].stdout, 'data');
    const started = performance.now(), closed = f.helper.close();
    assert.equal(f.helper.status, 'closed'); assert.equal(closed, f.helper.close());
    await rejected; await closed; assert.ok(performance.now() - started < 1500);
    await f.finish(); assert.equal(f.children.length, 1);
  }
});

test('an ACL rejection rejects only that request; it does not replay it or restart the helper', async () => {
  const f = fixture('reject');
  await assert.rejects(f.helper.request(request)); assert.equal(f.helper.status, 'ready');
  await assert.rejects(f.helper.request(request)); assert.equal(f.children.length, 1); await f.finish();
});

test('real Windows store checks stay off the event loop and fresh across repeated writes', { skip: process.platform !== 'win32' }, async t => {
  mkdirSync('.sandbox', { recursive: true }); const base = mkdtempSync(resolve('.sandbox/private-helper-native-'));
  const store = new HomeDashboardFileStore(join(base, "私有 ' literal $path"), () => {});
  try {
    await store.writePolicies({ schemaVersion: 1, policies: [] });
    let last = performance.now(), maximumLag = 0;
    const interval = setInterval(() => { const now = performance.now(); maximumLag = Math.max(maximumLag, now - last - 10); last = now; }, 10);
    const start = performance.now();
    try { for (let i = 0; i < 8; i++) await store.writePolicies({ schemaVersion: 1, policies: [] }); }
    finally { clearInterval(interval); }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 5000, `eight writes exceeded the publisher deadline: ${elapsed}`);
    assert.ok(maximumLag < 500, `shared event loop blocked: ${maximumLag}`);
    assert.deepEqual(JSON.parse(JSON.stringify(await store.readPolicies())), { schemaVersion: 1, policies: [] });
    t.diagnostic(`eight warmed writes=${elapsed.toFixed(1)}ms; max event-loop lag=${maximumLag.toFixed(1)}ms`);
  } finally { await store.close(); rmSync(base, { recursive: true, force: true }); }
});

test('owner loss across async ACL work cannot write secret bytes or commit a policy', { skip: process.platform !== 'win32' }, async () => {
  mkdirSync('.sandbox', { recursive: true }); const base = mkdtempSync(resolve('.sandbox/private-helper-owner-'));
  let owned = true; const root = join(base, 'store');
  const store = new HomeDashboardFileStore(root, () => { if (!owned) throw new Error('lost owner'); });
  try {
    const pending = store.writePolicies({ schemaVersion: 1, policies: [] }); owned = false;
    await assert.rejects(pending, /lost owner/); assert.equal(existsSync(join(root, 'policies.json')), false);
    if (existsSync(root)) for (const name of readdirSync(root)) assert.equal(readFileSync(join(root, name)).length, 0);
    const closed = store.close(); assert.equal(store.close(), closed); await closed;
  } finally { await store.close(); rmSync(base, { recursive: true, force: true }); }
});
