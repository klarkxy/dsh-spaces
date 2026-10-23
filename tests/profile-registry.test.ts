import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { t } from "../src/shared/i18n/index.ts";
import { ProfileRegistry } from "../src/adapters/node/profile/profile-registry.ts";
import { writeOrdinaryProfile, writeRegisteredSpace } from "./fixtures/space.ts";

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

test("scan lists only spaces registered with createdAt", () => {
  const home = fakeHome();
  writeRegisteredSpace(home, "space-coding");
  writeProfile(home, "web", ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
  writeProfile(home, "notes", ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
  writeProfile(home, "headless", ["@deepseek-ai/dsh-base"]);
  mkdirSync(join(home, "profiles", "node_modules"));

  const registry = new ProfileRegistry(home);
  const names = registry.scan().map((p) => p.name);
  assert.deepEqual(names, ["space-coding"]);
  assert.equal(typeof registry.scan()[0].meta.createdAt, "string");
});

test("scan ignores unregistered profile directories and stale meta", () => {
  const home = fakeHome();
  writeRegisteredSpace(home, "space-coding");
  writeProfile(home, "web", ["@deepseek-ai/dsh-web-app"]);
  writeOrdinaryProfile(home, "notes");
  mkdirSync(join(home, "profiles", "web.before-reset-x"), { recursive: true });
  mkdirSync(join(home, "profiles", "Bad_Name"), { recursive: true });
  // A space-* directory without createdAt is not a space.
  writeOrdinaryProfile(home, "space-x");
  const registry = new ProfileRegistry(home);
  registry.updateMeta("space-x", { displayName: "Legacy", dshVersion: "0.2.0-rc.2" });
  const current = JSON.parse(readFileSync(registry.spacesPath(), "utf8")) as { meta: Record<string, unknown> };
  current.meta["web.before-reset-x"] = { displayName: "Stale", order: 5 };
  writeFileSync(registry.spacesPath(), JSON.stringify(current), "utf8");

  assert.deepEqual(registry.scan().map((p) => p.name), ["space-coding"]);
  // Stale meta stays on disk, it is simply not a space.
  const file = JSON.parse(readFileSync(registry.spacesPath(), "utf8")) as { meta: Record<string, unknown> };
  assert.ok(file.meta["web.before-reset-x"]);
  assert.ok(file.meta["space-x"]);
});

test("a registered space whose profile directory is gone is not listed", () => {
  const home = fakeHome();
  writeRegisteredSpace(home, "space-coding");
  rmSync(join(home, "profiles", "space-coding"), { recursive: true, force: true });
  const registry = new ProfileRegistry(home);
  assert.deepEqual(registry.scan(), []);
});

test("atomic spaces.json write and reorder persist order", () => {
  const home = fakeHome();
  writeRegisteredSpace(home, "space-coding");
  writeRegisteredSpace(home, "space-writing");
  const registry = new ProfileRegistry(home);
  registry.updateMeta("space-coding", { displayName: "Code" });
  registry.updateMeta("space-writing", { displayName: "Write" });
  registry.reorder(["space-writing", "space-coding"]);

  const text = readFileSync(registry.spacesPath(), "utf8");
  const parsed = JSON.parse(text) as { order: string[] };
  assert.deepEqual(parsed.order, ["space-writing", "space-coding"]);
  assert.equal(registry.scan()[0].name, "space-writing");
  assert.equal(registry.scan()[1].name, "space-coding");
});

test("validateNewName rejects reserved and existing", () => {
  const home = fakeHome();
  writeOrdinaryProfile(home, "space-coding");
  const registry = new ProfileRegistry(home);
  assert.throws(() => registry.validateNewName("Web"), { message: t("errors.nameInvalid") });
  assert.throws(() => registry.validateNewName("web"), { message: t("errors.nameReserved", { name: "web" }) });
  assert.throws(() => registry.validateNewName("space-coding"), {
    message: t("errors.profileExists", { name: "space-coding" }),
  });
  registry.validateNewName("space-notes");
});

test("official desktop profile is reserved and cannot be deleted", () => {
  const home = fakeHome();
  writeProfile(home, "desktop", ["@deepseek-ai/dsh-web-app"]);
  const hub = join(home, "hub", "desktop");
  mkdirSync(hub, { recursive: true });
  writeFileSync(join(hub, "marker"), "keep");
  const registry = new ProfileRegistry(home);
  const before = readFileSync(join(home, "profiles", "desktop", "package.json"), "utf8");
  assert.deepEqual(registry.scan(), []);
  assert.throws(() => registry.validateNewName("desktop"));
  assert.throws(() => registry.removeOfficialProfile("desktop"));
  assert.throws(() => registry.removeHubData("desktop"));
  assert.equal(readFileSync(join(home, "profiles", "desktop", "package.json"), "utf8"), before);
  assert.equal(readFileSync(join(hub, "marker"), "utf8"), "keep");
});
