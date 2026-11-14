import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { c as createTar } from 'tar';
import { parse } from 'yaml';
import { assertComponentVersions, inspectRelease, publishOnce, releaseContext, validateReleaseChoice, verifyPublished } from '../../scripts/npm-release.mjs';
import { readRegistryJson } from '../../scripts/lib/npm-registry.mjs';

const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'release',
  GITHUB_REPOSITORY: 'klarkxy/dsh-spaces', GITHUB_REF: 'refs/tags/v0.5.0' };
const event = { action: 'published', repository: { full_name: 'klarkxy/dsh-spaces' },
  release: { tag_name: 'v0.5.0', draft: false, prerelease: false } };

test('only a published release with a matching version, ref and prerelease status can publish', () => {
  assert.deepEqual(releaseContext(event, env), { version: '0.5.0', tag: 'latest' });
  assert.deepEqual(releaseContext({ ...event, release: { ...event.release, tag_name: 'v0.5.0-rc.1', prerelease: true } },
    { ...env, GITHUB_REF: 'refs/tags/v0.5.0-rc.1' }), { version: '0.5.0-rc.1', tag: 'next' });
  for (const change of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REPOSITORY: 'someone/fork' }, { GITHUB_ACTIONS: 'false' }]) {
    assert.throws(() => releaseContext(event, { ...env, ...change }));
  }
  assert.throws(() => releaseContext({ ...event, action: 'edited' }, env));
  assert.throws(() => releaseContext({ ...event, release: { ...event.release, draft: true } }, env));
  assert.throws(() => releaseContext({ ...event, release: { ...event.release, prerelease: true } }, env));
  assert.throws(() => validateReleaseChoice('0.5.0+build.1', 'latest'));
  assert.throws(() => validateReleaseChoice('0.5.0; echo hi', 'latest'));
  assert.throws(() => validateReleaseChoice('0.5.0-rc.1', 'latest'));
  assert.throws(() => validateReleaseChoice('0.5.0', 'next'));
});

test('a stale embedded component version blocks the release before packing', () => {
  assertComponentVersions(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
  const root = mkdtempSync(join(tmpdir(), 'spaces-release-versions-'));
  try {
    const files = ['package.json', ...['plugin', 'supervisor', 'view-bridge', 'browser', 'doctor']
      .map(name => `packages/${name}/package.json`)];
    for (const file of files) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), JSON.stringify({ version: '0.5.0' }));
    }
    writeFileSync(join(root, 'packages/browser/package.json'), JSON.stringify({ version: '0.4.0' }));
    assertComponentVersions('0.5.0', root);
    writeFileSync(join(root, 'packages/view-bridge/package.json'), JSON.stringify({ version: '0.4.0' }));
    assert.throws(() => assertComponentVersions('0.5.0', root), /packages\/view-bridge\/package.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publication freezes the archive and verifies public bytes, package identity and channel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spaces-release-test-'));
  try {
    mkdirSync(join(root, 'package'));
    const manifest = {
      name: 'dsh-spaces', version: '0.5.0',
      publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
      repository: { url: 'git+https://github.com/klarkxy/dsh-spaces.git' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    };
    writeFileSync(join(root, 'package/package.json'), JSON.stringify(manifest));
    const filename = 'dsh-spaces-0.5.0.tgz';
    const archive = join(root, filename);
    await createTar({ cwd: root, file: archive, gzip: true }, ['package']);
    const bytes = readFileSync(archive);
    const report = { status: 'packed', plugin: { filename, name: manifest.name, version: manifest.version,
      sha256: createHash('sha256').update(bytes).digest('hex') } };
    const reportFile = join(root, 'pack-report.json');
    writeFileSync(reportFile, JSON.stringify(report));
    const plan = await inspectRelease(reportFile, '0.5.0', 'latest');
    const npmManifest = { name: plan.package, version: plan.version,
      dist: { integrity: plan.integrity, shasum: plan.shasum, tarball: 'https://registry.npmjs.org/dsh-spaces/-/dsh-spaces-0.5.0.tgz' } };
    const fetchManifest = async () => npmManifest;
    await verifyPublished(plan, { fetchManifest, fetchImpl: async () => new Response(bytes) });
    await assert.rejects(verifyPublished(plan, { fetchManifest, fetchImpl: async () => new Response('wrong archive') }), /Downloaded/);
    await assert.rejects(verifyPublished(plan, { fetchManifest: async () => ({ ...npmManifest, name: 'other' }) }), /metadata/);
    await assert.rejects(verifyPublished(plan, {
      fetchManifest: async (_name, version) => version === 'latest' ? { ...npmManifest, version: '0.4.0' } : npmManifest,
      fetchImpl: async () => new Response(bytes),
    }), /tag/);
    await assert.rejects(verifyPublished(plan, {
      fetchManifest: async () => ({ ...npmManifest, dist: { ...npmManifest.dist, tarball: 'https://example.com/package.tgz' } }),
      fetchImpl: async () => assert.fail('must not follow an untrusted registry URL'),
    }), /unexpected/);
    writeFileSync(archive, Buffer.from('changed after packing'));
    await assert.rejects(inspectRelease(reportFile, '0.5.0', 'latest'), /differs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an existing version or registry failure never invokes publication; ambiguous publication is not retried', async () => {
  const plan = { package: 'dsh-spaces', version: '0.5.0' };
  let attempts = 0;
  const publish = () => { attempts++; };
  await assert.rejects(publishOnce(plan, { fetchManifest: async () => ({}), publish }), /already exists/);
  await assert.rejects(publishOnce(plan, { fetchManifest: async () => { throw new Error('HTTP 503'); }, publish }), /503/);
  assert.equal(attempts, 0);
  await assert.rejects(publishOnce(plan, {
    fetchManifest: async () => null,
    publish: () => { attempts++; throw new Error('response lost'); },
  }), /response lost/);
  assert.equal(attempts, 1);
});

test('only explicit registry 404 can mean a version is absent', async () => {
  assert.equal(await readRegistryJson('dsh-spaces', '0.5.0', {
    allowMissing: true, fetchImpl: async () => new Response('', { status: 404 }),
  }), null);
  for (const status of [401, 403, 500]) {
    await assert.rejects(readRegistryJson('dsh-spaces', '0.5.0', {
      allowMissing: true, fetchImpl: async () => new Response('', { status }),
    }), new RegExp(String(status)));
  }
  await assert.rejects(readRegistryJson('dsh-spaces', '0.5.0', {
    fetchImpl: async () => new Response('', { status: 404 }),
  }), /404/);
});

test('release publication gates on CI and packing, and exposes the npm secret only to the publish step', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on, { release: { types: ['published'] } });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.checks.uses, './.github/workflows/ci.yml');
  assert.deepEqual(workflow.jobs.pack.needs, ['prepare', 'checks']);
  assert.deepEqual(workflow.jobs.publish.needs, ['prepare', 'pack']);
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  assert.equal(workflow.jobs.publish.env.NODE_AUTH_TOKEN, undefined);
  const withToken = workflow.jobs.publish.steps.filter(step => step.env?.NODE_AUTH_TOKEN);
  assert.equal(withToken.length, 1);
  assert.match(withToken[0].run, /npm-release\.mjs publish/);
  for (const file of ['ci.yml', 'plugin-distribution.yml']) {
    const reusable = parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'));
    assert.ok('workflow_call' in reusable.on);
  }
});
