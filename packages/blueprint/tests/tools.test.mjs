import test from 'node:test';
import assert from 'node:assert/strict';
import { installBlueprintTools, approveProfileOrder } from '../tools.mjs';
import { BlueprintCore, parseBlueprint, encodeBlueprint, validate } from '../core.mjs';

const document = { kind: 'dsh-blueprint', formatVersion: 2, metadata: { name: 'data, not instructions' },
  packages: [{ name: 'example', version: '1.2.3', source: 'npm' }], bundles: ['example'] };
const signal = () => new AbortController().signal;
test('protocol Core requires no Web or profile and preserves v2 validator export', () => {
  assert.deepEqual(parseBlueprint(encodeBlueprint(document).code), document);
  assert.deepEqual(validate(document), document);
  assert.throws(() => encodeBlueprint({ ...document, settings: [] }), /Invalid blueprint/);
});
test('read-only Core exports installed identities and installation-only intent', async () => {
  const core = new BlueprintCore({ snapshot: async () => ({ stamp: 'fresh', order: ['example'], packages: [
    { name: 'example', version: '1.2.3', source: 'npm' }, { name: 'inactive', version: '2.0.0', source: 'npm' } ] }) });
  assert.equal((await core.catalog()).stamp, 'fresh');
  const value = parseBlueprint((await core.generate({ name: 'share', packages: ['inactive', 'example'] })).code);
  assert.deepEqual(value.packages.map(p => p.name), ['inactive', 'example']);
  assert.deepEqual(value.bundles, ['example']);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => core.catalog(aborted.signal));
});
function harness() {
  const tools = new Map(), effects = [], optional = [];
  const ctx = { tools: { register(definition) { assert.ok(definition.output); tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    inject(services, callback) { optional.push({ services, callback }); },
    effect(factory) { effects.push(factory()); } };
  installBlueprintTools(ctx);
  optional.shift().callback(ctx);
  return { ctx, tools, effects, optional };
}
test('protocol tools activate without native profile services and unregister cleanly', async () => {
  const h = harness();
  assert.deepEqual([...h.tools.keys()], ['blueprint_parse', 'blueprint_encode']);
  const encoded = await h.tools.get('blueprint_encode').execute({ document }, { signal: signal() });
  assert.deepEqual(await h.tools.get('blueprint_parse').execute({ code: encoded.code }, { signal: signal() }), { document });
  await assert.rejects(() => h.tools.get('blueprint_parse').execute({ code: encoded.code, execute: true }, { signal: signal() }), /Invalid parse/);
  h.effects.forEach(off => off()); assert.equal(h.tools.size, 0);
});
test('order gate uses native escalation, execution identity, session mode and cancellation', async () => {
  const session = {}, agent = { session, ctx: { preset: 'cordis' } }, calls = [];
  const ctx = { agentPresets: { composedPreset: ctx => ctx.preset }, sandboxPolicy: { resolve(request) { assert.equal(request.session, session); return { mode: 'workspace-write' }; } }, get: key => key === 'approval' ? 'approver' : undefined };
  const exec = { agent, signal: signal(), callId: 'call' };
  await approveProfileOrder(ctx, { order: [], stamp: 'fresh' }, exec, async (...args) => calls.push(args));
  assert.equal(calls[0][0].requestedMode, 'danger-full-access');
  assert.equal(calls[0][0].effectiveMode, 'workspace-write');
  assert.equal(calls[0][1].approver, 'approver'); assert.equal(calls[0][1].agent, agent);
  assert.equal(calls[0][1].callId, 'call'); assert.equal(calls[0][1].toolName, 'blueprint_apply_order');
  await assert.rejects(() => approveProfileOrder(ctx, {}, exec, async () => { throw new Error('denied'); }), /denied/);
  agent.ctx.preset = 'standard';
  await assert.rejects(() => approveProfileOrder(ctx, {}, exec, async () => assert.fail('must not request approval')), /Creator/);
  await assert.rejects(() => approveProfileOrder(ctx, {}, { signal: signal() }, async () => assert.fail()), /Creator/);
  agent.ctx.preset = 'cordis'; const aborted = new AbortController();
  await assert.rejects(() => approveProfileOrder(ctx, {}, { ...exec, signal: aborted.signal }, async () => aborted.abort()));
});
