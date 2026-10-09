import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { validate } from '../blueprint.mjs';
import { decode, encode } from '../codec.mjs';

const sample = name => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
test('shipped protocol vectors decode to the documented no-op blueprint', () => {
  const expected = validate(JSON.parse(sample('empty.dsh-blueprint.json')));
  assert.deepEqual(expected.packages, []); assert.deepEqual(expected.bundles, []);
  assert.deepEqual(validate(decode(sample('empty.code.txt'))), expected);
});
test('code vector is canonical Base64url carrying one raw DEFLATE stream', () => {
  const expected = JSON.parse(sample('empty.dsh-blueprint.json'));
  const code = sample('empty.code.txt').trim();
  assert.match(code, /^DSHBP2:[A-Za-z0-9_-]+$/);
  const payload = code.slice('DSHBP2:'.length), bytes = Buffer.from(payload, 'base64url');
  assert.equal(bytes.toString('base64url'), payload);
  const decoded = inflateRawSync(bytes, {info:true});
  assert.equal(decoded.engine.bytesWritten, bytes.length);
  assert.deepEqual(JSON.parse(decoded.buffer.toString('utf8')), expected);
  assert.deepEqual(decode(encode(validate(expected))), expected);
});
