import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { removeExactCoreDeclarations } from '../scripts/lib/clean-core-declarations.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'spaces-declarations-'));
  t.after(async () => { assert.equal(resolve(root), root); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('declaration cleanup removes stale emit and preserves adjacent package artifacts', async t => {
  const root = await fixture(t);
  const lib = join(root, 'packages/core/lib');
  await mkdir(join(lib, 'types/shared'), { recursive: true });
  await writeFile(join(lib, 'types/shared/removed.d.ts'), 'export interface Retired {}');
  await writeFile(join(lib, 'index.js'), 'unchanged runtime');
  await writeFile(join(lib, 'index.d.ts'), 'unchanged entry');
  await removeExactCoreDeclarations(root);
  await assert.rejects(readFile(join(lib, 'types/shared/removed.d.ts')), { code: 'ENOENT' });
  assert.equal(await readFile(join(lib, 'index.js'), 'utf8'), 'unchanged runtime');
  assert.equal(await readFile(join(lib, 'index.d.ts'), 'utf8'), 'unchanged entry');
  await removeExactCoreDeclarations(root);
});

for (const redirectedParent of [false, true]) {
  test(`declaration cleanup refuses a redirected ${redirectedParent ? 'parent' : 'output'} and preserves its data`, async t => {
    const root = await fixture(t);
    const outside = join(root, 'outside');
    const link = join(root, redirectedParent ? 'packages/core/lib' : 'packages/core/lib/types');
    await mkdir(join(root, redirectedParent ? 'packages/core' : 'packages/core/lib'), { recursive: true });
    await mkdir(join(outside, 'types'), { recursive: true });
    const sentinel = join(outside, redirectedParent ? 'types/sentinel' : 'sentinel');
    await writeFile(sentinel, 'keep');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(removeExactCoreDeclarations(root), /refusing to remove/);
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  });
}
