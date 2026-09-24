import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileManagedRouteId, LLM_ERROR } from '../../../src/core/domain/llm-connections.ts';
import { openSpaceLlmBridge } from '../../helpers/llm-official.ts';

const testRoot = process.env.DSH_BRIDGE_TEST_ROOT;
if (!testRoot) throw new Error('DSH_BRIDGE_TEST_ROOT is required');
const hash = () => createHash('sha256').update(readFileSync('packages/llm-bridge/src/plugin.ts')).digest('hex');
const results = { before: hash(), directDefaultPlugin: true };
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const route = compileManagedRouteId(id);
const forged = { api: 'openai-completions', baseURL: 'http://127.0.0.1:9999/forged', models: [{ id: 'demo' }] };
const snapshot = {
  catalogRevision: 1,
  policyRevision: 1,
  adapterVersion: '0.1.7-alpha.1',
  defaultModel: null,
  connections: [{
    id,
    revision: 1,
    displayName: 'test',
    enabled: true,
    backend: 'llm-pi-ai',
    providerConfig: { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'demo' }] },
    auth: { kind: 'none' },
    createdAt: '2026-09-21T00:00:00Z',
    updatedAt: '2026-09-21T00:00:00Z',
  }],
};

async function setup(forgedManaged = false) {
  const home = join(resolve(testRoot), `bridge-boundary-${Math.random().toString(16).slice(2)}`);
  return openSpaceLlmBridge({
    dshHome: home,
    snapshot,
    spaceId: 'boundary',
    forgedManagedProviders: forgedManaged ? { [route]: forged } : undefined,
  });
}

for (const [label, ops] of [
  ['sectionRoot', [{ op: 'set', path: [], value: { providers: { [route]: forged } } }]],
  ['providersRoot', [{ op: 'set', path: ['providers'], value: { [route]: forged } }]],
]) {
  const space = await setup();
  try {
    const prior = readFileSync(space.patchPath, 'utf8');
    await assert.rejects(async () => space.settings.mutate('llm-pi-ai', ops), { code: LLM_ERROR.SHARED_CONNECTION_READ_ONLY });
    assert.equal(readFileSync(space.patchPath, 'utf8'), prior);
    results[label] = { rejected: true, noFileChange: true };
  } finally {
    await space.dispose();
  }
}
{
  const space = await setup(true);
  try {
    let calls = 0;
    await assert.rejects(
      async () => space.ctx.waterfall(space.ctx.llm, 'llm/stream', { provider: route }, () => {
        calls++;
        return 'would-dispatch';
      }),
      { code: LLM_ERROR.MANAGED_ROUTE_CONFLICT },
    );
    assert.equal(calls, 0);
    results.runtimeRawConflict = { rejected: true, nextCalls: calls };
  } finally {
    await space.dispose();
  }
}
{
  const space = await setup();
  try {
    await space.credentials.set('REVIEW_LOCAL_KEY', 'local-fixture');
    assert.equal((await space.credentials.resolve('REVIEW_LOCAL_KEY')).value, 'local-fixture');
    assert.equal((await space.credentials.describe('REVIEW_LOCAL_KEY')).configured, true);
    await space.credentials.unset('REVIEW_LOCAL_KEY');
    assert.equal(await space.credentials.resolve('REVIEW_LOCAL_KEY'), undefined);
    await space.credentials.modifyRecord('review/local', async () => ({ kind: 'api-key', key: 'local-record-fixture' }));
    assert.equal((await space.credentials.readRecord('review/local')).key, 'local-record-fixture');
    assert.equal((await space.credentials.describeRecord('review/local')).configured, true);
    await space.credentials.deleteRecord('review/local');
    assert.equal(await space.credentials.readRecord('review/local'), undefined);
    results.localDelegation = { referenceReadWrite: true, recordReadWrite: true };
  } finally {
    await space.dispose();
  }
}
results.after = hash();
results.sourceStable = results.before === results.after;
writeFileSync(join(resolve(testRoot), 'bridge-boundary-final-results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
