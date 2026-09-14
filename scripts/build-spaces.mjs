import { build } from 'esbuild';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = path => resolve(root, path);
const common = { bundle: true, format: 'esm', target: 'es2022', logLevel: 'info', absWorkingDir: root };
const nodeRequire = 'import { createRequire as __spacesCreateRequire } from "node:module"; const require = __spacesCreateRequire(import.meta.url);';

async function buildNodeCli(entryPoint, outfile) {
  const source = await readFile(at(entryPoint), 'utf8');
  const banner = source.startsWith('#!') ? nodeRequire : `#!/usr/bin/env node\n${nodeRequire}`;
  await build({ ...common, platform: 'node', banner: { js: banner }, entryPoints: [entryPoint], outfile });
  const check = spawnSync(process.execPath, ['--check', at(outfile)], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (check.status !== 0) throw new Error(`Invalid bundled CLI: ${outfile}`);
}

async function buildClient(packageName, entryPoint, outfile) {
  const client = await build({ ...common, platform: 'browser', format: 'cjs', jsx: 'automatic', external: ['@deepseek-ai/*', 'react', 'react/*'], entryPoints: [entryPoint], write: false, metafile: true });
  const clientJs = client.outputFiles.find(file => file.path.endsWith('.js') || file.path === '<stdout>');
  if (!clientJs || client.outputFiles.length !== 1) throw new Error('The client must bundle its styles and code into one host module');
  for (const path of Object.keys(client.metafile.inputs)) {
    if (/node_modules[\\/]react(?:-dom)?[\\/]/.test(path)) throw new Error('Client bundled a second React runtime');
    if (/src[\\/](?:main|adapters)[\\/]/.test(path)) throw new Error('Client imported a Node adapter');
  }
  await writeFile(at(outfile), `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${clientJs.text}\nreturn module.exports;}});\n`);
}

await mkdir(at('packages/core/lib'), { recursive: true });
await build({ ...common, platform: 'neutral', mainFields: ['module', 'main'], entryPoints: ['packages/core/src/index.ts'], outfile: 'packages/core/lib/index.js' });
const declarations = spawnSync(process.execPath, [at('node_modules/typescript/bin/tsc'), '-p', at('tsconfig.core-build.json')], { cwd: root, stdio: 'inherit', windowsHide: true });
if (declarations.status !== 0) throw new Error('Core declaration build failed', { cause: declarations.error });
const coreEntry = await readFile(at('packages/core/src/index.ts'), 'utf8');
await writeFile(at('packages/core/lib/index.d.ts'), coreEntry.replaceAll('../../../src/', './types/'));
await copyFile(at('LICENSE'), at('packages/core/LICENSE'));

if (!process.argv.includes('--core-only')) {
  const sdkExternal = ['@deepseek-ai/*'];
  await build({ ...common, platform: 'node', banner: { js: nodeRequire }, external: sdkExternal, entryPoints: {
    index: 'packages/plugin/src/index.ts',
    'typert.host': 'packages/plugin/src/typert.host.ts',
    'typert.remote-client': 'packages/plugin/src/typert.remote-client.ts',
  }, outdir: 'packages/plugin/lib' });
  await buildClient('@dsh-spaces/plugin', 'packages/plugin/src/client/index.tsx', 'packages/plugin/lib/client.js');
  await copyFile(at('LICENSE'), at('packages/plugin/LICENSE'));

  await build({ ...common, platform: 'node', banner: { js: nodeRequire }, external: sdkExternal,
    entryPoints: ['packages/view-bridge/src/index.ts'], outfile: 'packages/view-bridge/lib/index.js' });
  await buildClient('@dsh-spaces/view-bridge', 'packages/view-bridge/src/client.ts', 'packages/view-bridge/lib/client.js');
  await copyFile(at('LICENSE'), at('packages/view-bridge/LICENSE'));

  await buildNodeCli('packages/supervisor/src/index.ts', 'packages/supervisor/lib/index.js');
  await build({ ...common, platform: 'node', banner: { js: nodeRequire },
    entryPoints: ['src/main/snapshot-worker.ts'], outfile: 'packages/supervisor/lib/snapshot-worker.mjs' });
  await copyFile(at('LICENSE'), at('packages/supervisor/LICENSE'));
  const supervisorPackage = JSON.parse(await readFile(at('packages/supervisor/package.json'), 'utf8'));
  await writeFile(at('packages/supervisor/lib/manifest.json'), `${JSON.stringify({ version: supervisorPackage.version, entry: 'index.js' }, null, 2)}\n`);

  // These immutable program resources are copied out of profiles before launch.
  // A running executor is never replaced by a Home snapshot restore.
  await cp(at('packages/supervisor/lib'), at('packages/plugin/lib/supervisor'), { recursive: true });
  await cp(at('packages/view-bridge/lib'), at('packages/plugin/lib/view-bridge/lib'), { recursive: true });
  for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE']) {
    await copyFile(at(`packages/view-bridge/${file}`), at(`packages/plugin/lib/view-bridge/${file}`));
  }
  await buildNodeCli('packages/doctor/src/index.ts', 'packages/doctor/lib/index.js');
  await copyFile(at('LICENSE'), at('packages/doctor/LICENSE'));
}
