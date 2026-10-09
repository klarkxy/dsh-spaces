import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { decode, encode, parseJson, MAX_JSON, MAX_SHARE } from '../codec.mjs';
import { validate } from '../blueprint.mjs';
const bp = (packages = [], bundles = packages.map(p => p.name)) => ({ kind: 'dsh-blueprint', formatVersion: 2,
  metadata: { name: '中文测试' }, packages, bundles });
const pkg = name => ({ name, version: '1.2.3', source: 'npm' });
test('compressed code round trip', () => {
  const v = bp(); v.metadata.description = '😀中文';
  assert.deepEqual(decode(encode(v)), v);
});
for (const [name, value] of [
  ['duplicate keys', '{"a":1,"a":2}'], ['escaped duplicate keys', '{"a":1,"\\u0061":2}'],
  ['prototype member', '{"__proto__":{}}'], ['BOM', '\ufeff{}'], ['trailing comma', '{"a":1,}'],
  ['trailing bytes', '{}x'], ['unsafe integer', '9007199254740992'], ['infinity', '1e999'],
  ['lone surrogate', '"\\ud800"'], ['literal control', '"\n"'], ['too deep', '['.repeat(70) + '0' + ']'.repeat(70)],
  ['non-JSON whitespace', '\u00a0{}'], ['bad number', '01'], ['YAML', 'a: 1'], ['comment', '{/*x*/}'],
]) test(`strict parser rejects ${name}`, () => assert.throws(() => parseJson(value)));
test('negative zero is normalized', () => assert.equal(Object.is(parseJson('-0'), -0), false));
test('literal and escaped Unicode survive', () => assert.equal(parseJson('"中文\\ud83d\\ude00"'), '中文😀'));
test('empty and padded payloads reject', () => { for (const code of ['DSHBP2:', encode(bp())+'=']) assert.throws(() => decode(code), {code:'encoding'}); });
test('noncanonical base64 rejects before inflation', () => { for (const payload of ['e31','A']) assert.throws(() => decode('DSHBP2:'+payload), {code:'base64'}); });
test('raw JSON and alternate encoding tags reject', () => { for (const code of [JSON.stringify(bp()),'DSHBP2:J:e30','DSHBP2:Z:e30']) assert.throws(() => decode(code), {code:'encoding'}); });
test('only outer ASCII whitespace is ignored', () => { const code=encode(bp()); assert.deepEqual(decode(' \t\r\n'+code+'\n'),bp()); for(const value of [code.slice(0,10)+' '+code.slice(10),'\u00a0'+code]) assert.throws(()=>decode(value),{code:'encoding'}); });
test('v1 and future code versions reject', () => { for (const code of ['DSHBP1:e30', 'DSHBP3:e30']) assert.throws(() => decode(code)); });
test('invalid UTF8 rejects', () => assert.throws(() => decode(`DSHBP2:${deflateRawSync(Buffer.from([0xff])).toString('base64url')}`), {code:'utf8'}));
test('trailing compressed stream rejects', () => assert.throws(() => decode(`DSHBP2:${Buffer.concat([deflateRawSync(Buffer.from('{}')), Buffer.from('x')]).toString('base64url')}`), {code:'deflate'}));
test('decompression bound is enforced', () => assert.throws(() => decode(`DSHBP2:${deflateRawSync(Buffer.alloc(MAX_JSON + 1, 32)).toString('base64url')}`), {code:'deflate'}));
test('unknown execution fields and unspecific versions reject', () => {
  assert.throws(() => validate({ ...bp(), postInstall: 'run something' }));
  assert.throws(() => validate(bp([{ ...pkg('x'), version: 'latest' }])));
  assert.throws(() => validate(bp([{ ...pkg('x'), version: '1.2.3-01' }])));
  assert.throws(() => validate(bp([pkg('@klarkxy/dsh-blueprint')])));
});
test('numeric package names and sparse arrays reject without coercion', () => {
  assert.throws(() => validate(bp([{ ...pkg('x'), name: 123 }])));
  const v = bp(); v.bundles = new Array(1); assert.throws(() => validate(v));
});
test('exactly 64 container levels are accepted', () => {
  assert.doesNotThrow(() => parseJson('['.repeat(64) + '0' + ']'.repeat(64)));
  assert.throws(() => parseJson('['.repeat(65) + '0' + ']'.repeat(65)));
});
test('invalid document roots fail with a bounded validation error', () => {
  for (const value of [null,false,1,'x',[]]) assert.throws(()=>validate(value),error=>error.code==='shape');
});

test('blueprint revision is rejected while exact package versions remain required', () => {
  const document = bp([pkg('a')]);
  assert.deepEqual(validate(document).metadata, {name:'中文测试'});
  assert.throws(()=>validate({...document,metadata:{...document.metadata,version:'1.0.0'}}), {code:'shape'});
  assert.throws(()=>validate(bp([{...pkg('a'),version:'latest'}])), {code:'package'});
});
