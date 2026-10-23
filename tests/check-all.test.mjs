import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertCheckTempRoot, createCheckEnvironment } from '../scripts/check-all.mjs';

const fixtures = [];
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'check-all-test-'));
  fixtures.push(base);
  const repo = join(base, 'repo'); mkdirSync(repo);
  return { base, repo };
}
afterEach(() => {
  for (const base of fixtures.splice(0)) {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    rmSync(base, { recursive: true, force: true });
  }
});

test('Windows full checks reject repository-local temp before creating an environment', () => {
  const { repo } = fixture();
  const local = join(repo, '.sandbox'); mkdirSync(local);
  for (const tempRoot of [repo, local]) assert.throws(() => createCheckEnvironment({ tempRoot, repo, platform: 'win32' }), /outside the repository/);
  // Lexical rejection happens before resolving or reading the real Home.
  assert.throws(() => assertCheckTempRoot(join(homedir(), '.dsh')), /refusing real/);
});

test('Windows temp validation follows directory aliases into the watched repository', () => {
  const { base, repo } = fixture();
  const local = join(repo, 'tmp'); mkdirSync(local);
  const alias = join(base, 'alias');
  symlinkSync(local, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertCheckTempRoot(alias, repo, 'win32'), /outside the repository/);
});

test('external temp creates fresh isolated Home and temp variables without mutating caller environment', () => {
  const { base, repo } = fixture(), env = { DSH_DASHBOARD_SDK_ROOT: 'explicit-sdk', DSH_HOME: 'caller-home' };
  const first = createCheckEnvironment({ tempRoot: base, repo, platform: 'win32', env });
  const second = createCheckEnvironment({ tempRoot: base, repo, platform: 'win32', env });
  assert.notEqual(first.directory, second.directory);
  assert.equal(dirname(first.directory), realpathSync.native(base));
  assert.equal(first.env.TMP, first.directory);
  assert.equal(first.env.TEMP, first.directory);
  assert.equal(first.env.TMPDIR, first.directory);
  assert.equal(first.env.DSH_HOME, join(first.directory, 'home'));
  assert.equal(first.env.DSH_SPACES_HOME, first.env.DSH_HOME);
  assert.equal(first.env.DSH_SPACES_WEB_HOME, first.env.DSH_HOME);
  assert.equal(first.env.DSH_DASHBOARD_SDK_ROOT, 'explicit-sdk');
  assert.deepEqual(env, { DSH_DASHBOARD_SDK_ROOT: 'explicit-sdk', DSH_HOME: 'caller-home' });
});
