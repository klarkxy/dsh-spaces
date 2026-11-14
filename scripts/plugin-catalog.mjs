import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { valid, validRange } from 'semver';
import { z } from 'zod';
import { catalogEntrySchema } from '../src/shared/workbench-product-schemas.ts';
import { readRegistryJson } from './lib/npm-registry.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const CATEGORIES = ['workflow', 'sessions', 'models', 'dev', 'interface', 'media', 'other'];
const name = z.string().max(200).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
const exact = z.string().refine(value => valid(value) === value, 'exact version required');
const https = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.href.includes('@');
}, 'public HTTPS URL required');
const localized = max => z.object({ zh: z.string().trim().min(1).max(max), en: z.string().trim().min(1).max(max) }).strict();
const tested = z.object({
  pluginVersion: exact, dshVersion: exact,
  platform: z.string().trim().min(1).max(80), evidence: https,
}).strict();
const contribution = z.object({
  package: name, category: z.enum(CATEGORIES),
  title: localized(80), summary: localized(500),
  tested: tested.optional(),
}).strict();
const sourceSchema = z.object({
  schemaVersion: z.literal(1), plugins: z.array(contribution).min(1).max(1024),
}).strict();

export function parseSource(value) {
  const source = sourceSchema.parse(value);
  const names = new Set();
  for (const row of source.plugins) {
    if (names.has(row.package)) throw new Error(`Duplicate package: ${row.package}`);
    names.add(row.package);
  }
  return source;
}

export function sourceHash(source) {
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

function repositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') throw new Error('The npm manifest must declare a public repository URL');
  const normalized = raw.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  return https.parse(normalized);
}

export function catalogEntry(row, manifest) {
  if (manifest?.name !== row.package || valid(manifest.version) !== manifest.version ||
      !manifest.dsh?.bundle?.patch || typeof manifest.dsh.bundle.patch !== 'string') {
    throw new Error(`${row.package}: npm identity, exact version or DSH bundle declaration is invalid`);
  }
  const url = repositoryUrl(manifest.repository);
  const repo = new URL(url).pathname.replace(/^\/|\/$/g, '') || new URL(url).hostname;
  const author = typeof manifest.author === 'string' ? manifest.author.replace(/\s*<.*$/, '').trim() : manifest.author?.name;
  const scripts = manifest.scripts ?? {};
  const range = value => typeof value === 'string' && validRange(value) ? value : undefined;
  return catalogEntrySchema.parse({
    id: row.package, packageName: row.package, repo, url,
    owner: author || (row.package.startsWith('@') ? row.package.slice(1).split('/')[0] : repo.split('/')[0]),
    tier: 'verified-npm', installMethod: 'npm', installSpec: `${row.package}@${manifest.version}`,
    runsBuildScript: ['preinstall', 'install', 'postinstall'].some(key => typeof scripts[key] === 'string'),
    title: row.title.zh, titleEn: row.title.en,
    description: row.summary.en, summary: row.summary.zh, summaryEn: row.summary.en,
    category: row.category, tags: [row.title.zh, row.title.en, row.category], stars: 0,
    license: typeof manifest.license === 'string' ? manifest.license : undefined,
    hasClient: Boolean(manifest.dsh?.client),
    dshRange: range(manifest.engines?.dsh), nodeRange: range(manifest.engines?.node),
    ...(row.tested ? { tested: row.tested } : {}),
  });
}

export async function buildCatalog(source, { fetchManifest = readRegistryJson, now = () => new Date() } = {}) {
  source = parseSource(source);
  // Bounded sequential reads make a failed publisher or registry response stop
  // the build before any generated file is written.
  const entries = [];
  for (const row of source.plugins) entries.push(catalogEntry(row, await fetchManifest(row.package, 'latest')));
  return { meta: { schemaVersion: 1, generatedAt: now().toISOString(), count: entries.length, contentHash: sourceHash(source) }, entries };
}

export function checkCatalog(source, catalog) {
  source = parseSource(source);
  if (catalog?.meta?.schemaVersion !== 1 || catalog.meta.contentHash !== sourceHash(source) ||
      !Number.isFinite(Date.parse(catalog.meta.generatedAt)) || catalog.meta.count !== source.plugins.length ||
      !Array.isArray(catalog.entries) || catalog.entries.length !== source.plugins.length) {
    throw new Error('Generated catalog is stale or malformed; run npm run catalog:build');
  }
  source.plugins.forEach((row, index) => {
    const entry = catalogEntrySchema.parse(catalog.entries[index]);
    if (entry.id !== row.package || entry.packageName !== row.package || entry.title !== row.title.zh ||
        entry.titleEn !== row.title.en || entry.summary !== row.summary.zh || entry.summaryEn !== row.summary.en ||
        entry.description !== row.summary.en || entry.category !== row.category ||
        JSON.stringify(entry.tested) !== JSON.stringify(row.tested) ||
        entry.installMethod !== 'npm' || !entry.installSpec?.startsWith(`${row.package}@`) ||
        !valid(entry.installSpec.slice(row.package.length + 1))) {
      throw new Error(`${row.package}: generated entry does not match the contribution`);
    }
  });
  return catalog;
}

export async function verifyCatalog(source, catalog, fetchManifest = readRegistryJson) {
  checkCatalog(source, catalog);
  for (const [index, entry] of catalog.entries.entries()) {
    const version = entry.installSpec.slice(entry.packageName.length + 1);
    const actual = catalogEntry(source.plugins[index], await fetchManifest(entry.packageName, version));
    if (JSON.stringify(actual) !== JSON.stringify(entry)) throw new Error(`${entry.id}: npm metadata differs from the checked catalog`);
  }
}

async function main() {
  const mode = process.argv[2];
  if (!['build', 'check', 'verify'].includes(mode)) throw new Error('Usage: plugin-catalog.mjs build|check|verify');
  const source = parseSource(JSON.parse(readFileSync(resolve(ROOT, 'catalog/plugins.json'), 'utf8')));
  const output = resolve(ROOT, 'catalog/index.json');
  if (mode === 'build') writeFileSync(output, JSON.stringify(await buildCatalog(source), null, 2) + '\n');
  const catalog = JSON.parse(readFileSync(output, 'utf8'));
  if (mode === 'verify') await verifyCatalog(source, catalog); else checkCatalog(source, catalog);
  console.log(`Catalog ${mode}: ${catalog.entries.length} packages; listing is not runtime compatibility certification.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
