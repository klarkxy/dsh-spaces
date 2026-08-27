import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ProfileRegistry } from "../src/main/profile-registry.ts";

const temps: string[] = [];

function fakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-"));
  temps.push(dir);
  return dir;
}

function writeProfile(home: string, name: string, bundles: string[]): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dsh: { profile: { bundles } } }),
    "utf8",
  );
  writeFileSync(join(dir, "cordis.patch.yml"), "[]\n", "utf8");
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan pins web as root and hides headless", () => {
  const home = fakeHome();
  writeProfile(home, "web", ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
  writeProfile(home, "coding", ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
  writeProfile(home, "headless", ["@deepseek-ai/dsh-base"]);
  mkdirSync(join(home, "profiles", "node_modules"));

  const registry = new ProfileRegistry(home);
  const names = registry.scan().map((p) => p.name);
  assert.deepEqual(names, ["web", "coding"]);
  assert.equal(registry.scan()[0].kind, "root");
  assert.equal(registry.scan()[1].kind, "workbench");
  assert.equal(registry.scan()[1].needsConversion, true);
});

test("atomic spaces.json write and reorder persist order", () => {
  const home = fakeHome();
  writeProfile(home, "web", ["@deepseek-ai/dsh-web-app"]);
  writeProfile(home, "coding", ["@deepseek-ai/dsh-web-app"]);
  writeProfile(home, "writing", ["@deepseek-ai/dsh-web-app"]);
  const registry = new ProfileRegistry(home);
  registry.updateMeta("coding", { displayName: "Code" });
  registry.updateMeta("writing", { displayName: "Write" });
  registry.reorder(["writing", "coding"]);

  const text = readFileSync(registry.spacesPath(), "utf8");
  const parsed = JSON.parse(text) as { order: string[] };
  assert.deepEqual(parsed.order, ["writing", "coding"]);
  assert.equal(registry.scan()[1].name, "writing");
  assert.equal(registry.scan()[2].name, "coding");
});

test("validateNewName rejects reserved and existing", () => {
  const home = fakeHome();
  writeProfile(home, "coding", ["@deepseek-ai/dsh-web-app"]);
  const registry = new ProfileRegistry(home);
  assert.throws(() => registry.validateNewName("Web"), /match/);
  assert.throws(() => registry.validateNewName("web"), /reserved/);
  assert.throws(() => registry.validateNewName("coding"), /already exists/);
  registry.validateNewName("notes");
});
