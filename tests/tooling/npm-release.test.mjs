import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { c as createTar } from 'tar';
import { parse } from 'yaml';
import { inspectRelease, validateReleaseChoice, verifyPublished } from '../../scripts/npm-release.mjs';

test('release inputs cannot be shell commands or put prereleases on latest', () => {
  assert.throws(() => validateReleaseChoice('latest', 'next'));
  assert.throws(() => validateReleaseChoice('0.5.0', 'next; echo hi'));
  assert.throws(() => validateReleaseChoice('0.5.0-rc.1', 'latest'));
  validateReleaseChoice('0.5.0-rc.1', 'next');
});

test('publication uses the checked tarball and verifies public bytes, identity and tag', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spaces-release-test-'));
  try {
    mkdirSync(join(root, 'package'));
    const manifest = {
      name: '@dsh-spaces/plugin', version: '0.5.0', publishConfig: { access: 'public' },
      repository: { url: 'git+https://github.com/klarkxy/dsh-spaces.git' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    };
    writeFileSync(join(root, 'package/package.json'), JSON.stringify(manifest));
    const filename = 'dsh-spaces-plugin-0.5.0.tgz';
    const archive = join(root, filename);
    await createTar({ cwd: root, file: archive, gzip: true }, ['package']);
    const bytes = readFileSync(archive);
    const report = { status: 'packed', plugin: { filename, name: manifest.name, version: manifest.version, sha256: createHash('sha256').update(bytes).digest('hex') } };
    const reportFile = join(root, 'pack-report.json');
    writeFileSync(reportFile, JSON.stringify(report));
    const plan = await inspectRelease(reportFile, '0.5.0', 'next');
    const npmManifest = { name: plan.package, version: plan.version, dist: { integrity: plan.integrity, shasum: plan.shasum, tarball: 'https://registry.npmjs.org/@dsh-spaces/plugin/-/plugin-0.5.0.tgz' } };
    const fetchManifest = async () => npmManifest;
    await verifyPublished(plan, { fetchManifest, fetchImpl: async () => new Response(bytes) });
    await assert.rejects(verifyPublished(plan, { fetchManifest, fetchImpl: async () => new Response('wrong archive') }), /Downloaded/);
    await assert.rejects(verifyPublished(plan, { fetchManifest: async () => ({ ...npmManifest, name: 'other' }) }), /metadata/);
    writeFileSync(archive, Buffer.from('changed after packing'));
    await assert.rejects(inspectRelease(reportFile, '0.5.0', 'next'), /differs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the npm workflow is opt-in, gates on CI, and uses repository-bound OIDC', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.equal(workflow.jobs.checks.uses, './.github/workflows/ci.yml');
  assert.equal(workflow.jobs.pack.needs, 'checks');
  assert.equal(workflow.jobs.publish.needs, 'pack');
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  assert.equal(workflow.jobs.publish.environment, 'npm');
});
