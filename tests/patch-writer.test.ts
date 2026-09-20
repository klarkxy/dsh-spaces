import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { parseDocument } from "yaml";
import {
  PatchForbiddenError,
  PatchVerifyError,
  PatchWriter,
  assertDumpPatched,
  extractRoot,
} from "../src/adapters/node/patch-writer.ts";

const temps: string[] = [];

test("isolation requires a tagged expression, not a lookalike string or relative path", () => {
  for (const root of [
    "dshHomePath('hub/coding/sessions')",
    "hub/coding/sessions",
    JSON.stringify("!!js dshHomePath('hub/coding/sessions')"),
    "!!js dshHomePath('hub\\coding\\sessions')",
  ]) {
    const dump = `- id: session-persistence-jsonl\n  config:\n    root: ${root}\n- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/coding/storages')\n`;
    assert.throws(() => assertDumpPatched(dump, "coding"), PatchVerifyError, root);
  }
});

test("rewriting root retains inline comments and unrelated quoted or multiline expressions", () => {
  const home = fakeHome();
  const dir = profileDir(home, "coding");
  const file = join(dir, "cordis.patch.yml");
  const original = `- id: user-plugin
  config:
    quoted: !!js '"literal # text"'
    multiline: !!js |-
      ({
        value: "kept"
      })
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions') # keep root explanation
`;
  writeFileSync(file, original);
  new PatchWriter(home).ensureWorkbenchPatch("coding");
  const rewritten = readFileSync(file, "utf8");
  assert.match(rewritten, /# keep root explanation/);
  const options = { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] };
  const before = parseDocument(original, options);
  const after = parseDocument(rewritten, options);
  assert.deepEqual(after.errors, []);
  assert.equal(after.getIn([0, "config", "quoted"]), before.getIn([0, "config", "quoted"]));
  assert.equal(after.getIn([0, "config", "multiline"]), before.getIn([0, "config", "multiline"]));
});

test("dynamic config and alias roots cannot be silently discarded", () => {
  for (const config of [
    `!!js "({ root: 'sessions', compression: 'none' })"`,
    `{ root: *oldRoot }`,
  ]) {
    const home = fakeHome();
    const dir = profileDir(home, "coding");
    const file = join(dir, "cordis.patch.yml");
    const original = `- id: user-plugin\n  config:\n    root: &oldRoot old\n- id: session-persistence-jsonl\n  config: ${config}\n`;
    writeFileSync(file, original);
    assert.throws(() => new PatchWriter(home).ensureWorkbenchPatch("coding"), PatchVerifyError);
    assert.equal(readFileSync(file, "utf8"), original);
  }
});

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-"));
  temps.push(home);
  return home;
}

function profileDir(home: string, name: string): string {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function countExactId(body: string, id: string): number {
  return body.split(/\r?\n/).filter((line) => line === `- id: ${id}`).length;
}

test("refuses to patch web", () => {
  const home = fakeHome();
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  writeFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "[]\n");
  const writer = new PatchWriter(home);
  assert.throws(() => writer.ensureWorkbenchPatch("web"), PatchForbiddenError);
  assert.equal(readFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "utf8"), "[]\n");
});

test("writes dual-root !!js overlay and keeps a backup", () => {
  const home = fakeHome();
  const dir = profileDir(home, "coding");
  writeFileSync(join(dir, "cordis.patch.yml"), "- id: keep-me\n  config:\n    foo: 1\n");
  const writer = new PatchWriter(home);
  writer.ensureWorkbenchPatch("coding");
  const body = readFileSync(join(dir, "cordis.patch.yml"), "utf8");
  assert.match(body, /root: !!js dshHomePath\('hub\/coding\/sessions'\)/);
  assert.match(body, /root: !!js dshHomePath\('hub\/coding\/storages'\)/);
  assert.match(body, /keep-me/);
  const backups = readdirSync(dir).filter((name) => name.startsWith("cordis.patch.yml.bak-"));
  assert.equal(backups.length, 1);
});

test("preserves !!js, comments, and unknown config fields; reapply does not duplicate rows", () => {
  const home = fakeHome();
  const dir = profileDir(home, "coding");
  writeFileSync(
    join(dir, "cordis.patch.yml"),
    `# keep this comment
- id: keep-me
  config:
    foo: 1
    expr: !!js process.exit(1)
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')
    extraKeep: 2
`,
  );
  const writer = new PatchWriter(home);
  writer.ensureWorkbenchPatch("coding");
  writer.ensureWorkbenchPatch("coding");
  const body = readFileSync(join(dir, "cordis.patch.yml"), "utf8");
  assert.match(body, /# keep this comment/);
  assert.match(body, /keep-me/);
  assert.match(body, /!!js process\.exit\(1\)/);
  assert.match(body, /extraKeep: 2/);
  assert.match(body, /name: '@deepseek-ai\/dsh-session-persistence-jsonl'/);
  assert.equal(countExactId(body, "session-persistence-jsonl"), 1);
  assert.equal(countExactId(body, "storage-json"), 1);
  assert.match(body, /root: !!js dshHomePath\('hub\/coding\/sessions'\)/);
  assert.match(body, /root: !!js dshHomePath\('hub\/coding\/storages'\)/);
  assert.doesNotMatch(body, /dshHomePath\('sessions'\)/);
});

test("duplicate isolation rows fail instead of merging", () => {
  const home = fakeHome();
  const dir = profileDir(home, "coding");
  const original = `- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;
  writeFileSync(join(dir, "cordis.patch.yml"), original);
  const writer = new PatchWriter(home);
  assert.throws(() => writer.ensureWorkbenchPatch("coding"), /duplicate row session-persistence-jsonl/);
  assert.equal(readFileSync(join(dir, "cordis.patch.yml"), "utf8"), original);
});

test("non-sequence patch fails instead of overwriting as empty", () => {
  const home = fakeHome();
  const dir = profileDir(home, "coding");
  writeFileSync(join(dir, "cordis.patch.yml"), "id: not-a-sequence\n");
  const writer = new PatchWriter(home);
  assert.throws(() => writer.ensureWorkbenchPatch("coding"), PatchVerifyError);
  assert.equal(readFileSync(join(dir, "cordis.patch.yml"), "utf8"), "id: not-a-sequence\n");
});

test("extractRoot reads dump-config blocks", () => {
  const dump = `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;
  assert.equal(extractRoot(dump, "session-persistence-jsonl"), "!!js dshHomePath('hub/coding/sessions')");
  assert.equal(extractRoot(dump, "missing"), null);
});

test("extractRoot does not take root from a later row", () => {
  const dump = `
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;
  assert.equal(extractRoot(dump, "session-persistence-jsonl"), null);
  assert.equal(extractRoot(dump, "storage-json"), "!!js dshHomePath('hub/coding/storages')");
});

test("extractRoot matches exact row id, not a prefix id", () => {
  const dump = `
- id: session-persistence-jsonl-extra
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('elsewhere')
`;
  assert.equal(extractRoot(dump, "session-persistence-jsonl"), "!!js dshHomePath('elsewhere')");
});

test("extractRoot fails on duplicate dump rows", () => {
  const dump = `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
`;
  assert.throws(() => extractRoot(dump, "session-persistence-jsonl"), /duplicate row session-persistence-jsonl/);
});

test("assertDumpPatched accepts the full expected path", () => {
  const dump = `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;
  assert.doesNotThrow(() => assertDumpPatched(dump, "coding"));
});

test("assertDumpPatched rejects missing rows, substring paths, traversal, and suffixes", () => {
  const missing = `
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;
  assert.throws(() => assertDumpPatched(missing, "coding"), PatchVerifyError);

  const evilPrefix = `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('other/hub/coding/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;
  assert.throws(() => assertDumpPatched(evilPrefix, "coding"), /session-persistence-jsonl/);

  const traversal = `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions/../sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;
  assert.throws(() => assertDumpPatched(traversal, "coding"), /session-persistence-jsonl/);

  const suffix = `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions-extra')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;
  assert.throws(() => assertDumpPatched(suffix, "coding"), /session-persistence-jsonl/);

  const extraSegment = `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages/extra')
`;
  assert.throws(() => assertDumpPatched(extraSegment, "coding"), /storage-json/);
});
