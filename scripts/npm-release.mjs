import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { t as listTar } from 'tar';
import { parse, prerelease, valid } from 'semver';
import { resolveNpmCli } from './pack-spaces-plugin.mjs';
import { readRegistryJson } from './lib/npm-registry.mjs';

const PACKAGE = 'dsh-spaces';
const REPOSITORY = 'klarkxy/dsh-spaces';
const ROOT = resolve(import.meta.dirname, '..');
const COMPONENTS = ['package.json', ...['plugin', 'supervisor', 'view-bridge', 'browser', 'doctor']
  .map(name => `packages/${name}/package.json`)];
const hash = (bytes, algorithm, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

export function validateReleaseChoice(version, tag) {
  if (typeof version !== 'string' || valid(version) !== version || parse(version).build.length) {
    throw new Error('An exact release version without build metadata is required');
  }
  if (tag !== (prerelease(version) ? 'next' : 'latest')) {
    throw new Error('Stable versions require latest; prereleases require next');
  }
}

export function releaseContext(event, env) {
  const release = event.release;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'release' ||
      env.GITHUB_REPOSITORY !== REPOSITORY || event.repository?.full_name !== REPOSITORY ||
      event.action !== 'published' || !release || release.draft !== false ||
      typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v') ||
      env.GITHUB_REF !== `refs/tags/${release.tag_name}`) {
    throw new Error('Publishing requires a published GitHub Release in the Spaces repository');
  }
  const version = release.tag_name.slice(1);
  const tag = prerelease(version) ? 'next' : 'latest';
  validateReleaseChoice(version, tag);
  if (release.prerelease !== Boolean(prerelease(version))) {
    throw new Error('GitHub prerelease status must match the version');
  }
  return { version, tag };
}

export function assertComponentVersions(version, root = ROOT) {
  for (const path of COMPONENTS) {
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (manifest.version !== version) throw new Error(`${path}: version does not match release ${version}`);
  }
}

export async function inspectRelease(reportFile, version, tag) {
  validateReleaseChoice(version, tag);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const artifact = report.plugin;
  if (report.status !== 'packed' || artifact?.name !== PACKAGE || artifact.version !== version ||
      artifact.filename !== `${PACKAGE}-${version}.tgz` || basename(artifact.filename) !== artifact.filename) {
    throw new Error('Pack report does not describe the requested Spaces distribution');
  }
  const archive = join(dirname(resolve(reportFile)), artifact.filename);
  const bytes = readFileSync(archive);
  if (hash(bytes, 'sha256') !== artifact.sha256) throw new Error('Archive differs from the verified pack report');
  const manifests = [];
  await listTar({
    file: archive,
    onReadEntry(entry) {
      if (entry.path !== 'package/package.json') return;
      if (entry.type !== 'File' || entry.size > 256 * 1024) throw new Error('Invalid archive manifest');
      const chunks = [];
      entry.on('data', chunk => chunks.push(chunk));
      entry.on('end', () => manifests.push(Buffer.concat(chunks).toString('utf8')));
    },
  });
  if (manifests.length !== 1) throw new Error('Tarball must contain exactly one package manifest');
  const manifest = JSON.parse(manifests[0]);
  if (manifest.name !== PACKAGE || manifest.version !== version || manifest.private === true ||
      manifest.publishConfig?.access !== 'public' ||
      manifest.publishConfig?.registry !== 'https://registry.npmjs.org/' ||
      manifest.dsh?.bundle?.patch !== './cordis.patch.yml' ||
      manifest.repository?.url !== `git+https://github.com/${REPOSITORY}.git`) {
    throw new Error('Tarball manifest does not match the public Spaces package');
  }
  return {
    package: PACKAGE, version, tag, filename: artifact.filename, archive,
    sha256: hash(bytes, 'sha256'), shasum: hash(bytes, 'sha1'),
    integrity: `sha512-${hash(bytes, 'sha512', 'base64')}`,
  };
}

export async function verifyPublished(plan, { fetchManifest = readRegistryJson, fetchImpl = fetch } = {}) {
  const manifest = await fetchManifest(plan.package, plan.version);
  if (manifest?.name !== plan.package || manifest.version !== plan.version ||
      manifest.dist?.integrity !== plan.integrity || manifest.dist?.shasum !== plan.shasum) {
    throw new Error('Published npm metadata differs from the approved archive');
  }
  const url = new URL(manifest.dist.tarball);
  if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password ||
      url.search || url.hash || !url.pathname.endsWith('.tgz')) {
    throw new Error('npm returned an unexpected tarball URL');
  }
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`npm archive download returned HTTP ${response.status}`); }
  const digest = createHash('sha512');
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 512 * 1024 * 1024) throw new Error('Published archive exceeded the download limit');
    digest.update(chunk);
  }
  if (`sha512-${digest.digest('base64')}` !== plan.integrity) throw new Error('Downloaded npm archive differs from the approved archive');
  const tagged = await fetchManifest(plan.package, plan.tag);
  if (tagged?.name !== plan.package || tagged.version !== plan.version) throw new Error('npm distribution tag does not select the published version');
  return { package: plan.package, version: plan.version, tag: plan.tag, integrity: plan.integrity };
}

export async function publishOnce(plan, { fetchManifest = readRegistryJson, publish = publishNpm } = {}) {
  if (await fetchManifest(plan.package, plan.version, { allowMissing: true })) {
    throw new Error('That npm version already exists; it will not be overwritten or republished');
  }
  publish(plan);
}

function publishNpm(plan) {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('The repository NPM_TOKEN secret is required');
  execFileSync(process.execPath, [resolveNpmCli(process.execPath), 'publish', plan.archive,
    '--ignore-scripts', '--access', 'public', '--tag', plan.tag, '--provenance',
    '--registry=https://registry.npmjs.org/', '--fetch-retries=0', '--fetch-timeout=120000'],
  { stdio: 'inherit', windowsHide: true });
}

async function main() {
  const [mode, reportFile] = process.argv.slice(2);
  if (!['prepare', 'check', 'publish', 'verify'].includes(mode) || (mode !== 'prepare' && !reportFile)) {
    throw new Error('Usage: npm-release.mjs prepare | check|publish|verify pack-report.json');
  }
  let version = process.env.RELEASE_VERSION, tag = process.env.RELEASE_TAG;
  if (mode === 'prepare' || mode === 'publish') {
    const context = releaseContext(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), process.env);
    if (mode === 'publish' && (context.version !== version || context.tag !== tag)) {
      throw new Error('Requested publication differs from the GitHub Release');
    }
    ({ version, tag } = context);
    assertComponentVersions(version);
  }
  if (mode === 'prepare') {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
    console.log(`Release: ${PACKAGE}@${version} (${tag})`);
    return;
  }
  const plan = await inspectRelease(reportFile, version, tag);
  const evidence = join(dirname(resolve(reportFile)), 'publication.json');
  const state = { status: 'checked', ...plan, commit: process.env.GITHUB_SHA ?? null };
  const save = () => writeFileSync(evidence, JSON.stringify(state, null, 2) + '\n');
  save();
  if (mode === 'check') { console.log(`Ready: ${plan.package}@${version} (${tag}), sha256=${plan.sha256}. Nothing published.`); return; }
  if (mode === 'publish') {
    state.status = 'publishing';
    save();
    try {
      await publishOnce(plan);
      state.status = 'published-unverified';
      save();
    } catch (error) { state.status = 'publish-failed-or-unconfirmed'; save(); throw error; }
  }
  try {
    await verifyPublished(plan);
    state.status = 'verified';
    save();
    console.log(`Verified npm archive and ${tag}: ${plan.package}@${version}`);
  } catch (error) { state.status = mode === 'publish' ? 'published-verification-failed' : 'verification-failed'; save(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
