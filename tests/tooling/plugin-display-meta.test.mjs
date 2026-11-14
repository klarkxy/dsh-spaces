import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const manifest = path => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
const published = manifest(join(root, 'packages/plugin'));
const repository = manifest(root);

/** The DSH plugin metadata limits: an icon is SVG, PNG, JPEG or WebP under 256 KiB. */
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
]);
const MAX_ICON_BYTES = 256 * 1024;

test('the distributed plugin declares its icon and localized display text', () => {
  assert.equal(published.icon, './icon.svg');
  assert.equal(published.exports['./icon'], './icon.svg');
  assert.equal(published.exports['./locale/*.json'], './locale/*.json');
  for (const file of ['icon.svg', 'locale/*.json']) {
    assert.ok(published.files.includes(file), `files must publish ${file}`);
  }
});

test('the repository root keeps the same name, version and icon contract as the distributed package', () => {
  assert.equal(repository.name, published.name);
  assert.equal(repository.version, published.version);
  assert.equal(repository.icon, './packages/plugin/icon.svg');
  assert.equal(repository.exports['./locale/*.json'], './packages/plugin/locale/*.json');
});

test('every locale file carries a non-empty title and description', () => {
  const locales = ['en', 'zh'];
  for (const language of locales) {
    const file = join(root, 'packages/plugin', 'locale', `${language}.json`);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(typeof parsed.meta?.title, 'string', `${language}.json meta.title`);
    assert.equal(typeof parsed.meta?.description, 'string', `${language}.json meta.description`);
    assert.ok(parsed.meta.title.trim().length > 0, `${language}.json meta.title is empty`);
    assert.ok(parsed.meta.description.trim().length > 0, `${language}.json meta.description is empty`);
  }
  const english = JSON.parse(readFileSync(join(root, 'packages/plugin', 'locale', 'en.json'), 'utf8'));
  const chinese = JSON.parse(readFileSync(join(root, 'packages/plugin', 'locale', 'zh.json'), 'utf8'));
  assert.notEqual(english.meta.description, chinese.meta.description);
  assert.ok(/[一-鿿]/.test(chinese.meta.description), 'the Chinese description must be translated');
});

test('the declared icon is a self-contained image the DSH metadata reader accepts', () => {
  for (const [base, declared] of [[join(root, 'packages/plugin'), published.icon], [root, repository.icon]]) {
    const manifestDir = base;
    assert.ok(!/^([A-Za-z][A-Za-z\d+.-]*:|[/\\])/.test(declared), `${declared} must be a relative path`);
    const target = resolve(manifestDir, declared);
    const local = relative(realpathSync(manifestDir), realpathSync(target));
    assert.ok(local !== '..' && !local.startsWith(`..${sep}`), `${declared} must stay inside its manifest directory`);
    const mediaType = ICON_MEDIA_TYPES.get(target.slice(target.lastIndexOf('.')).toLowerCase());
    assert.ok(mediaType !== undefined, `${declared} must be SVG, PNG, JPEG or WebP`);
    assert.ok(statSync(target).size <= MAX_ICON_BYTES, `${declared} exceeds 256 KiB`);
    const svg = readFileSync(target, 'utf8');
    if (mediaType === 'image/svg+xml') {
      assert.ok(!/<image\b/.test(svg), `${declared} must be self-contained`);
      assert.ok(!/https?:\/\//.test(svg.replace(/xmlns="[^"]*"/g, '')), `${declared} must not reference remote assets`);
    }
  }
});

test('a linked install resolves the icon and locale resources the DSH metadata reader requests', t => {
  const home = mkdtempSync(join(tmpdir(), 'spaces-display-meta-'));
  try {
    const scope = join(home, 'node_modules');
    mkdirSync(scope, { recursive: true });
    writeFileSync(join(home, 'package.json'), JSON.stringify({ name: 'display-meta-test', private: true }));
    try {
      symlinkSync(join(root, 'packages/plugin'), join(scope, 'dsh-spaces'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      t.skip('This environment does not permit directory links; run with link permission for resolution evidence.');
      return;
    }
    const require = createRequire(join(home, 'package.json'));
    const resolved = {
      manifest: require.resolve('dsh-spaces/package.json'),
      english: require.resolve('dsh-spaces/locale/en.json'),
      chinese: require.resolve('dsh-spaces/locale/zh.json'),
      icon: require.resolve('dsh-spaces/icon'),
    };
    assert.equal(realpathSync(resolved.manifest), realpathSync(join(root, 'packages/plugin', 'package.json')));
    assert.equal(realpathSync(resolved.english), realpathSync(join(root, 'packages/plugin', 'locale', 'en.json')));
    assert.equal(realpathSync(resolved.chinese), realpathSync(join(root, 'packages/plugin', 'locale', 'zh.json')));
    assert.equal(realpathSync(resolved.icon), realpathSync(join(root, 'packages/plugin', 'icon.svg')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
