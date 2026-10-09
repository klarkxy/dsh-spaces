import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlueprintDocument, blueprintRecipe, bindDocumentInputs } from '../document.mjs';
import { decodeBlueprintDocument, encodeBlueprintDocument } from '../document-codec.mjs';
import { parseBlueprint as parseStandalone } from '../core.mjs';
import { parseBlueprint as parseV1 } from '../lib/v1/domain.js';

const v2 = {
  kind: 'dsh-blueprint', formatVersion: 2, metadata: { name: 'Composition' },
  packages: [
    { name: 'example-npm', version: '1.0.0', source: 'npm' },
    { name: '@deepseek-ai/dsh-example', version: '0.2.0-rc.2', source: 'builtin' },
  ],
  bundles: ['@deepseek-ai/dsh-example', 'example-npm'],
};
const v1 = {
  kind: 'dsh-blueprint', formatVersion: 1, metadata: { name: 'Preset', version: '1.0.0' },
  packages: [], profile: { base: 'web', bundles: [], patch: [], settings: { example: { theme: 'dark' } } },
};

test('v2 codes and JSON retain native identities/order and are readable by standalone Core', () => {
  const code = encodeBlueprintDocument(v2);
  assert.deepEqual(parseStandalone(code), v2);
  assert.deepEqual(decodeBlueprintDocument(code), v2);
  assert.deepEqual(decodeBlueprintDocument(JSON.stringify(v2)), v2);
  const recipe = blueprintRecipe(v2);
  assert.deepEqual(recipe.document, v2);
  assert.deepEqual(recipe.profile.bundles, v2.bundles);
  assert.equal(recipe.packages[1].source.type, 'builtin');
  assert.equal(recipe.metadata.version, undefined);
  assert.deepEqual(bindDocumentInputs(v2, {}), { patch: [], settings: {} });
  assert.throws(() => bindDocumentInputs(v2, { directory: '/local' }));
});

test('legacy v1 preserves settings and both encodings without rewriting its protocol', () => {
  const expected = parseV1(v1);
  for (const mode of ['J', 'Z', 'shortest']) {
    const code = encodeBlueprintDocument(expected, mode);
    assert.match(code, /^DSHBP1:/);
    assert.deepEqual(decodeBlueprintDocument(code), expected);
  }
  assert.deepEqual(decodeBlueprintDocument(JSON.stringify(v1)), expected);
  assert.deepEqual(bindDocumentInputs(expected, {}).settings, expected.profile.settings);
});

test('format dispatch rejects unknown versions, v2 settings, duplicate members and invalid codes', () => {
  assert.throws(() => parseBlueprintDocument({ ...v2, formatVersion: 3 }));
  assert.throws(() => parseBlueprintDocument({ ...v2, profile: v1.profile }));
  assert.throws(() => decodeBlueprintDocument('{"formatVersion":2,"formatVersion":1}'));
  assert.throws(() => decodeBlueprintDocument('DSHBP3:abc'));
  assert.throws(() => decodeBlueprintDocument('DSHBP2:bad'));
});
