import { build } from 'esbuild';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = path => resolve(root, path);
const distribution = process.argv.includes('--distribution') || process.env.DSH_SPACES_BUILD_TARGET === 'distribution';
const common = { bundle: true, format: 'esm', target: 'es2022', logLevel: 'info', absWorkingDir: root };
const diagnosticBuild = { define: { __DSH_SPACES_LOG_LEVEL__: JSON.stringify(distribution ? 'info' : 'debug') } };
const nodeRequire = 'import { createRequire as __spacesCreateRequire } from "node:module"; const require = __spacesCreateRequire(import.meta.url);';

// Spaces consumes the independently packaged Blueprint protocol, including v1.
const blueprintBuild = spawnSync(process.execPath, [at('packages/blueprint/scripts/build.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
if (blueprintBuild.status !== 0) throw new Error('Blueprint build failed', { cause: blueprintBuild.error });

async function buildNodeCli(entryPoint, outfile, extra = {}) {
  const source = await readFile(at(entryPoint), 'utf8');
  const banner = source.startsWith('#!') ? nodeRequire : `#!/usr/bin/env node\n${nodeRequire}`;
  await build({ ...common, ...diagnosticBuild, platform: 'node', banner: { js: banner }, entryPoints: [entryPoint], outfile, ...extra });
  const check = spawnSync(process.execPath, ['--check', at(outfile)], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (check.status !== 0) throw new Error(`Invalid bundled CLI: ${outfile}`);
}

async function buildClient(packageName, entryPoint, outfile) {
  const client = await build({ ...common, platform: 'browser', format: 'cjs', jsx: 'automatic', external: ['@deepseek-ai/*', 'react', 'react/*'], entryPoints: [entryPoint], write: false, metafile: true });
  const clientJs = client.outputFiles.find(file => file.path.endsWith('.js') || file.path === '<stdout>');
  if (!clientJs || client.outputFiles.length !== 1) throw new Error('The client must bundle its styles and code into one host module');
  for (const path of Object.keys(client.metafile.inputs)) {
    if (/node_modules[\\/]react(?:-dom)?[\\/]/.test(path)) throw new Error('Client bundled a second React runtime');
    if (/src[\\/](?:adapters|shared[\\/]node)[\\/]/.test(path)) throw new Error('Client imported Node-only code');
  }
  await writeFile(at(outfile), `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${clientJs.text}\nreturn module.exports;}});\n`);
}

const sdkExternal = ['@deepseek-ai/*'];
await build({ ...common, ...diagnosticBuild, platform: 'node', banner: { js: nodeRequire }, external: sdkExternal, entryPoints: {
  index: 'packages/plugin/src/index.ts',
  'space-control': 'packages/plugin/src/space-control/index.ts',
  'typert.host': 'packages/plugin/src/typert.host.ts',
  'typert.remote-client': 'packages/plugin/src/typert.remote-client.ts',
}, outdir: 'packages/plugin/lib' });
await buildClient('dsh-spaces', 'packages/plugin/src/client/index.tsx', 'packages/plugin/lib/client.js');
await copyFile(at('LICENSE'), at('packages/plugin/LICENSE'));

await build({ ...common, ...diagnosticBuild, platform: 'node', banner: { js: nodeRequire }, external: sdkExternal,
  entryPoints: ['packages/view-bridge/src/index.ts'], outfile: 'packages/view-bridge/lib/index.js' });
await build({ ...common, ...diagnosticBuild, platform: 'node', external: sdkExternal,
  entryPoints: ['packages/view-bridge/src/settings.ts'], outfile: 'packages/view-bridge/lib/settings.js' });
await build({ ...common, ...diagnosticBuild, platform: 'node', external: sdkExternal,
  entryPoints: ['packages/view-bridge/src/typert.host.ts'], outfile: 'packages/view-bridge/lib/typert.host.js' });
await buildClient('@dsh-spaces/view-bridge', 'packages/view-bridge/src/client.ts', 'packages/view-bridge/lib/client.js');
await copyFile(at('LICENSE'), at('packages/view-bridge/LICENSE'));

await build({ ...common, ...diagnosticBuild, platform: 'node', banner: { js: nodeRequire }, external: sdkExternal,
  entryPoints: ['packages/browser/src/index.ts'], outfile: 'packages/browser/lib/index.js' });
await build({ ...common, ...diagnosticBuild, platform: 'node', banner: { js: nodeRequire }, external: sdkExternal,
  entryPoints: ['packages/browser/src/typert.host.ts'], outfile: 'packages/browser/lib/typert.host.js' });
await buildClient('@dsh-spaces/browser', 'packages/browser/src/client.tsx', 'packages/browser/lib/client.js');
await copyFile(at('LICENSE'), at('packages/browser/LICENSE'));

// The retired LLM bridge payload and main-image entry are no longer built;
// drop their outputs from earlier builds so the plugin package stays exact.
await rm(at('packages/plugin/lib/llm-bridge'), { recursive: true, force: true });
await rm(at('packages/plugin/lib/llm-images.js'), { force: true });

// playwright-core is copied verbatim next to the supervisor bundle: it loads
// its own sub-paths dynamically and cannot be esbuilded. The immutable
// component payload carries it at a fixed relative position so the packaged
// install never depends on a profile's node_modules layout. The checkout's
// own install is the source; its declared version must match the pin.
await rm(at('packages/supervisor/lib/ui-engine'), { recursive: true, force: true });
await cp(at('node_modules/playwright-core'), at('packages/supervisor/lib/ui-engine/node_modules/playwright-core'), { recursive: true });
{
  const engineManifest = JSON.parse(await readFile(at('packages/supervisor/lib/ui-engine/node_modules/playwright-core/package.json'), 'utf8'));
  if (engineManifest.name !== 'playwright-core' || engineManifest.version !== '1.62.1') {
    throw new Error(`ui-engine playwright-core must be 1.62.1, got ${engineManifest.name}@${engineManifest.version}`);
  }
}

// The supervisor bundle resolves playwright-core only from ./ui-engine next
// to itself (see src/adapters/node/supervisor/ui-playwright.ts).
await buildNodeCli('packages/supervisor/src/index.ts', 'packages/supervisor/lib/index.js');
await build({ ...common, ...diagnosticBuild, platform: 'node', banner: { js: nodeRequire },
  entryPoints: ['src/adapters/node/snapshots/snapshot-worker.ts'], outfile: 'packages/supervisor/lib/snapshot-worker.mjs' });
await copyFile(at('LICENSE'), at('packages/supervisor/LICENSE'));

// These immutable program resources are copied out of profiles before launch.
// A running executor is never replaced by a Home snapshot restore.
await rm(at('packages/plugin/lib/supervisor'), { recursive: true, force: true });
await cp(at('packages/supervisor/lib'), at('packages/plugin/lib/supervisor'), { recursive: true });
await copyFile(at('packages/supervisor/package.json'), at('packages/plugin/lib/supervisor/package.json'));
await rm(at('packages/plugin/lib/view-bridge/lib'), { recursive: true, force: true });
await cp(at('packages/view-bridge/lib'), at('packages/plugin/lib/view-bridge/lib'), { recursive: true });
for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE']) {
  await copyFile(at(`packages/view-bridge/${file}`), at(`packages/plugin/lib/view-bridge/${file}`));
}
await rm(at('packages/plugin/lib/browser/lib'), { recursive: true, force: true });
await cp(at('packages/browser/lib'), at('packages/plugin/lib/browser/lib'), { recursive: true });
for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE']) {
  await copyFile(at(`packages/browser/${file}`), at(`packages/plugin/lib/browser/${file}`));
}
await writeSpacesComponentPayload();
await copyFile(at('packages/plugin/lib/supervisor/manifest.json'), at('packages/supervisor/lib/manifest.json'));
await buildNodeCli('packages/doctor/src/index.ts', 'packages/doctor/lib/index.js');
await copyFile(at('LICENSE'), at('packages/doctor/LICENSE'));

async function writeSpacesComponentPayload() {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-spaces-component-payload-'));
  const outfile = join(scratch, 'component-payload.mjs');
  try {
    const bundle = await build({
      ...common,
      platform: 'node',
      bundle: true,
      format: 'esm',
      entryPoints: ['src/adapters/node/payload/component-payload.ts'],
      outfile,
      write: false,
    });
    // Keep temporary-file writes in the Node process that created the scratch
    // directory. A long-lived native build service may not have that access.
    if (bundle.outputFiles.length !== 1) throw new Error('Expected one component payload module');
    await writeFile(outfile, bundle.outputFiles[0].contents);
    const check = spawnSync(process.execPath, ['--check', outfile], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (check.status !== 0) throw new Error('Invalid bundled component payload module');
    const mod = await import(pathToFileURL(outfile).href);
    if (typeof mod.writeComponentPayloadManifest !== 'function') {
      throw new Error('component-payload module did not export writeComponentPayloadManifest');
    }
    const result = mod.writeComponentPayloadManifest(at('packages/plugin/lib'));
    if (!result?.manifest || typeof result.digest !== 'string' || !/^[a-f0-9]{64}$/.test(result.digest)) {
      throw new Error('component payload write did not return a validated manifest');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
