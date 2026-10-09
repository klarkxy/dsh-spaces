import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, MAX_SHARE } from '../codec.mjs';

test('large malformed whitespace rejects without backtracking and raw byte limits remain intact', { timeout: 5000 }, () => {
  for (const whitespace of [' '.repeat(1024 * 1024), '\t\r\n'.repeat(300000)]) {
    assert.throws(() => decode('DSHBP2:a' + whitespace + 'a'), { code: 'encoding' });
  }
  const code = encode({ ok: true });
  assert.deepEqual(decode(' '.repeat(400000) + code + '\t'.repeat(400000)), { ok: true });
  assert.throws(() => decode(' '.repeat(MAX_SHARE) + code), { code: 'size' });
  assert.throws(() => decode('中'.repeat(Math.ceil(MAX_SHARE / 3))), { code: 'size' });
});
