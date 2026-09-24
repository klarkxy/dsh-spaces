const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const build = process.env.DSH_DASHBOARD_TEST_BUILD;
if (!build) throw new Error('Run node scripts/test-dashboard-core.mjs');
const load = name => require(join(build, 'src/core/domain/dashboard', `${name}.js`));
const V = load('validation');
const { DashboardFault, publicError } = load('errors');
const { DASHBOARD_LIMITS: L, RECEIPT_RETENTION_MS } = load('limits');
const { preparePublication, readProjection } = load('projection');
const { emptyLayout, prepareLayout, readReceipt, parseLayoutDocument } = load('boards');
const { PublicationChannel, HomePublisher, createBoundProviderRegistry } = load('provider');
const { DashboardReadSession } = load('read-session');
const clone = value => JSON.parse(JSON.stringify(value));
const now = Date.parse('2026-09-25T03:00:00Z');
const time = n => new Date(now + n).toISOString();
const fault = (fn, code) => assert.throws(fn, error => error instanceof DashboardFault && error.code === `dashboard/${code}`);
const rejected = (promise, code) => assert.rejects(promise, error => error instanceof DashboardFault && error.code === `dashboard/${code}`);
function snapshot() {
  return { types: [{ typeId: 'chapters', version: 1, kind: 'progress', title: '章节进度' }], instances: [{
    instanceId: 'story', typeId: 'chapters', typeVersion: 1, title: '长篇作品',
    content: { kind: 'progress', value: 3, max: 10, unit: '章', status: 'running' },
    sourceTarget: { kind: 'session', id: 'session-1' }, updatedAt: time(0), staleAfterSeconds: 30,
  }] };
}
const binding = (space = 'writing', run = 'run-1', selection = { kind: 'all' }) => ({ spaceId: space, providerId: 'author', runId: run, grantRevision: 'grant-1', selection });
const request = (sequence = 1, data = snapshot(), changes = {}) => ({ protocolVersion: 1, runId: 'run-1', providerId: 'author', sequence, grantRevision: 'grant-1', ...data, ...changes });
const ref = (changes = {}) => ({ spaceId: 'writing', providerId: 'author', instanceId: 'story', ...changes });
const placement = (changes = {}) => ({ id: 'p1', ref: ref(), x: 0, y: 0, w: 6, h: 2, ...changes });
const mutation = (command, changes = {}) => ({ requestId: 'request-1', issuedAt: time(0), backendEpoch: 'epoch-1', command, ...changes });
const create = (changes = {}) => mutation({ kind: 'board.create', boardId: 'home', title: '首页', placements: [placement()] }, changes);
const ctx = (changes = {}) => ({ backendEpoch: 'epoch-1', subjectId: 'user-1', now, newRevision: 'board-r1', canRead: () => true, ...changes });
const published = () => preparePublication(null, request(), binding(), time(0)).projection;
const saved = () => prepareLayout(emptyLayout(), create(), ctx()).document;
const ack = req => ({ protocolVersion: 1, runId: req.runId, providerId: req.providerId, sequence: req.sequence, receivedAt: time(0), accepted: true });
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
class Clock {
  constructor() { this.now = 0; this.id = 0; this.tasks = new Map(); }
  set = (callback, delay) => { const id = ++this.id; this.tasks.set(id, { callback, due: this.now + delay }); return id; };
  clear = id => { this.tasks.delete(id); };
  async tick(amount) {
    await flush();
    const until = this.now + amount;
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      this.now = next[1].due; this.tasks.delete(next[0]); next[1].callback(); await flush();
    }
    this.now = until; await flush();
  }
}

// These are unit/domain checks corresponding to portions of Dxx, not full Dxx integration acceptance.
test('D14 JSON: duplicate decoded keys are rejected before overwrite', () => {
  for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}']) fault(() => V.parseStrictJson(input), 'invalid-input');
});
test('D14 JSON: invalid syntax, BOM, encoding, nonfinite and trailing data fail closed', () => {
  for (const input of ['', '{', '[]true', '{"x":}', '[1,]', '{"x":1,}', '01', 'NaN', '1e999', '"\\ud800"', '"\\udc00"', '\ufeff{}', '"\n"']) fault(() => V.parseStrictJson(input), 'invalid-input');
  fault(() => V.parseStrictJson(Uint8Array.of(0xff)), 'invalid-input');
  fault(() => V.parseStrictJson(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d)), 'invalid-input');
});
test('D14 JSON: valid values, escaped pairs, negative zero and object ordering', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(V.parseStrictJson(' {"b":[true,false,null,-0,1.5e2],"a":"\\ud83d\\ude00"} '))), { b: [true, false, null, 0, 150], a: '😀' });
  assert.equal(V.canonicalJson({ b: 2, a: 1 }), V.canonicalJson({ a: 1, b: 2 }));
  assert.notEqual(V.canonicalJson([1, 2]), V.canonicalJson([2, 1]));
});
test('D22 JSON: byte/depth limits are enforced on both sides', () => {
  assert.equal(V.parseStrictJson('"界"', 5), '界');
  fault(() => V.parseStrictJson('"界"', 4), 'limit-exceeded');
  assert.ok(V.parseStrictJson('['.repeat(64) + '0' + ']'.repeat(64)));
  fault(() => V.parseStrictJson('['.repeat(65) + '0' + ']'.repeat(65)), 'invalid-input');
  assert.ok(V.parseStrictJson('{}' + ' '.repeat(L.maxRequestBytes - 2)));
  fault(() => V.parseStrictJson('{}' + ' '.repeat(L.maxRequestBytes - 1)), 'limit-exceeded');
});
test('D14 object input: reject accessors, cycles, exotic prototypes, sparse arrays and symbols', () => {
  let called = false; const getter = { get kind() { called = true; return 'overview'; } };
  fault(() => V.parseQuery(getter), 'invalid-input'); assert.equal(called, false);
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, new Date(), new Map(), [, 1], { [Symbol()]: 1 }, { kind: undefined }]) fault(() => V.canonicalJson(value), 'invalid-input');
});
test('D13 publish: identity cannot be supplied in the body', () => {
  for (const key of ['spaceId', 'homeId', 'token']) fault(() => V.parsePublishRequest({ ...request(), [key]: 'forged' }), 'invalid-input');
  fault(() => V.parsePublishRequest({ ...request(), protocolVersion: 2 }), 'unsupported-version');
});
test('D08 snapshots: all four built-in kinds validate', () => {
  for (const content of [{ kind: 'progress', value: 0, max: 1, unit: '', status: 'waiting' }, { kind: 'metric', value: -2.5, unit: 's' }, { kind: 'list', items: [{ id: 'a', label: 'Review', state: 'blocked' }] }, { kind: 'markdown', text: '# Notes\n**Ready**' }]) {
    const data = snapshot(); data.types[0].kind = content.kind; data.instances[0].content = content;
    assert.equal(V.parseSnapshot(data).instances[0].content.kind, content.kind);
  }
});
test('D08 snapshots: references, duplicates, missing/unknown fields and unused wire types fail', () => {
  const variants = [data => data.instances[0].typeVersion++, data => data.instances[0].typeId = 'missing', data => data.types.push(clone(data.types[0])), data => data.instances.push(clone(data.instances[0])), data => delete data.instances[0].title, data => data.instances[0].secret = 'no'];
  for (const change of variants) { const data = snapshot(); change(data); fault(() => V.parseSnapshot(data), 'invalid-input'); }
  const empty = snapshot(); empty.instances = [];
  assert.equal(V.parseSnapshot(empty).types.length, 1);
  fault(() => V.parsePublishRequest(request(1, empty)), 'invalid-input');
});
test('D08 snapshots: invalid values reject the ENTIRE provider snapshot', () => {
  for (const change of [c => c.value = -1, c => c.value = 11, c => c.max = 0, c => c.value = Infinity, c => c.status = 'approved']) {
    const data = snapshot(); data.instances.push({ ...clone(data.instances[0]), instanceId: 'bad' }); change(data.instances[1].content);
    fault(() => V.parseSnapshot(data), 'invalid-input'); assert.equal(data.instances[0].content.value, 3);
  }
});
test('D15 snapshots: raw HTML and nonlogical navigation are refused', () => {
  const data = snapshot(); data.types[0].kind = 'markdown'; data.instances[0].content = { kind: 'markdown', text: '<script>fetch("https://example.com")</script>' };
  fault(() => V.parseSnapshot(data), 'invalid-input');
  for (const target of [{ kind: 'url', url: 'file:///secret' }, { kind: 'space', path: '../secret' }, { kind: 'artifact', id: 'x', token: 'secret' }]) {
    const value = snapshot(); value.instances[0].sourceTarget = target; fault(() => V.parseSnapshot(value), 'invalid-input');
  }
});
test('D22 snapshots: exact UTF-8 content size limit and instance/type counts', () => {
  const data = snapshot(); data.types[0].kind = 'markdown';
  const overhead = V.byteLength(JSON.stringify({ kind: 'markdown', text: '' }));
  data.instances[0].content = { kind: 'markdown', text: 'x'.repeat(L.maxContentBytes - overhead) };
  assert.ok(V.parseSnapshot(data)); data.instances[0].content.text += 'x'; fault(() => V.parseSnapshot(data), 'limit-exceeded');
  const many = snapshot(); many.instances = Array.from({ length: 100 }, (_, i) => ({ ...clone(many.instances[0]), instanceId: String(i) }));
  assert.equal(V.parseSnapshot(many).instances.length, 100); many.instances.push({ ...clone(many.instances[0]), instanceId: 'extra' }); fault(() => V.parseSnapshot(many), 'limit-exceeded');
});
test('timestamp/ID checks reject invalid dates and controls without echoing values', () => {
  for (const value of ['2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00']) fault(() => V.timestampMillis(value), 'invalid-input');
  assert.equal(V.timestampMillis('2026-09-25T12:00:00+09:00'), now);
  fault(() => V.identifier('x\ny'), 'invalid-input');
  assert.equal(V.identifier('😀'.repeat(128)), '😀'.repeat(128)); fault(() => V.identifier('😀'.repeat(129)), 'limit-exceeded');
  assert.ok(!JSON.stringify(publicError(new Error('secret-token-content'))).includes('secret'));
});
test('D22 queries: 50 unique refs, empty filters, closed operations', () => {
  assert.deepEqual(V.parseQuery({ kind: 'catalog', spaceIds: [] }).spaceIds, []);
  const refs = Array.from({ length: 50 }, (_, i) => ref({ instanceId: String(i) })); assert.equal(V.parseQuery({ kind: 'instances', refs }).refs.length, 50);
  fault(() => V.parseQuery({ kind: 'instances', refs: [...refs, ref({ instanceId: 'extra' })] }), 'limit-exceeded');
  fault(() => V.parseQuery({ kind: 'instances', refs: [ref(), ref()] }), 'invalid-input');
  fault(() => V.parseQuery({ kind: 'action.execute' }), 'unsupported-operation');
  fault(() => V.parseQuery({ kind: 'overview', writable: true }), 'invalid-input');
  fault(() => V.parseQuery({ kind: 'catalog', spaceIds: ['x', 'x'] }), 'invalid-input');
});
test('publication selection and heartbeat schemas do not imply authority', () => {
  assert.equal(V.parseSelection(null), null); assert.deepEqual(V.parseSelection({ kind: 'all' }), { kind: 'all' });
  for (const value of [{ kind: 'selected', instanceIds: [] }, { kind: 'selected', instanceIds: ['a', 'a'] }, { kind: 'all', instanceIds: ['a'] }]) fault(() => V.parseSelection(value), 'invalid-input');
  assert.equal(V.parseHeartbeat({ protocolVersion: 1, runId: 'r', providers: [{ providerId: 'p', lastSequence: 0, state: 'ready' }] }).providers[0].lastSequence, 0);
  fault(() => V.parseHeartbeat({ protocolVersion: 1, runId: 'r', providers: [{ providerId: 'p', lastSequence: -1, state: 'ready' }] }), 'invalid-input');
});

test('D07 projections: first sequence 1, full-snapshot gaps allowed, old run refused', () => {
  fault(() => preparePublication(null, request(2), binding(), time(0)), 'stale-sequence');
  const first = published(); const next = preparePublication(first, request(7), binding(), time(2000));
  assert.equal(next.projection.request.sequence, 7); assert.equal(first.request.sequence, 1);
  fault(() => preparePublication(next.projection, request(2), binding(), time(3000)), 'stale-sequence');
  const newRun = binding('writing', 'run-2');
  fault(() => preparePublication(next.projection, request(8), newRun, time(3000)), 'stale-run');
  assert.equal(preparePublication(first, request(1, snapshot(), { runId: 'run-2' }), newRun, time(3000)).projection.request.sequence, 1);
});
test('D07 projections: duplicate returns ORIGINAL ack without refreshing timestamp', () => {
  const first = published(); const input = request(); const same = Object.fromEntries(Object.entries(input).reverse());
  const duplicate = preparePublication(first, same, binding(), time(5000));
  assert.equal(duplicate.changed, false); assert.equal(duplicate.ack.receivedAt, time(0));
  const different = request(); different.instances[0].content.value = 4;
  fault(() => preparePublication(first, different, binding(), time(5000)), 'sequence-conflict');
});
test('D13 projections: provider/run/grant/selection checked against bound authority', () => {
  fault(() => preparePublication(null, request(), { ...binding(), providerId: 'other' }, time(0)), 'forbidden');
  fault(() => preparePublication(null, request(), { ...binding(), grantRevision: 'new' }, time(0)), 'stale-grant');
  fault(() => preparePublication(null, request(), binding('writing', 'run-1', null), time(0)), 'stale-grant');
  fault(() => preparePublication(null, request(), binding('writing', 'run-1', { kind: 'selected', instanceIds: ['other'] }), time(0)), 'forbidden');
});
test('D03/D08 pure projections: two spaces advance independently, bad source leaves other unchanged', () => {
  const a = published(); const b = preparePublication(null, request(), binding('coding'), time(0)).projection;
  const next = preparePublication(a, request(2), binding(), time(1000)).projection;
  const bad = request(3); bad.instances[0].content.max = 0;
  fault(() => preparePublication(next, bad, binding(), time(2000)), 'invalid-input');
  assert.equal(next.request.sequence, 2); assert.equal(b.request.sequence, 1); assert.equal(b.spaceId, 'coding');
});
test('D04/D12 projections: offline cached data versus revoked data remain distinct', () => {
  const projection = published(); const access = binding();
  const observation = { now: now + 5000, sourceState: 'stopped', lastActivityAt: now };
  const offline = readProjection(projection, ref(), access, observation);
  assert.equal(offline.state, 'present'); assert.equal(offline.freshness, 'stale'); assert.equal(offline.sourceState, 'stopped');
  assert.deepEqual(readProjection(projection, ref(), { ...access, selection: null }, observation), { state: 'unavailable', ref: ref(), reason: 'not-found' });
  assert.equal(readProjection(projection, ref(), { ...access, grantRevision: 'changed' }, observation).state, 'unavailable');
});
test('D04 projections: heartbeat cannot extend content freshness; source loss makes static content stale', () => {
  const projection = published(); const access = binding();
  assert.equal(readProjection(projection, ref(), access, { now: now + 29999, sourceState: 'running', lastActivityAt: now + 29999 }).freshness, 'current');
  assert.equal(readProjection(projection, ref(), access, { now: now + 30000, sourceState: 'running', lastActivityAt: now + 30000 }).freshness, 'stale');
  projection.request.instances[0].staleAfterSeconds = null;
  assert.equal(readProjection(projection, ref(), access, { now: now + 50000, sourceState: 'running', lastActivityAt: now }).freshness, 'stale');
});
test('D11 projections: intentional empty snapshot removes display, not source data', () => {
  const source = snapshot(); const empty = preparePublication(published(), request(2, { types: [], instances: [] }), binding(), time(1000)).projection;
  assert.equal(readProjection(empty, ref(), binding(), { now, sourceState: 'running', lastActivityAt: now }).reason, 'source-removed');
  assert.equal(source.instances.length, 1);
});
test('projection inputs/acks are copied; caller mutation does not corrupt stored candidate', () => {
  const input = request(); const result = preparePublication(null, input, binding(), time(0)); input.instances[0].title = 'changed'; result.ack.sequence = 99;
  assert.equal(result.projection.request.instances[0].title, '长篇作品'); assert.equal(result.projection.ack.sequence, 1);
});

test('D05/D06 layouts: two writers using same revision have one winner; data sequence is separate', () => {
  const first = saved(); const replace = mutation({ kind: 'board.replace', boardId: 'home', expectedRevision: 'board-r1', title: 'Updated', placements: [placement()] }, { requestId: 'request-2' });
  const winner = prepareLayout(first, replace, ctx({ newRevision: 'board-r2' }));
  fault(() => prepareLayout(winner.document, { ...replace, requestId: 'request-3' }, ctx({ newRevision: 'board-r3' })), 'revision-conflict');
  assert.equal(first.boards[0].revision, 'board-r1'); assert.equal(winner.document.boards[0].revision, 'board-r2');
  preparePublication(published(), request(2), binding(), time(1000)); assert.equal(winner.document.boards[0].revision, 'board-r2');
});
test('D06 layouts: different boards have independent CAS', () => {
  const first = saved(); const add = create({ requestId: 'other' }); add.command.boardId = 'other';
  const second = prepareLayout(first, add, ctx({ newRevision: 'other-r1' })).document;
  const changed = prepareLayout(second, mutation({ kind: 'board.replace', boardId: 'other', expectedRevision: 'other-r1', title: 'Other', placements: [] }, { requestId: 'other-update' }), ctx({ newRevision: 'other-r2' }));
  assert.equal(changed.document.boards.find(board => board.id === 'home').revision, 'board-r1');
});
test('D09 layouts: same request is idempotent after time window, different intent/subject conflicts', () => {
  const first = saved(); const same = prepareLayout(first, create(), ctx({ now: now + 600000, newRevision: 'not-used' }));
  assert.equal(same.changed, false); assert.equal(same.receipt.result.board.revision, 'board-r1'); assert.equal(same.document.receipts.length, 1);
  const other = create(); other.command.title = 'Different'; fault(() => prepareLayout(first, other, ctx()), 'request-conflict');
  fault(() => prepareLayout(first, create(), ctx({ subjectId: 'user-2' })), 'request-conflict');
});
test('D09 layouts: stale epoch cannot execute; receipt query remains read-only across epochs', () => {
  const first = saved(); fault(() => prepareLayout(first, create(), ctx({ backendEpoch: 'epoch-2' })), 'stale-epoch');
  assert.equal(readReceipt(first, 'request-1', ctx()).backendEpoch, 'epoch-1');
  assert.equal(readReceipt(first, 'missing', ctx()), null); assert.equal(first.receipts.length, 1);
});
test('D09 layouts: request expiry/future clock and retention boundary cannot replay writes', () => {
  fault(() => prepareLayout(emptyLayout(), create(), ctx({ now: now + 300001 })), 'request-expired');
  fault(() => prepareLayout(emptyLayout(), create(), ctx({ now: now - 300001 })), 'request-expired');
  assert.equal(prepareLayout(emptyLayout(), create(), ctx({ now: now + 300000 })).changed, true);
  const first = saved(); assert.ok(readReceipt(first, 'request-1', ctx({ now: now + RECEIPT_RETENTION_MS - 1 })));
  assert.equal(readReceipt(first, 'request-1', ctx({ now: now + RECEIPT_RETENTION_MS })), null);
  fault(() => prepareLayout(first, create(), ctx({ now: now + RECEIPT_RETENTION_MS })), 'request-expired');
});
test('D11 layouts: duplicate instance placements are independent; deleted board IDs are not reused', () => {
  const req = create(); req.command.placements.push(placement({ id: 'p2', x: 6 }));
  const first = prepareLayout(emptyLayout(), req, ctx()).document; assert.equal(first.boards[0].placements.length, 2);
  const removal = mutation({ kind: 'board.delete', boardId: 'home', expectedRevision: 'board-r1' }, { requestId: 'delete' });
  const deleted = prepareLayout(first, removal, ctx({ newRevision: 'deleted-r2' })).document;
  assert.equal(deleted.boards.length, 0); assert.equal(deleted.tombstones.length, 1); assert.equal(snapshot().instances.length, 1);
  fault(() => prepareLayout(deleted, create({ requestId: 'recreate' }), ctx()), 'revision-conflict');
});
test('D12 layouts: new refs require authorization; unchanged unavailable refs may be rearranged', () => {
  fault(() => prepareLayout(emptyLayout(), create(), ctx({ canRead: () => false })), 'not-found');
  const first = saved(); const edit = mutation({ kind: 'board.replace', boardId: 'home', expectedRevision: 'board-r1', title: 'Reordered', placements: [placement({ y: 5 })] }, { requestId: 'edit' });
  const candidate = prepareLayout(first, edit, ctx({ canRead: () => false, newRevision: 'r2' }));
  assert.equal(candidate.document.boards[0].placements.length, 1); assert.equal(candidate.receipt.result.board.placements.length, 0);
  edit.command.placements[0].ref.instanceId = 'new'; fault(() => prepareLayout(first, edit, ctx({ canRead: () => false, newRevision: 'r2' })), 'not-found');
});
test('D12 receipts: revoked refs are filtered on every read and duplicate response', () => {
  const first = saved(); const denied = ctx({ canRead: () => false });
  assert.equal(readReceipt(first, 'request-1', denied).result.board.placements.length, 0);
  assert.equal(prepareLayout(first, create(), denied).receipt.result.board.placements.length, 0);
  assert.equal(readReceipt(first, 'request-1', ctx({ subjectId: 'different' })), null);
  assert.equal(first.receipts[0].receipt.result.board.placements.length, 1);
});
test('D14/D22 layout: overlap, bounds, duplicate IDs and placement quotas reject', () => {
  for (const placements of [[placement(), placement({ id: 'p2', x: 5 })], [placement({ x: 7 })], [placement({ y: 9999, h: 2 })], [placement({ w: 0 })], [placement({ x: 0.5 })], [placement(), placement({ x: 6 })]]) {
    const req = create(); req.command.placements = placements; fault(() => V.parseBoardMutation(req), 'invalid-input');
  }
  const req = create(); req.command.placements = Array.from({ length: 200 }, (_, i) => placement({ id: String(i), y: i * 2 }));
  assert.equal(V.parseBoardMutation(req).command.placements.length, 200); req.command.placements.push(placement({ id: 'extra', y: 401 })); fault(() => V.parseBoardMutation(req), 'limit-exceeded');
});
test('D16 layout disk decoder: corrupted/unknown schema is never replaced with an empty board', () => {
  for (const input of ['{', '{}', '{"schemaVersion":1,"schemaVersion":1,"boards":[],"receipts":[],"tombstones":[]}']) fault(() => parseLayoutDocument(input), 'invalid-input');
  fault(() => parseLayoutDocument({ ...emptyLayout(), schemaVersion: 2 }), 'unsupported-version');
  const doc = saved(); doc.receipts[0].receipt.result.board.title = 'corrupt'; fault(() => parseLayoutDocument(doc), 'invalid-input');
  assert.deepEqual(parseLayoutDocument(JSON.stringify(emptyLayout())), emptyLayout());
});
test('D22 layouts: unexpired receipt capacity rejects new mutations without changing input', () => {
  const first = saved(); const next = create({ requestId: 'second' }); next.command.boardId = 'second';
  fault(() => prepareLayout(first, next, ctx(), { ...L, maxReceipts: 1 }), 'unavailable');
  assert.equal(first.boards.length, 1); assert.equal(first.receipts.length, 1);
});
test('D16 pure candidate: layout and receipt are prepared together and caller state is untouched', () => {
  const before = emptyLayout(); const result = prepareLayout(before, create(), ctx());
  assert.equal(before.boards.length, 0); assert.equal(result.document.boards.length, 1); assert.equal(result.document.receipts.length, 1);
  result.receipt.result.board.title = 'UI mutation'; assert.equal(result.document.receipts[0].receipt.result.board.title, '首页');
});

test('D02 local registry works without Home and keeps local and Home results separate', async () => {
  let committed; const registry = createBoundProviderRegistry({ commit: async data => { committed = data; return 'local-1'; }, remove: async () => {} });
  const handle = registry.register({ types: snapshot().types, snapshot: () => snapshot().instances });
  assert.deepEqual(await handle.publish(), { localRevision: 'local-1', home: { state: 'not-configured' } }); assert.equal(committed.instances.length, 1);
  fault(() => registry.register({ types: [], snapshot: () => [] }), 'request-conflict'); await handle.dispose();
});
test('D02 registry: invalid/source-failed local snapshot never emits a fake empty publication', async () => {
  let writes = 0; const registry = createBoundProviderRegistry({ commit: async () => { writes++; return 'r'; }, remove: async () => {} });
  const handle = registry.register({ types: snapshot().types, snapshot: () => { throw new Error('secret source error'); } });
  await rejected(handle.publish(), 'unavailable'); await rejected(handle.publish(), 'unavailable'); assert.equal(writes, 0); await handle.dispose();
});
test('D08 registry: slow snapshots serialize and a burst shares ONE trailing snapshot', async () => {
  let release; let count = 0; let value = 1; const seen = [];
  const registry = createBoundProviderRegistry({ commit: async data => { seen.push(data.instances[0].content.value); return `local-${seen.length}`; }, remove: async () => {} });
  const handle = registry.register({ types: snapshot().types, snapshot: async () => { const current = value; if (++count === 1) await new Promise(resolve => { release = resolve; }); const data = snapshot().instances; data[0].content.value = current; return data; } });
  const first = handle.publish(); await flush(); value = 2;
  const second = handle.publish(); const third = handle.publish(); assert.strictEqual(second, third);
  release(); await Promise.all([first, second, third]); assert.deepEqual(seen, [1, 2]); assert.equal(count, 2); await handle.dispose();
});
test('D12 publisher sends only selected instances and their referenced type titles', async () => {
  let sent; const channel = new PublicationChannel(async req => { sent = req; return ack(req); });
  const publisher = new HomePublisher({ ...binding(), selection: { kind: 'selected', instanceIds: ['story'] } }, channel);
  const data = snapshot(); data.types.push({ typeId: 'secret-type', version: 1, title: 'Private', kind: 'metric' });
  data.instances.push({ ...clone(data.instances[0]), instanceId: 'secret', typeId: 'secret-type', content: { kind: 'metric', value: 42, unit: '' } });
  assert.deepEqual(await publisher.publish(data), { state: 'published', sequence: 1 }); assert.equal(sent.instances.length, 1); assert.equal(sent.types.length, 1); assert.ok(!JSON.stringify(sent).includes('Private')); channel.close();
});
test('D09 publisher: an accepted publication whose ACK is lost is NOT resent', async () => {
  let calls = 0; let accepted; const channel = new PublicationChannel(async req => { calls++; accepted = req; throw new Error('connection lost'); });
  const publisher = new HomePublisher(binding(), channel);
  assert.equal((await publisher.publish(snapshot())).state, 'failed'); assert.equal((await publisher.publish(snapshot())).state, 'failed');
  assert.equal(calls, 1); assert.equal(accepted.sequence, 1); channel.close();
});
test('D10 run failure stops other providers, but a stale grant only stops its provider', async () => {
  const calls = []; const channel = new PublicationChannel(async req => { calls.push(req.providerId); if (req.providerId === 'bad') throw new DashboardFault('dashboard/stale-grant'); return ack(req); });
  const bad = new HomePublisher({ ...binding(), providerId: 'bad' }, channel); const good = new HomePublisher(binding(), channel);
  assert.equal((await bad.publish(snapshot())).state, 'failed'); assert.equal((await good.publish(snapshot())).state, 'published'); assert.equal((await bad.publish(snapshot())).state, 'failed'); assert.deepEqual(calls, ['bad', 'author']); channel.close();
  let count = 0; const failed = new PublicationChannel(async () => { count++; throw new DashboardFault('dashboard/unauthenticated'); });
  const a = new HomePublisher(binding(), failed), b = new HomePublisher({ ...binding(), providerId: 'other' }, failed);
  await a.publish(snapshot()); await b.publish(snapshot()); assert.equal(count, 1); failed.close();
});
test('D10 publisher: timeout aborts, ends the run, and produces no later network calls', async () => {
  const clock = new Clock(); let calls = 0, signal;
  const channel = new PublicationChannel(async (_request, incoming) => { calls++; signal = incoming; return new Promise(() => {}); }, clock);
  const publisher = new HomePublisher(binding(), channel); const result = publisher.publish(snapshot()); await clock.tick(5000);
  assert.equal((await result).state, 'failed'); assert.equal(signal.aborted, true); await publisher.publish(snapshot()); await clock.tick(60000); assert.equal(calls, 1); assert.equal(clock.tasks.size, 0);
});
test('D10 publisher: mismatched confirmation fails instead of claiming Home success', async () => {
  let calls = 0; const channel = new PublicationChannel(async req => { calls++; return { ...ack(req), providerId: 'forged' }; }); const publisher = new HomePublisher(binding(), channel);
  assert.equal((await publisher.publish(snapshot())).state, 'failed'); await publisher.publish(snapshot()); assert.equal(calls, 1); channel.close();
});
test('D02 local business projections continue after Home fails without reconnecting', async () => {
  let sends = 0, commits = 0;
  const channel = new PublicationChannel(async () => { sends++; throw new Error('network'); }); const home = new HomePublisher(binding(), channel);
  const handle = createBoundProviderRegistry({ commit: async () => `local-${++commits}`, remove: async () => {} }, home).register({ types: snapshot().types, snapshot: () => snapshot().instances });
  assert.equal((await handle.publish()).home.state, 'failed'); assert.equal((await handle.publish()).localRevision, 'local-2'); assert.equal(commits, 2); assert.equal(sends, 1); await handle.dispose(); channel.close();
});
test('D11 normal disposal sends one empty snapshot only on a healthy channel and releases once', async () => {
  const sent = []; let removed = 0; const channel = new PublicationChannel(async req => { sent.push(req); return ack(req); });
  const handle = createBoundProviderRegistry({ commit: async () => 'local', remove: async () => { removed++; } }, new HomePublisher(binding(), channel)).register({ types: snapshot().types, snapshot: () => snapshot().instances });
  await handle.publish(); await handle.dispose(); await handle.dispose(); assert.equal(removed, 1); assert.equal(sent.length, 2); assert.deepEqual(sent[1].instances, []); assert.deepEqual(sent[1].types, []); await rejected(handle.publish(), 'unavailable'); channel.close();
});
test('D10 channel closed before sending does not invoke its transport', async () => {
  let calls = 0; const channel = new PublicationChannel(async req => { calls++; return ack(req); }); const result = channel.request(request()); channel.close(); await rejected(result, 'unavailable'); assert.equal(calls, 0);
});

test('D10 read session polls only after success; failure is terminal with 60s memory expiry', async () => {
  const clock = new Clock(); let calls = 0, clears = 0; const values = [], errors = [];
  const session = new DashboardReadSession({ timer: clock, read: async () => { if (++calls === 1) return 'value'; throw new Error('secret'); }, onValue: value => values.push(value), onFailure: error => errors.push(error), clearSensitive: () => clears++ });
  session.start(); await clock.tick(0); assert.deepEqual(values, ['value']); assert.equal(session.state, 'active');
  await clock.tick(2000); assert.equal(session.state, 'failed'); assert.equal(calls, 2); assert.equal(clears, 0);
  await clock.tick(60000); assert.equal(clears, 1); assert.equal(calls, 2); fault(() => session.start(), 'unavailable'); assert.equal(errors.length, 1);
});
test('D20 read session hides data immediately on auth failure', async () => {
  for (const code of ['dashboard/unauthenticated', 'dashboard/forbidden']) {
    const clock = new Clock(); let clears = 0;
    const session = new DashboardReadSession({ timer: clock, read: async () => { throw new DashboardFault(code); }, onValue: () => assert.fail('no value'), onFailure: () => {}, clearSensitive: () => clears++ });
    session.start(); await clock.tick(0); assert.equal(clears, 1); assert.equal(clock.tasks.size, 0); assert.equal(session.state, 'failed');
  }
});
test('D10 read session timeout aborts, ignores late response, never restarts polling', async () => {
  const clock = new Clock(); let finish, signal, calls = 0, values = 0;
  const session = new DashboardReadSession({ timer: clock, read: incoming => { signal = incoming; calls++; return new Promise(resolve => { finish = resolve; }); }, onValue: () => values++, onFailure: () => {}, clearSensitive: () => {} });
  session.start(); await clock.tick(5000); assert.equal(signal.aborted, true); assert.equal(session.state, 'failed'); finish('late'); await flush(); await clock.tick(60000); assert.equal(calls, 1); assert.equal(values, 0);
});
test('read session close before microtask and close from onValue both prevent later polling', async () => {
  const clock = new Clock(); let calls = 0;
  const immediate = new DashboardReadSession({ timer: clock, read: async () => { calls++; return 1; }, onValue: () => {}, onFailure: () => {}, clearSensitive: () => {} });
  immediate.start(); immediate.close(); await clock.tick(10000); assert.equal(calls, 0);
  let session; session = new DashboardReadSession({ timer: clock, read: async () => { calls++; return 1; }, onValue: () => session.close(), onFailure: () => {}, clearSensitive: () => {} });
  session.start(); await clock.tick(10000); assert.equal(session.state, 'closed'); assert.equal(calls, 1); assert.equal(clock.tasks.size, 0);
});

test('browser-safe core has no Node, Electron, Host, filesystem or network imports', () => {
  for (const file of ['errors', 'limits', 'validation', 'projection', 'boards', 'provider', 'read-session']) {
    const source = readFileSync(join(__dirname, '../src/core/domain/dashboard', `${file}.ts`), 'utf8');
    assert.ok(!/from ['"](?:node:|electron|@deepseek-ai\/)/.test(source), file);
    assert.ok(!/\b(?:fetch|localStorage|indexedDB)\s*\(/.test(source), file);
  }
});


test('frozen documentation DTOs and runtime DTOs remain identical', () => {
  const body = path => readFileSync(path, 'utf8').split('\n').slice(1).join('\n');
  assert.equal(body(join(__dirname, '../src/shared/dashboard.ts')), body(join(__dirname, '../docs/dashboard/contracts.ts')));
});

test('strict JSON differential check: 500 deterministic legal documents agree with native JSON', () => {
  let seed = 92713;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 500; i++) {
    const value = { z: [next() / 7, null, true, false, `text-${next()}\n"\\😀`], a: { [String(next() % 31)]: ['界', i] } };
    const encoded = JSON.stringify(value, null, i % 3);
    assert.deepEqual(JSON.parse(JSON.stringify(V.parseStrictJson(encoded))), JSON.parse(encoded));
  }
});
