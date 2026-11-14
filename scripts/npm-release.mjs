import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { t as listTar } from 'tar';
import { prerelease, valid } from 'semver';
import { resolveNpmCli } from './pack-spaces-plugin.mjs';
import { readRegistryJson } from './lib/npm-registry.mjs';

const PACKAGE = '@dsh-spaces/plugin';
const REPOSITORY = 'klarkxy/dsh-spaces';
const hash = (bytes, algorithm, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

export function validateReleaseChoice(version, tag) {
  if (typeof version !== 'string' || valid(version) !== version) throw new Error('An exact release version is required');
  if (!['next', 'latest'].includes(tag)) throw new Error('Release tag must be next or latest');
  if (tag === 'latest' && prerelease(version)) throw new Error('A prerelease version cannot use latest');
}

export async function inspectRelease(reportFile, version, tag) {
  validateReleaseChoice(version, tag);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const artifact = report.plugin;
  if (report.status !== 'packed' || artifact?.name !== PACKAGE || artifact.version !== version ||
      typeof artifact.filename !== 'string' || basename(artifact.filename) !== artifact.filename ||
      !/^dsh-spaces-plugin-[0-9A-Za-z.+-]+\.tgz$/.test(artifact.filename)) {
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
      manifest.publishConfig?.access !== 'public' || !manifest.dsh?.bundle?.patch ||
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
  if (url.origin !== 'https://registry.npmjs.org' || url.username || !url.pathname.endsWith('.tgz')) {
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

async function main() {
  const [mode, reportFile] = process.argv.slice(2);
  if (!['check', 'publish', 'verify'].includes(mode) || !reportFile) throw new Error('Usage: npm-release.mjs check|publish|verify pack-report.json (RELEASE_VERSION and RELEASE_TAG required)');
  const plan = await inspectRelease(reportFile, process.env.RELEASE_VERSION, process.env.RELEASE_TAG);
  const evidence = join(dirname(resolve(reportFile)), 'publication.json');
  const state = { status: 'checked', ...plan, commit: process.env.GITHUB_SHA ?? null };
  const save = () => writeFileSync(evidence, JSON.stringify(state, null, 2) + '\n');
  save();
  if (mode === 'check') { console.log(`Ready: ${plan.package}@${plan.version} (${plan.tag}), sha256=${plan.sha256}. Nothing published.`); return; }
  if (mode === 'publish') {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
        process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== 'refs/heads/main') {
      throw new Error('Publishing requires the explicitly dispatched main-branch workflow in the Spaces repository');
    }
    if (await readRegistryJson(plan.package, plan.version, { allowMissing: true })) throw new Error('That npm version already exists; it will not be overwritten or republished');
    const npm = resolveNpmCli(process.execPath);
    state.status = 'publishing';
    save();
    try {
      execFileSync(process.execPath, [npm, 'publish', plan.archive, '--ignore-scripts', '--access', 'public',
        '--tag', plan.tag, '--provenance', '--registry=https://registry.npmjs.org/'],
      { stdio: 'inherit', windowsHide: true });
      state.status = 'published-unverified';
      save();
    } catch (error) { state.status = 'publish-failed-or-unconfirmed'; save(); throw error; }
  }
  try {
    await verifyPublished(plan);
    state.status = 'verified';
    save();
    console.log(`Verified npm archive and ${plan.tag}: ${plan.package}@${plan.version}`);
  } catch (error) { state.status = mode === 'publish' ? 'published-verification-failed' : 'verification-failed'; save(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
