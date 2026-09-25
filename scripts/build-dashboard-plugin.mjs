/** Build the independent dashboard package, without changing Spaces component payloads. */
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = path => resolve(root, path);
const manifest = JSON.parse(await readFile(at('packages/dashboard/package.json'), 'utf8'));
if (manifest.name !== '@dsh-spaces/dashboard') throw new Error('Unexpected dashboard package identity');
await mkdir(at('packages/dashboard/lib'), { recursive: true });
const common = { absWorkingDir: root, bundle: true, target: 'es2022', logLevel: 'info', metafile: true };
const host = await build({ ...common, platform: 'node', format: 'esm', external: ['@deepseek-ai/*'],
  entryPoints: ['packages/dashboard/src/index.ts'], outfile: at('packages/dashboard/lib/index.js') });
if (Object.keys(host.metafile.inputs).some(path => /src[\\/](?:main|adapters)[\\/]|packages[\\/](?:supervisor|plugin)[\\/]/.test(path))) throw new Error('Dashboard host imported Spaces management');
const client = await build({ ...common, platform: 'browser', format: 'cjs', jsx: 'automatic', external: ['@deepseek-ai/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
  entryPoints: ['packages/dashboard/src/client.tsx'], write: false });
if (client.outputFiles.length !== 1) throw new Error('Client requires one module');
for (const path of Object.keys(client.metafile.inputs)) {
  if (/node_modules[\\/]react(?:-dom)?[\\/]|packages[\\/]dashboard[\\/]src[\\/]host[\\/]|src[\\/](?:main|adapters)[\\/]/.test(path)) throw new Error('Client crossed runtime boundary');
}
await writeFile(at('packages/dashboard/lib/client.js'), `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
await copyFile(at('LICENSE'), at('packages/dashboard/LICENSE'));
for (const name of ['index', 'client']) {
  const checked = spawnSync(process.execPath, ['--check', at(`packages/dashboard/lib/${name}.js`)], { stdio: 'inherit' });
  if (checked.status !== 0) throw new Error('Invalid dashboard build');
}
console.log('Dashboard package built; this does not install, publish or modify any DSH Home.');
