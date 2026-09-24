import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileManagedCredentialRef, compileManagedRecordKey, compileManagedRouteId } from '../../../src/core/domain/llm-connections.ts';
import { openSpaceLlmBridge } from '../../helpers/llm-official.ts';

const testRoot = process.env.DSH_BRIDGE_TEST_ROOT;
if (!testRoot) throw new Error('DSH_BRIDGE_TEST_ROOT is required');
const hash = () => createHash('sha256').update(readFileSync('packages/llm-bridge/src/plugin.ts')).digest('hex');
const before = hash();
const results = { before };
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const route = compileManagedRouteId(id);
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
    auth: { kind: 'api-key', credentialRecordId: compileManagedRecordKey(id, 1) },
    createdAt: '2026-09-21T00:00:00Z',
    updatedAt: '2026-09-21T00:00:00Z',
  }],
};

{
  const home = join(resolve(testRoot), 'bridge-edge-dispose');
  const space = await openSpaceLlmBridge({ dshHome: home, snapshot, spaceId: 'lifecycle' });
  try {
    const beforeDispose = space.ctx.llm.listProviders().some((p) => p.id === route);
    await space.unplugBridge();
    results.lateConsumerBridgeDispose = {
      beforeDispose,
      providerStillPresent: space.ctx.llm.listProviders().some((p) => p.id === route),
      defaultAfterDispose: space.ctx.agentDefaultModel?.currentSelection?.() ?? null,
      namespaceStillRegistered: space.settings.describe().some((s) => s.ns === 'llm-pi-ai'),
    };
  } catch (e) {
    results.lateConsumerBridgeDispose = { error: e.message };
  } finally {
    await space.dispose();
  }
}
{
  const home = join(resolve(testRoot), 'bridge-edge-forged');
  const space = await openSpaceLlmBridge({
    dshHome: home,
    snapshot,
    spaceId: 'forged',
    forgedManagedProviders: {
      [route]: { api: 'openai-completions', baseURL: 'http://127.0.0.1:9999/forged', models: [{ id: 'demo' }] },
    },
  });
  try {
    const provider = space.settings.get('llm-pi-ai').providers[route];
    let guard;
    try {
      guard = await space.ctx.waterfall(space.ctx.llm, 'llm/stream', { provider: route }, () => 'allowed-without-dispatch');
    } catch (e) {
      guard = e.message;
    }
    results.forgedManagedRoute = {
      baseURL: provider.baseURL,
      credentialRefIsShared: provider.apiKeyEnv === compileManagedCredentialRef(id, 1),
      guard,
      error: String(guard ?? ''),
      providerPresent: space.ctx.llm.listProviders().some((p) => p.id === route),
    };
  } catch (e) {
    results.forgedManagedRoute = { error: e.message };
  } finally {
    await space.dispose();
  }
}
results.after = hash();
results.sourceStable = results.before === results.after;
writeFileSync(join(resolve(testRoot), 'bridge-lifecycle-conflict-final-results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
