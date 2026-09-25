/** Documentation fixture checks only; not the production protocol validator. */
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { test } = require('node:test');
if (!process.argv[2]) throw new Error('Pass the compiled examples.js path. See validation.md.');
const samples = require(resolve(process.argv[2]));

function checkSnapshot(p) {
  assert.equal(p.protocolVersion, 1);
  assert.equal(p.sequence, 1);
  assert.equal('spaceId' in p, false);
  assert.equal('homeId' in p, false);
  assert.ok(p.types.length <= 32);
  assert.ok(p.instances.length <= 100);
  assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 1024 * 1024);
  assert.equal(new Set(p.types.map(t => t.typeId)).size, p.types.length);
  assert.equal(new Set(p.instances.map(i => i.instanceId)).size, p.instances.length);
  for (const i of p.instances) {
    const type = p.types.find(t => t.typeId === i.typeId && t.version === i.typeVersion);
    assert.ok(type);
    assert.equal(type.kind, i.content.kind);
    assert.ok(Number.isFinite(Date.parse(i.updatedAt)));
    assert.ok(i.staleAfterSeconds === null || (i.staleAfterSeconds >= 30 && i.staleAfterSeconds <= 86400));
    assert.ok(Buffer.byteLength(JSON.stringify(i.content)) <= 32 * 1024);
    if (i.content.kind === 'progress') {
      assert.ok(Number.isFinite(i.content.value));
      assert.ok(i.content.max > 0 && i.content.value >= 0 && i.content.value <= i.content.max);
    }
    if (i.content.kind === 'list') {
      assert.ok(i.content.items.length <= 100);
      assert.equal(new Set(i.content.items.map(x => x.id)).size, i.content.items.length);
    }
  }
}
function checkLayout(command) {
  assert.ok(command.placements.length <= 200);
  assert.equal(new Set(command.placements.map(p => p.id)).size, command.placements.length);
  for (const p of command.placements) {
    assert.ok([p.x, p.y, p.w, p.h].every(Number.isInteger));
    assert.ok(p.x >= 0 && p.y >= 0 && p.w >= 1 && p.h >= 1);
    assert.ok(p.x + p.w <= 12 && p.y + p.h <= 10000);
  }
  for (let i = 0; i < command.placements.length; i++) {
    for (let j = i + 1; j < command.placements.length; j++) {
      const a = command.placements[i], b = command.placements[j];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    }
  }
}

test('writing snapshot fixture is internally consistent', () => checkSnapshot(samples.writing));
test('task snapshot fixture is internally consistent', () => checkSnapshot(samples.tasks));
test('space runs have independent sequence namespaces', () => {
  assert.notEqual(samples.writing.runId, samples.tasks.runId);
  assert.equal(samples.writing.sequence, samples.tasks.sequence);
});
test('two-space board has valid distinct placements', () => checkLayout(samples.boardCreate.command));
test('query and response preserve ref order and cardinality', () => {
  assert.deepEqual(samples.query.refs, samples.response.data.items.map(i => i.ref));
});
test('layout references match their provider instances', () => {
  for (const [n, p] of [samples.writing, samples.tasks].entries()) {
    const ref = samples.boardCreate.command.placements[n].ref;
    assert.equal(ref.providerId, p.providerId);
    assert.equal(ref.instanceId, p.instances[0].instanceId);
  }
});
test('selected publication names the writing instance', () => {
  assert.deepEqual(samples.policyPreview.selection.instanceIds, samples.writing.instances.map(i => i.instanceId));
});
test('duplicate instance fixture is rejected', () => {
  const p = structuredClone(samples.writing); p.instances.push(p.instances[0]);
  assert.throws(() => checkSnapshot(p));
});
test('inconsistent type fixture is rejected', () => {
  const p = structuredClone(samples.writing); p.types[0].kind = 'metric';
  assert.throws(() => checkSnapshot(p));
});
test('out-of-range progress fixture is rejected', () => {
  const p = structuredClone(samples.writing); p.instances[0].content.value = 6;
  assert.throws(() => checkSnapshot(p));
});
test('oversized content fixture is rejected', () => {
  const p = structuredClone(samples.writing); p.instances[0].content.unit = 'x'.repeat(33 * 1024);
  assert.throws(() => checkSnapshot(p));
});
test('overlapping placement fixture is rejected', () => {
  const c = structuredClone(samples.boardCreate.command); c.placements[1].x = 0;
  assert.throws(() => checkLayout(c));
});
