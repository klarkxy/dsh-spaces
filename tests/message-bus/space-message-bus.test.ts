import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SpaceMessageRouter } from '../../src/adapters/node/message-bus/router.ts';
import { BUS_CHANNEL, BUS_MAX_BYTES, busJson, parseBusMessage } from '../../src/shared/space-message-bus.ts';
const fixture = fileURLToPath(new URL('../fixtures/space-message-child.ts', import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0;
function command(child: ChildProcess, data: Record<string, unknown>): Promise<any> {
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error('test command timed out')); }, 5000);
    const receive = (m: any) => { if (m?.test === 'result' && m.id === id) { clearTimeout(timer); child.off('message', receive); resolve(m); } };
    child.on('message', receive); child.send({ ...data, id });
  });
}
async function setup() {
  const router = new SpaceMessageRouter();
  const children: ChildProcess[] = [];
  async function launch(id: string) {
    const child = fork(fixture, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.setMaxListeners(64); // Test commands intentionally wait concurrently on this fixture.
    children.push(child); router.attach(id, child);
    let errors = ''; child.stderr!.on('data', b => { errors += b; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child startup timed out: ${errors}`)), 5000);
      const receive = (m: any) => { if (m?.test === 'ready') { clearTimeout(timer); child.off('message', receive); resolve(); } };
      child.on('message', receive); child.once('error', reject);
    });
    return child;
  }
  const alpha = await launch('alpha'); const beta = await launch('beta');
  return { router, alpha, beta, launch, async close() {
    router.close();
    await Promise.all(children.map(async c => { if (c.exitCode === null && c.signalCode === null) { const done = once(c, 'exit'); c.kill(); await done; } }));
  } };
}
const request = (child: ChildProcess, operation = 'echo', params: unknown = {}, timeoutMs = 1000, target = 'beta') => command(child, { test: 'request', target, operation, params, timeoutMs });

test('two real Space processes route concurrent bidirectional requests with trusted identity', async () => {
  const s = await setup();
  try {
    const jobs = Array.from({ length: 30 }, (_, i) => request(i % 2 ? s.alpha : s.beta, 'echo', { value: String(i), delay: (30 - i) % 7 }, 2000, i % 2 ? 'beta' : 'alpha'));
    const results = await Promise.all(jobs);
    results.forEach((r, i) => { assert.equal(r.ok, true); assert.deepEqual(r.value, { value: String(i), caller: i % 2 ? 'alpha' : 'beta' }); });
    assert.equal(s.router.pendingCount, 0);
    assert.equal((await command(s.alpha, { test: 'counts' })).pending, 0);
  } finally { await s.close(); }
});

test('unknown target/operation, denied source and handler failures are explicit and do not leak errors', async () => {
  const s = await setup();
  try {
    for (const [op, target, code] of [['echo', 'missing', 'target-unavailable'], ['missing', 'beta', 'operation-not-found'], ['private', 'beta', 'unauthorized'], ['failure', 'beta', 'operation-failed'], ['bad-result', 'beta', 'operation-failed']]) {
      const r = await request(s.alpha, op, {}, 1000, target); assert.equal(r.ok, false); assert.equal(r.error, code);
    }
    assert.equal(s.router.pendingCount, 0);
  } finally { await s.close(); }
});

test('timeout and late reply release pending/timers without contaminating the next request', async () => {
  const s = await setup();
  try {
    assert.equal((await request(s.alpha, 'echo', { delay: 180, value: 'late' }, 30)).error, 'timeout');
    assert.equal((await request(s.alpha, 'hang', {}, 30)).error, 'timeout');
    await delay(220);
    assert.equal(s.router.pendingCount, 0);
    assert.equal((await command(s.alpha, { test: 'counts' })).pending, 0);
    assert.equal((await command(s.beta, { test: 'counts' })).active, 0);
    assert.equal((await request(s.alpha, 'echo', { value: 'fresh' })).value.value, 'fresh');
  } finally { await s.close(); }
});

test('disconnect/exit reject inflight calls and a new process with the same spaceId is a new session', async () => {
  const s = await setup();
  try {
    const pending = request(s.alpha, 'echo', { delay: 1000 }, 3000);
    await delay(40); s.beta.send({ test: 'disconnect' });
    assert.equal((await pending).error, 'disconnected'); assert.equal(s.router.pendingCount, 0);
    const replacement = await s.launch('beta');
    assert.equal((await request(s.alpha, 'echo', { value: 'new' })).value.value, 'new');
    const exiting = request(s.alpha, 'hang', {}, 3000);
    await delay(40); replacement.send({ test: 'exit' });
    assert.equal((await exiting).error, 'disconnected'); assert.equal(s.router.pendingCount, 0);
  } finally { await s.close(); }
});

test('caller exit cleans router work and cannot deliver old responses into a replacement caller', async () => {
  const s = await setup();
  try {
    s.alpha.send({ test: 'request', id: 'orphan', target: 'beta', operation: 'echo', params: { delay: 120 }, timeoutMs: 1000 });
    await delay(30); const exited = once(s.alpha, 'exit'); s.alpha.send({ test: 'exit' }); await exited;
    assert.equal(s.router.pendingCount, 0);
    const replacement = await s.launch('alpha');
    assert.equal((await request(replacement, 'echo', { value: 'current' })).value.value, 'current');
    await delay(150); assert.equal(s.router.pendingCount, 0);
  } finally { await s.close(); }
});

test('strict JSON and envelope boundaries reject identity spoofing and oversized/lossy data', () => {
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), [, 1], { x: undefined }, { get x() { throw new Error('must not execute getter'); } }, 'x'.repeat(BUS_MAX_BYTES + 1)]) assert.throws(() => busJson(value));
  let serialized = false;
  class CustomArray extends Array { toJSON() { serialized = true; return 'silently replaced'; } }
  const subclass = new CustomArray(); subclass.push(1); assert.throws(() => busJson(subclass));
  const customPrototype = [1]; Object.setPrototypeOf(customPrototype, { toJSON() { serialized = true; return 'replaced'; } });
  assert.throws(() => busJson(customPrototype)); assert.equal(serialized, false);
  const sparse: any = [, 1]; sparse.foo = 2; assert.throws(() => busJson(sparse));
  const decorated: any = [1]; decorated.foo = 2; assert.throws(() => busJson(decorated));
  const circular: any = {}; circular.x = circular; assert.throws(() => busJson(circular));
  const request = { channel: BUS_CHANNEL, kind: 'request', requestId: 'id', target: 'beta', operation: 'echo', params: {}, timeoutMs: 1 };
  assert.throws(() => parseBusMessage({ ...request, source: 'admin' }));
  assert.throws(() => parseBusMessage({ ...request, timeoutMs: 60001 }));
  assert.deepEqual(busJson({ a: [null, true, 4, '字'] }), { a: [null, true, 4, '字'] });
});

test('router rejects forged identities and stale/wrong-session responses without settling another call', async () => {
  const { EventEmitter } = await import('node:events');
  class Peer extends EventEmitter {
    connected = true;
    sent: any[] = [];
    send(message: unknown, cb: (error: Error | null) => void) { this.sent.push(message); cb(null); return true; }
  }
  const router = new SpaceMessageRouter(), caller = new Peer(), oldTarget = new Peer(), attacker = new Peer();
  router.attach('alpha', caller as unknown as ChildProcess);
  router.attach('beta', oldTarget as unknown as ChildProcess);
  router.attach('evil', attacker as unknown as ChildProcess);
  const req = { channel: BUS_CHANNEL, kind: 'request', requestId: 'same-local-id', target: 'beta', operation: 'echo', params: null, timeoutMs: 1000 };
  try {
    caller.emit('message', { ...req, source: 'admin' });
    assert.equal(caller.sent.pop().error, 'invalid-input'); assert.equal(oldTarget.sent.length, 0);
    caller.emit('message', req);
    const oldInvoke = oldTarget.sent[0];
    const response = { channel: BUS_CHANNEL, kind: 'response', requestId: oldInvoke.requestId, ok: true, value: 'forged' };
    attacker.emit('message', response); assert.equal(router.pendingCount, 1); assert.equal(caller.sent.length, 0);
    const target = new Peer(); router.attach('beta', target as unknown as ChildProcess);
    assert.equal(caller.sent.pop().error, 'disconnected'); assert.equal(oldTarget.listenerCount('message'), 0);
    caller.emit('message', req);
    oldTarget.emit('message', response); target.emit('message', response);
    assert.equal(router.pendingCount, 1); assert.equal(caller.sent.length, 0);
    target.emit('message', { ...response, requestId: target.sent[0].requestId, value: 'current' });
    assert.equal(caller.sent.pop().value, 'current'); assert.equal(router.pendingCount, 0);
  } finally { router.close(); }
  assert.equal(caller.listenerCount('message'), 0);
});

test('client close rejects pending calls and removes listeners; failed send also cleans pending', async () => {
  const { EventEmitter } = await import('node:events');
  const { SpaceMessageBus } = await import('../../packages/view-bridge/src/message-bus.ts');
  class Transport extends EventEmitter {
    connected = true;
    fail = false;
    send(_message: unknown, cb: (error: Error | null) => void) { cb(this.fail ? new Error('send failed') : null); return true; }
  }
  const transport = new Transport(), bus = new SpaceMessageBus(transport);
  const pending = bus.request('beta', 'echo', null);
  bus.close(); await assert.rejects(pending, { code: 'disconnected' });
  assert.equal(bus.pendingCount, 0); assert.equal(transport.listenerCount('message'), 0); assert.equal(transport.listenerCount('disconnect'), 0);
  const failing = new Transport(); failing.fail = true; const other = new SpaceMessageBus(failing);
  await assert.rejects(other.request('beta', 'echo', null), { code: 'disconnected' }); assert.equal(other.pendingCount, 0); other.close();
});

test('hung handlers remain admission-bounded even after their response timers expire', async () => {
  const { EventEmitter } = await import('node:events');
  const { SpaceMessageBus } = await import('../../packages/view-bridge/src/message-bus.ts');
  const { BUS_MAX_PENDING } = await import('../../src/shared/space-message-bus.ts');
  class Transport extends EventEmitter {
    connected = true;
    sent: any[] = [];
    send(message: unknown, cb: (error: Error | null) => void) { this.sent.push(message); cb(null); return true; }
  }
  const transport = new Transport(), bus = new SpaceMessageBus(transport);
  bus.handle('hang', ['alpha'], () => new Promise(() => {}));
  try {
    for (let i = 0; i < BUS_MAX_PENDING; i++) transport.emit('message', { channel: BUS_CHANNEL, kind: 'invoke', requestId: `id-${i}`, source: 'alpha', operation: 'hang', params: null, timeoutMs: 10 });
    await delay(25); assert.equal(bus.activeCount, 0);
    transport.emit('message', { channel: BUS_CHANNEL, kind: 'invoke', requestId: 'overflow', source: 'alpha', operation: 'hang', params: null, timeoutMs: 10 });
    assert.equal(transport.sent.at(-1).error, 'overloaded');
  } finally { bus.close(); }
});

test('static capabilities disclose only callable operations and stale discovery never grants access', async () => {
  const s = await setup();
  try {
    const allowed = await command(s.alpha, { test: 'capabilities', target: 'beta' });
    assert.equal(allowed.ok, true);
    assert.deepEqual(allowed.value.map((v: any) => v.operation), ['bad-result', 'echo', 'failure', 'hang']);
    assert.equal(allowed.value.find((v: any) => v.operation === 'echo').description, 'Echo a value and the trusted caller.');
    const limited = await command(s.beta, { test: 'capabilities', target: 'alpha' });
    assert.deepEqual(limited.value, [{ operation: 'echo', description: 'Echo a value and the trusted caller.' }]);
    assert.equal((await request(s.alpha, 'private')).error, 'unauthorized');
    assert.equal((await command(s.alpha, { test: 'capabilities', target: 'missing' })).error, 'target-unavailable');
    assert.equal((await request(s.alpha, 'spaces.capabilities', { source: 'admin' })).error, 'invalid-input');
    await command(s.beta, { test: 'dispose-echo' });
    assert.equal((await request(s.alpha, 'echo')).error, 'operation-not-found');
    assert.equal((await command(s.alpha, { test: 'capabilities', target: 'beta' })).value.some((v: any) => v.operation === 'echo'), false);
  } finally { await s.close(); }
});

test('static declarations are detached, reserved names rejected, and the maximal catalog fits one envelope', async () => {
  const { EventEmitter } = await import('node:events');
  const { SpaceMessageBus } = await import('../../packages/view-bridge/src/message-bus.ts');
  const { BUS_MAX_OPERATIONS, parseSpaceCapabilities } = await import('../../src/shared/space-message-bus.ts');
  class Transport extends EventEmitter {
    connected = true;
    sent: any[] = [];
    send(message: unknown, cb: (error: Error | null) => void) { this.sent.push(message); cb(null); return true; }
  }
  const transport = new Transport(), bus = new SpaceMessageBus(transport);
  try {
    assert.throws(() => bus.handle('spaces.capabilities', ['alpha'], () => null), { code: 'invalid-input' });
    assert.throws(() => bus.handle('bad', ['alpha'], () => null, { description: '\u0000'.repeat(50) }), { code: 'invalid-input' });
    assert.throws(() => bus.handle('bad', ['alpha'], () => null, { description: 'good', secret: true } as never), { code: 'invalid-input' });
    const declaration = { description: 'Initial description' }, allowed = ['alpha'];
    const dispose = bus.handle('first', allowed, () => null, declaration);
    declaration.description = 'Mutated'; allowed[0] = 'intruder';
    transport.emit('message', { channel: BUS_CHANNEL, kind: 'invoke', requestId: 'first-query', source: 'alpha', operation: 'spaces.capabilities', params: null, timeoutMs: 1000 });
    assert.deepEqual(transport.sent.pop().value, [{ operation: 'first', description: 'Initial description' }]);
    dispose();
    for (let i = 0; i < BUS_MAX_OPERATIONS; i++) bus.handle(`${String(i).padStart(3, '0')}${'a'.repeat(125)}`, ['alpha'], () => null, { description: 'x'.repeat(254) });
    assert.throws(() => bus.handle('overflow', [], () => null), { code: 'overloaded' });
    transport.emit('message', { channel: BUS_CHANNEL, kind: 'invoke', requestId: 'max-query', source: 'alpha', operation: 'spaces.capabilities', params: null, timeoutMs: 1000 });
    const response = transport.sent.pop(); assert.ok(parseBusMessage(response)); assert.equal(parseSpaceCapabilities(response.value).length, BUS_MAX_OPERATIONS);
    for (const invalid of [[{ operation: 'spaces.capabilities', description: '' }], [{ operation: 'echo', description: '', secret: true }], [{ operation: 'echo', description: '' }, { operation: 'echo', description: '' }]]) assert.throws(() => parseSpaceCapabilities(invalid));
  } finally { bus.close(); }
});
