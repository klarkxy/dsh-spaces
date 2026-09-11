import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchWriter, assertDumpPatched } from '../src/main/patch-writer.ts';

const bin = process.env.DSH_TEST_BIN ?? join(process.env.APPDATA, 'dsh-spaces', 'dsh-cli', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
assert.ok(existsSync(bin), 'Set DSH_TEST_BIN to an installed official DSH CLI');
const home = mkdtempSync(join(tmpdir(), 'spaces-real-config-'));
console.log(`TEST_HOME=${home}`);
function cli(...args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}
cli('--profile', 'web', '--dump-config');
const webPatch = join(home, 'profiles', 'web', 'cordis.patch.yml');
const webBefore = readFileSync(webPatch, 'utf8');
const webManifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'));
for (const name of ['coding', 'writing']) {
  cpSync(join(home, 'profiles', 'web'), join(home, 'profiles', name), { recursive: true });
  const manifestPath = join(home, 'profiles', name, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // The official CLI supplies its default bundles through its module fallback.
  // This fixture uses the official web composition, without a network install.
  manifest.dsh.profile.bundles = webManifest.dsh.profile.bundles;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const writer = new PatchWriter(home);
  writer.ensureWorkbenchPatch(name);
  writer.ensureWorkbenchPatch(name);
  assertDumpPatched(cli('--profile', name, '--dump-config'), name);
  console.log(`PASS real DSH config and repeat patch: ${name}`);
}
assert.equal(readFileSync(webPatch, 'utf8'), webBefore);
console.log('PASS web patch unchanged');
export { bin, home };
