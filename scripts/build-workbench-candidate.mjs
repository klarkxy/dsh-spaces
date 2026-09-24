/**
 * Audit-only rc.2 candidate packages.
 *
 * Builds into `.sandbox/workbench-rc2-candidate/packages` only. Does not
 * rewrite the official CLI bind gate, official
 * package libs, CLI/SDK package.json versions, or claim product support.
 *
 * Usage:
 *   node scripts/build-workbench-candidate.mjs
 * Root verification (this script does not run it):
 *   DSH_TEST_PACKAGE_ROOT=<repo>/.sandbox/workbench-rc2-candidate/packages
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = path => resolve(root, path);
const GATE_SOURCE = 'src/adapters/node/spaces-control.ts';
const candidateRoot = at('.sandbox/workbench-rc2-candidate');
const candidatePackages = join(candidateRoot, 'packages');
const common = { bundle: true, format: 'esm', target: 'es2022', logLevel: 'info', absWorkingDir: root };
const nodeRequire = 'import { createRequire as __spacesCreateRequire } from "node:module"; const require = __spacesCreateRequire(import.meta.url);';
const sdkExternal = ['@deepseek-ai/*'];
const OFFICIAL_LIB_DIRS = [
  'packages/core/lib',
  'packages/plugin/lib',
  'packages/view-bridge/lib',
  'packages/supervisor/lib',
  'packages/doctor/lib',
];
const OFFICIAL_PACKAGE_JSON = [
  'package.json',
  'package-lock.json',
  'packages/core/package.json',
  'packages/plugin/package.json',
  'packages/view-bridge/package.json',
  'packages/supervisor/package.json',
  'packages/doctor/package.json',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...await walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

async function hashPaths(paths) {
  const rows = [];
  for (const path of [...paths].sort()) {
    const bytes = await readFile(path);
    rows.push({ path: relative(root, path).split(sep).join('/'), sha256: sha256(bytes) });
  }
  return { rows, digest: sha256(Buffer.from(rows.map(row => `${row.path}:${row.sha256}`).join('\n'), 'utf8')) };
}

function assertOfficialGate(source, label) {
  if (source.includes('COMPATIBLE_DSH_CLI_VERSIONS')) {
    throw new Error(`${label}: official source still has a CLI version allowlist`);
  }
  if (!source.includes('return isExactRuntimeVersion(version);')) {
    throw new Error(`${label}: official bind gate must accept any exact CLI version`);
  }
}

function gitRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const text = (result.stdout || '').trim();
  return result.status === 0 && text ? text : 'unknown';
}

async function copyExisting(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

async function copyOptional(src, dest) {
  try {
    await stat(src);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  await copyExisting(src, dest);
  return true;
}

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
    if (entry.isSymbolicLink()) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

async function requireOfficial(path, label) {
  try {
    await stat(at(path));
  } catch {
    throw new Error(`${label} missing; build official packages first without rewriting them from this script`);
  }
}

function nodeCheck(outfile) {
  const check = spawnSync(process.execPath, ['--check', outfile], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (check.status !== 0) throw new Error(`Invalid bundled CLI: ${relative(root, outfile)}`);
}

async function buildNode({ entryPoints, outfile, outdir, banner, external }) {
  await build({
    ...common,
    platform: 'node',
    ...(banner ? { banner: { js: banner } } : {}),
    ...(external ? { external } : {}),
    entryPoints,
    ...(outfile ? { outfile } : {}),
    ...(outdir ? { outdir } : {}),
  });
}

async function buildNodeCli(entryPoint, outfile) {
  const source = await readFile(at(entryPoint), 'utf8');
  const banner = source.startsWith('#!') ? nodeRequire : `#!/usr/bin/env node\n${nodeRequire}`;
  await buildNode({ entryPoints: [entryPoint], outfile, banner });
  nodeCheck(outfile);
}

async function assertUnchanged(before, after, label) {
  if (before.digest !== after.digest) {
    const changed = [];
    const beforeMap = new Map(before.rows.map(row => [row.path, row.sha256]));
    const afterMap = new Map(after.rows.map(row => [row.path, row.sha256]));
    for (const [path, hash] of afterMap) {
      if (beforeMap.get(path) !== hash) changed.push(path);
    }
    for (const path of beforeMap.keys()) {
      if (!afterMap.has(path)) changed.push(path);
    }
    throw new Error(`${label} changed:\n${changed.join('\n')}`);
  }
}

const officialSourceBefore = await readFile(at(GATE_SOURCE), 'utf8');
assertOfficialGate(officialSourceBefore, 'pre-build source');
const officialLibBefore = await hashPaths((await Promise.all(OFFICIAL_LIB_DIRS.map(dir => walkFiles(at(dir))))).flat());
const officialPkgBefore = await hashPaths(OFFICIAL_PACKAGE_JSON.map(at));

await requireOfficial('packages/core/lib/index.js', 'official core lib');
await requireOfficial('packages/plugin/lib/client.js', 'official plugin client');
await requireOfficial('packages/view-bridge/lib/client.js', 'official view-bridge client');
await requireOfficial('packages/view-bridge/lib/settings.js', 'official view-bridge settings');

await mkdir(at('.sandbox'), { recursive: true });
await rm(candidatePackages, { recursive: true, force: true });
await mkdir(candidatePackages, { recursive: true });

await copyExisting(at('packages/core/package.json'), join(candidatePackages, 'core/package.json'));
await copyExisting(at('LICENSE'), join(candidatePackages, 'core/LICENSE'));
await copyOptional(at('packages/core/README.md'), join(candidatePackages, 'core/README.md'));
await copyDir(at('packages/core/lib'), join(candidatePackages, 'core/lib'));

await mkdir(join(candidatePackages, 'plugin/lib'), { recursive: true });
await buildNode({
  entryPoints: {
    index: 'packages/plugin/src/index.ts',
    'typert.host': 'packages/plugin/src/typert.host.ts',
    'typert.remote-client': 'packages/plugin/src/typert.remote-client.ts',
  },
  outdir: join(candidatePackages, 'plugin/lib'),
  banner: nodeRequire,
  external: sdkExternal,
});
await copyExisting(at('packages/plugin/lib/client.js'), join(candidatePackages, 'plugin/lib/client.js'));
await copyExisting(at('packages/plugin/package.json'), join(candidatePackages, 'plugin/package.json'));
await copyExisting(at('LICENSE'), join(candidatePackages, 'plugin/LICENSE'));
await copyExisting(at('packages/plugin/cordis.patch.yml'), join(candidatePackages, 'plugin/cordis.patch.yml'));
await copyOptional(at('packages/plugin/README.md'), join(candidatePackages, 'plugin/README.md'));

await mkdir(join(candidatePackages, 'view-bridge/lib'), { recursive: true });
await buildNode({
  entryPoints: ['packages/view-bridge/src/index.ts'],
  outfile: join(candidatePackages, 'view-bridge/lib/index.js'),
  banner: nodeRequire,
  external: sdkExternal,
});
await copyExisting(at('packages/view-bridge/lib/client.js'), join(candidatePackages, 'view-bridge/lib/client.js'));
await copyExisting(at('packages/view-bridge/lib/settings.js'), join(candidatePackages, 'view-bridge/lib/settings.js'));
await copyExisting(at('packages/view-bridge/package.json'), join(candidatePackages, 'view-bridge/package.json'));
await copyExisting(at('LICENSE'), join(candidatePackages, 'view-bridge/LICENSE'));
await copyExisting(at('packages/view-bridge/cordis.patch.yml'), join(candidatePackages, 'view-bridge/cordis.patch.yml'));

await mkdir(join(candidatePackages, 'supervisor/lib'), { recursive: true });
await buildNodeCli('packages/supervisor/src/index.ts', join(candidatePackages, 'supervisor/lib/index.js'));
await buildNode({
  entryPoints: ['src/adapters/node/snapshot-worker.ts'],
  outfile: join(candidatePackages, 'supervisor/lib/snapshot-worker.mjs'),
  banner: nodeRequire,
});
nodeCheck(join(candidatePackages, 'supervisor/lib/snapshot-worker.mjs'));
await copyExisting(at('packages/supervisor/package.json'), join(candidatePackages, 'supervisor/package.json'));
await copyExisting(at('LICENSE'), join(candidatePackages, 'supervisor/LICENSE'));
await copyOptional(at('packages/supervisor/README.md'), join(candidatePackages, 'supervisor/README.md'));
const supervisorPackage = JSON.parse(await readFile(at('packages/supervisor/package.json'), 'utf8'));
await writeFile(
  join(candidatePackages, 'supervisor/lib/manifest.json'),
  `${JSON.stringify({ version: supervisorPackage.version, entry: 'index.js' }, null, 2)}\n`,
);

await copyDir(join(candidatePackages, 'supervisor/lib'), join(candidatePackages, 'plugin/lib/supervisor'));
await copyDir(join(candidatePackages, 'view-bridge/lib'), join(candidatePackages, 'plugin/lib/view-bridge/lib'));
for (const file of ['package.json', 'cordis.patch.yml', 'LICENSE']) {
  await copyExisting(join(candidatePackages, `view-bridge/${file}`), join(candidatePackages, `plugin/lib/view-bridge/${file}`));
}

await mkdir(join(candidatePackages, 'doctor/lib'), { recursive: true });
await buildNodeCli('packages/doctor/src/index.ts', join(candidatePackages, 'doctor/lib/index.js'));
await copyExisting(at('packages/doctor/package.json'), join(candidatePackages, 'doctor/package.json'));
await copyExisting(at('LICENSE'), join(candidatePackages, 'doctor/LICENSE'));
await copyOptional(at('packages/doctor/README.md'), join(candidatePackages, 'doctor/README.md'));

const entries = [
  'core/lib/index.js',
  'plugin/lib/index.js',
  'plugin/lib/typert.host.js',
  'plugin/lib/typert.remote-client.js',
  'plugin/lib/supervisor/index.js',
  'plugin/lib/supervisor/snapshot-worker.mjs',
  'view-bridge/lib/index.js',
  'supervisor/lib/index.js',
  'supervisor/lib/snapshot-worker.mjs',
  'doctor/lib/index.js',
];
for (const entry of entries) nodeCheck(join(candidatePackages, entry));

const supervisorJs = await readFile(join(candidatePackages, 'supervisor/lib/index.js'), 'utf8');
if (supervisorJs.includes('COMPATIBLE_DSH_CLI_VERSIONS')) {
  throw new Error('candidate supervisor bundle still contains a CLI version allowlist');
}
const pluginSupervisorJs = await readFile(join(candidatePackages, 'plugin/lib/supervisor/index.js'), 'utf8');
if (pluginSupervisorJs !== supervisorJs) {
  throw new Error('plugin/lib/supervisor is not the candidate supervisor payload');
}

const officialSourceAfter = await readFile(at(GATE_SOURCE), 'utf8');
assertOfficialGate(officialSourceAfter, 'post-build source');
if (officialSourceAfter !== officialSourceBefore) throw new Error('official gate source changed during candidate build');
await assertUnchanged(officialLibBefore, await hashPaths((await Promise.all(OFFICIAL_LIB_DIRS.map(dir => walkFiles(at(dir))))).flat()), 'official packages/*/lib');
await assertUnchanged(officialPkgBefore, await hashPaths(OFFICIAL_PACKAGE_JSON.map(at)), 'official package.json / lock');

const packageHashes = {};
for (const name of ['core', 'plugin', 'view-bridge', 'supervisor', 'doctor']) {
  packageHashes[name] = (await hashPaths(await walkFiles(join(candidatePackages, name)))).digest;
}

const manifest = {
  candidate: true,
  claimsSupport: false,
  productSupported: false,
  allowedTestCliVersions: [],
  sourceGitRevision: gitRevision(),
  packageRoot: candidatePackages,
  env: { DSH_TEST_PACKAGE_ROOT: candidatePackages },
  hashes: packageHashes,
  note: 'Audit-only experimental channel. Product bind accepts any exact official CLI version.',
};
await writeFile(join(candidateRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`candidate packages: ${candidatePackages}\n`);
process.stdout.write(`DSH_TEST_PACKAGE_ROOT=${candidatePackages}\n`);
process.stdout.write(`manifest: ${join(candidateRoot, 'manifest.json')}\n`);
