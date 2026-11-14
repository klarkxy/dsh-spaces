import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseSource, buildCatalog, checkCatalog, verifyCatalog } from '../../scripts/plugin-catalog.mjs';

const row = {
  package: '@another-author/example', category: 'workflow',
  title: { zh: '示例', en: 'Example' }, summary: { zh: '一个插件。', en: 'A plugin.' },
};
const source = () => ({ schemaVersion: 1, plugins: [structuredClone(row)] });
const manifest = () => ({
  name: row.package, version: '1.2.3', repository: { url: 'git+https://gitlab.com/another-author/example.git' },
  author: { name: 'Another Author' }, license: 'MIT', engines: { dsh: '>=0.2.0-rc.2' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
});

test('community entries accept independent authors and preserve public metadata', async () => {
  const catalog = await buildCatalog(source(), { fetchManifest: async () => manifest() });
  checkCatalog(source(), catalog);
  assert.equal(catalog.entries[0].owner, 'Another Author');
  assert.equal(catalog.entries[0].url, 'https://gitlab.com/another-author/example');
  assert.equal(catalog.entries[0].installSpec, '@another-author/example@1.2.3');
  assert.equal(catalog.entries[0].title, '示例');
  assert.equal(catalog.entries[0].tested, undefined);
  await verifyCatalog(source(), catalog, async () => manifest());
});

test('source rejects commands, duplicates and unsubstantiated testing labels', () => {
  assert.throws(() => parseSource({ ...source(), plugins: [{ ...row, package: 'file:../other' }] }));
  assert.throws(() => parseSource({ ...source(), plugins: [row, row] }), /Duplicate/);
  assert.throws(() => parseSource({ ...source(), plugins: [{ ...row, tested: true }] }));
  assert.throws(() => parseSource({ ...source(), plugins: [{ ...row, tested: { pluginVersion: 'latest' } }] }));
});

test('package identity and bundle declarations are checked before generating a directory', async () => {
  await assert.rejects(buildCatalog(source(), { fetchManifest: async () => ({ ...manifest(), name: 'other' }) }), /identity/);
  await assert.rejects(buildCatalog(source(), { fetchManifest: async () => ({ ...manifest(), dsh: {} }) }), /bundle/);
  await assert.rejects(buildCatalog(source(), { fetchManifest: async () => { throw new Error('registry down'); } }), /registry down/);
});

test('curated edits require a refreshed generated index; tested claims stay version-specific', async () => {
  const input = source();
  input.plugins[0].tested = { pluginVersion: '1.0.0', dshVersion: '0.2.2-rc.1', platform: 'Windows', evidence: 'https://example.org/report' };
  const catalog = await buildCatalog(input, { fetchManifest: async () => manifest() });
  assert.equal(catalog.entries[0].tested.pluginVersion, '1.0.0');
  input.plugins[0].summary.en = 'Changed';
  assert.throws(() => checkCatalog(input, catalog), /stale/);
});

test('the shipped community index is derived from the reviewed contribution list', () => {
  const input = JSON.parse(readFileSync(new URL('../../catalog/plugins.json', import.meta.url)));
  const catalog = JSON.parse(readFileSync(new URL('../../catalog/index.json', import.meta.url)));
  checkCatalog(input, catalog);
  assert.equal(catalog.entries.some(entry => entry.id.startsWith('example/')), false);
});
