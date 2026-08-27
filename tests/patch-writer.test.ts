import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { PatchForbiddenError, PatchWriter, extractRoot } from "../src/main/patch-writer.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("refuses to patch web", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-"));
  temps.push(home);
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  writeFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "[]\n");
  const writer = new PatchWriter(home);
  assert.throws(() => writer.ensureWorkbenchPatch("web"), PatchForbiddenError);
  assert.equal(readFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "utf8"), "[]\n");
});

test("writes dual-root !!js overlay and keeps a backup", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-"));
  temps.push(home);
  const dir = join(home, "profiles", "coding");
  mkdirSync(dir, { recursive: true });
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
