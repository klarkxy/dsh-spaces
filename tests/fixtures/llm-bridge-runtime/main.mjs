import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileManagedCredentialRef, compileManagedRecordKey, compileManagedRouteId, LLM_ERROR } from '../../../src/core/domain/llm-connections.ts';
import { FileLlmCredentialStore } from '../../../src/adapters/node/llm-credential-store.ts';
import { openSpaceLlmBridge } from '../../helpers/llm-official.ts';

const testRoot = process.env.DSH_BRIDGE_TEST_ROOT;
if (!testRoot) throw new Error('DSH_BRIDGE_TEST_ROOT is required');
const source = 'packages/llm-bridge/src/plugin.ts';
const hash = () => createHash('sha256').update(readFileSync(source)).digest('hex');
const before = hash();
const home = join(resolve(testRoot), 'bridge-final');
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const route = compileManagedRouteId(id);
const sharedRef = compileManagedCredentialRef(id, 1);
const recordId = compileManagedRecordKey(id, 1);
await new FileLlmCredentialStore(home).writeRecord({ recordId, secret: 'review-only-shared-value' });
const snapshot = {
  catalogRevision: 1,
  policyRevision: 1,
  adapterVersion: '0.1.7-alpha.1',
  defaultModel: { connectionId: id, modelId: 'demo' },
  connections: [{
    id,
    revision: 1,
    displayName: 'test',
    enabled: true,
    backend: 'llm-pi-ai',
    providerConfig: { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'demo' }] },
    auth: { kind: 'api-key', credentialRecordId: recordId },
    createdAt: '2026-09-21T00:00:00Z',
    updatedAt: '2026-09-21T00:00:00Z',
  }],
};
const results = { before };
const space = await openSpaceLlmBridge({ dshHome: home, snapshot, spaceId: 'review', sharedHome: home });
try {
  const patchBefore = readFileSync(space.patchPath, 'utf8');
  assert.equal(space.ctx.llm.listProviders().some((p) => p.id === route), true);
  const models = await space.ctx.llm.listModels(route);
  assert.ok(models.some((m) => m.id === 'demo'));
  assert.deepEqual(space.ctx.agentDefaultModel.currentSelection(), { provider: route, model: 'demo' });
  await space.credentials.set('REVIEW_LOCAL_KEY', 'review-only-local-value');
  assert.equal((await space.credentials.resolve('REVIEW_LOCAL_KEY')).value, 'review-only-local-value');
  assert.equal((await space.credentials.resolve(sharedRef)).value, 'review-only-shared-value');
  await assert.rejects(async () => space.credentials.set(sharedRef, 'blocked-test-value'), { code: LLM_ERROR.SHARED_CONNECTION_READ_ONLY });
  await assert.rejects(async () => space.settings.update('llm-pi-ai', { providers: { [route]: { baseURL: 'http://127.0.0.1:8' } } }), { code: LLM_ERROR.SHARED_CONNECTION_READ_ONLY });
  const patchAfter = readFileSync(space.patchPath, 'utf8');
  assert.equal(patchAfter, patchBefore);
  assert.doesNotMatch(patchAfter, /spaces-llm-[0-9a-f]{32}|127\.0\.0\.1:9/);
  results.modelFound = true;
  results.defaultProjected = true;
  results.localDelegation = true;
  results.sharedCredentialReadOnly = true;
  results.noProviderPersist = true;
  results.lateConsumerProjection = true;
  results.consumerOwnsRegistration = space.settings.describe().some((row) => row.ns === 'llm-pi-ai');
  await space.unplugBridge();
  assert.equal(space.ctx.llm.listProviders().some((p) => p.id === route), false);
  const defaultAfterUnplug = space.ctx.agentDefaultModel?.currentSelection?.();
  assert.equal(defaultAfterUnplug, undefined);
  assert.equal(space.settings.describe().some((row) => row.ns === 'agent-default-model'), false);
  assert.equal((await space.credentials.resolve('REVIEW_LOCAL_KEY')).value, 'review-only-local-value');
  results.disposedCleanly = true;
} catch (e) {
  results.failure = e.message;
  throw e;
} finally {
  await space.dispose();
  results.after = hash();
  results.sourceStable = results.before === results.after;
  writeFileSync(join(resolve(testRoot), 'bridge-final-direct-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
