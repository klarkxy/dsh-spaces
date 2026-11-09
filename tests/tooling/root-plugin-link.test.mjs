import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEV_PROFILE, pluginState } from '../../scripts/dev-dsh-web.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const manifest = path => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));

test('linked repository resolves the same plugin, client, remotes and patch as the distribution', t => {
  const home = mkdtempSync(join(tmpdir(), 'spaces-root-link-'));
  try {
    const repo = manifest(root);
    const published = manifest(join(root, 'packages/plugin'));
    assert.equal(repo.name, published.name);
    assert.equal(repo.version, published.version);
    assert.equal(repo.private, true, 'the development root must not be published');
    assert.deepEqual(repo.peerDependencies, published.peerDependencies);
    assert.deepEqual(repo.peerDependenciesMeta, published.peerDependenciesMeta);
    assert.deepEqual(repo.dsh.client, published.dsh.client);
    assert.equal(resolve(root, repo.dsh.bundle.patch), resolve(root, 'packages/plugin', published.dsh.bundle.patch));

    const profile = join(home, 'profiles', DEV_PROFILE);
    const scope = join(profile, 'node_modules/@dsh-spaces');
    mkdirSync(scope, { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'linked-plugin-test',
      dependencies: { [repo.name]: `link:${root}` },
      dsh: { profile: { bundles: [repo.name] } },
    }));
    try {
      symlinkSync(root, join(scope, 'plugin'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      t.skip('This environment does not permit directory links; run with link permission for runtime resolution evidence.');
      return;
    }
    const require = createRequire(join(profile, 'package.json'));
    for (const entry of ['.', './client', './typert', './remote', './space-control', './cordis.patch.yml']) {
      const specifier = entry === '.' ? repo.name : `${repo.name}/${entry.slice(2)}`;
      assert.equal(realpathSync(require.resolve(specifier)), realpathSync(resolve(root, 'packages/plugin', published.exports[entry])));
    }
    assert.deepEqual(pluginState(home), {
      dependency: `link:${root}`,
      inBundles: true,
      installedOnDisk: true,
      linkedToCheckout: true,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('development link inspection does not mistake a copied package for the checkout', () => {
  const home = mkdtempSync(join(tmpdir(), 'spaces-copied-plugin-'));
  try {
    const profile = join(home, 'profiles', DEV_PROFILE);
    const installed = join(profile, 'node_modules/@dsh-spaces/plugin');
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@dsh-spaces/plugin' }));
    assert.equal(pluginState(home).linkedToCheckout, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
