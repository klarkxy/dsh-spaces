import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SpaceBaseCreation } from '../../src/adapters/node/supervisor/base-creation';
import { assertBrowserDumpIsolated, assertDumpPatched } from '../../src/core/domain/isolation';
import { applySpaceRecipe } from '../../src/core/application/space-recipe';
import { dshBrowserReady } from '../../src/adapters/node/runtime/dsh-endpoint';
import type { RuntimeStore } from '../../src/adapters/node/runtime/runtime-store';
import { SupervisorSpaceCommands, type SupervisorSpaceCommandsHost } from '../../src/adapters/node/supervisor/space-commands';
import type { WorkbenchJobContext } from '../../src/adapters/node/maintenance/workbench-jobs';

test('base catalogs and creation keep Browser product version separate from its framework', async () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-base-'));
  try {
    const payload = join(home, 'payload'); mkdirSync(join(payload, 'browser'), { recursive: true });
    writeFileSync(join(payload, 'browser', 'package.json'), readFileSync(resolve('packages/browser/package.json')));
    mkdirSync(join(home, 'profiles'));
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const installs: string[] = [];
    const bases = new SpaceBaseCreation({ home, nodeExe: process.execPath,
      cli: () => ({ bin: 'host-cli', version: '0.2.1-rc.2' }),
      runtimes: () => ({ catalog: async () => ({ versions: [{ version: '0.2.1-rc.2' }, { version: '0.3.0' }], distTags: {} }),
        installedBin: () => undefined,
        install: async (version: string) => { installs.push(version); return { bin: 'selected-cli' }; },
      }) as unknown as RuntimeStore,
      options: { home, bin: 'host-cli', componentPayloadRoot: payload, browserArtifact: 'browser.tgz', viewBridgeArtifact: 'view.tgz',
        runCli: async args => { mutableCalls.push([...args]); return { code: 0, stdout: '', stderr: '' }; } },
    });
    assert.deepEqual(await bases.versions('browser'), { base: 'browser', versions: ['0.4.0'], preferred: '0.4.0' });
    assert.deepEqual((await bases.versions('web')).versions, ['0.3.0', '0.2.1-rc.2']);
    await assert.rejects(bases.prepare('browser', '0.2.1-rc.2'), /unavailable/);
    assert.deepEqual(installs, []);
    const browser = await bases.prepare('browser', '0.4.0');
    assert.equal(browser.runtimeVersion, '0.2.1-rc.2');
    await browser.initialize!('space-browser');
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'profiles/space-browser/package.json'), 'utf8')).dsh.profile,
      { bundles: [], spacesBase: 'browser', baseVersion: '0.4.0' });
    assert.deepEqual(calls.map(args => args.slice(0, 4)), [
      ['plugin', '--profile', 'space-browser', 'add'], ['plugin', '--profile', 'space-browser', 'add'],
    ]);
    assert.equal(calls.some(args => args.includes('--from-default-profile')), false);
    const web = await bases.prepare('web', '0.3.0');
    assert.equal(web.baseVersion, '0.3.0'); assert.equal(web.runtimeVersion, '0.3.0');
    assert.deepEqual(installs, ['0.3.0']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Browser validates present providers, renamed and nested paths; Web still requires both stores', () => {
  assert.doesNotThrow(() => assertBrowserDumpIsolated('[]', 'space-browser'));
  assert.throws(() => assertDumpPatched('[]', 'space-browser'));
  for (const row of [
    "- id: storage-json\n  name: '@deepseek-ai/dsh-storage-json'\n",
    "- id: renamed\n  name: '@deepseek-ai/dsh-storage-json'\n  config:\n    root: !!js dshHomePath('storages')\n",
    "- id: credentials\n  config:\n    path: !!js dshHomePath('hub/other/.credentials.yaml')\n",
    "- id: credentials\n  config:\n    path: dshHomePath('hub/space-browser/.credentials.yaml')\n",
    "- id: group\n  group: true\n  config:\n    - id: nested\n      name: '@deepseek-ai/dsh-session-persistence-jsonl'\n",
  ]) assert.throws(() => assertBrowserDumpIsolated(row, 'space-browser'), /isolated/);
  assert.doesNotThrow(() => assertBrowserDumpIsolated("- id: credentials\n  config:\n    path: !!js dshHomePath('hub/space-browser/.credentials.yaml')\n", 'space-browser'));
});

test('Browser template creation preserves base identity and rebinds credentials without adding chat storage', async () => {
  let created: unknown;
  let patch = '';
  const result = await applySpaceRecipe({ schemaVersion: 1, displayName: 'Browser', plugins: [],
    source: { base: 'browser', baseVersion: '0.4.0', dshVersion: '0.2.1-rc.2' },
    patch: "- id: credentials\n  config:\n    path: !!js dshHomePath('hub/old/.credentials.yaml')\n",
  }, { createSpace: async input => { created = input; }, installPlugin: async () => {}, writePatch: (_id, value) => { patch = value; } }, { name: 'new' });
  assert.equal(result.definition, 'imported');
  assert.equal((created as { base: string }).base, 'browser');
  assert.equal((created as { baseVersion: string }).baseVersion, '0.4.0');
  assert.match(patch, /hub\/space-new\/.credentials.yaml/);
  assert.doesNotMatch(patch, /session-persistence|storage-json|attachment-local/);
});

test('Browser readiness uses only its authenticated API and does not replay a failed call', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++; assert.match(String(url), /\/api\/spacesBrowser\/listTabs$/);
    assert.equal((options!.headers as Record<string, string>).cookie, 'dsh-auth-test=value');
    return new Response(JSON.stringify({ result: { ok: false } }), { status: 403 });
  };
  await assert.rejects(dshBrowserReady(12345, fetcher, new AbortController().signal, 'dsh-auth-test=value'), /403/);
  assert.equal(calls, 1);
});

test('sealed Browser template creation reaches no profile, installation or patch mutation', async () => {
  let mutations = 0;
  const commands = new SupervisorSpaceCommands({
    lock: { run: async () => { mutations++; throw new Error('Must not mutate'); } },
  } as unknown as SupervisorSpaceCommandsHost);
  const ctx = { phase() {}, cancellable() {} } as unknown as WorkbenchJobContext;
  const result = await applySpaceRecipe({ schemaVersion: 1, displayName: 'Browser', plugins: [],
    source: { base: 'browser', baseVersion: '0.4.0' },
  }, {
    createSpace: async input => { await commands.createSpace(input, ctx); },
    installPlugin: async () => { mutations++; },
    writePatch: () => { mutations++; },
  }, { name: 'browser' });
  assert.equal(result.definition, 'failed');
  assert.equal(result.plugins, 'not-run');
  assert.equal(mutations, 0);
});
