import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = path => resolve(root, path);
const common = { bundle: true, format: 'esm', target: 'es2022', logLevel: 'info', absWorkingDir: root };
const nodeRequire = 'import { createRequire as __spacesCreateRequire } from "node:module"; const require = __spacesCreateRequire(import.meta.url);';

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
  const client = await build({ ...common, platform: 'browser', format: 'cjs', jsx: 'automatic', external: [...sdkExternal, 'react', 'react/*'], entryPoints: ['packages/plugin/src/client/index.tsx'], write: false, metafile: true });
  const clientJs = client.outputFiles.find(file => file.path.endsWith('.js') || file.path === '<stdout>');
  if (!clientJs || client.outputFiles.length !== 1) throw new Error('The client must bundle its styles and code into one host module');
  for (const path of Object.keys(client.metafile.inputs)) {
    if (/node_modules[\\/]react(?:-dom)?[\\/]/.test(path)) throw new Error('Client bundled a second React runtime');
    if (/src[\\/](?:main|adapters)[\\/]/.test(path)) throw new Error('Client imported a Node adapter');
  }
  await writeFile(at('packages/plugin/lib/client.js'), `window.__ModuleLoader__.load({id:"@dsh-spaces/plugin",factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${clientJs.text}\nreturn module.exports;}});\n`);
  await copyFile(at('LICENSE'), at('packages/plugin/LICENSE'));
  await build({ ...common, platform: 'node', entryPoints: ['packages/doctor/src/index.ts'], outfile: 'packages/doctor/lib/index.js', banner: { js: `#!/usr/bin/env node\n${nodeRequire}` } });
  await copyFile(at('LICENSE'), at('packages/doctor/LICENSE'));
}
