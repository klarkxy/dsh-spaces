import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  isProtectedPlugin,
  listAllProfilePlugins,
  listProfilePlugins,
  pluginRemove,
  resolveInstallSpec,
} from "../src/main/plugin-ops.ts";
import { seedCatalog } from "../src/main/plugin-catalog.ts";
import { applyAppLocale, t } from "../src/shared/i18n/index.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-ops-"));
  temps.push(dir);
  return dir;
}

function writeProfile(
  dshHome: string,
  name: string,
  bundles: string[],
  dependencies: Record<string, string> = {},
): void {
  const dir = join(dshHome, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      dependencies,
      dsh: { profile: { bundles } },
    }),
  );
}

test("listProfilePlugins reads bundles then extra dependencies", () => {
  const dir = home();
  writeProfile(
    dir,
    "coding",
    ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-outline"],
    {
      "@deepseek-ai/dsh-base": "0.1.1-rc.2",
      "@deepseek-ai/dsh-web-app": "0.1.1-rc.2",
      "dsh-outline": "1.0.0",
      "extra-dep": "2.0.0",
    },
  );
  const list = listProfilePlugins(dir, "coding");
  assert.deepEqual(
    list.map((item) => item.name),
    ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-outline", "extra-dep"],
  );
  assert.equal(list[0].protected, true);
  assert.equal(list[1].protected, true);
  assert.equal(list[2].protected, false);
  assert.equal(list[2].version, "1.0.0");
});

test("listProfilePlugins rejects unknown profiles", () => {
  const dir = home();
  assert.throws(() => listProfilePlugins(dir, "missing"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, t("errors.unknownProfile", { name: "missing" }));
    return true;
  });
});

test("listAllProfilePlugins returns every named space and empty for broken ones", () => {
  const dir = home();
  writeProfile(dir, "web", ["@deepseek-ai/dsh-web-app"], {
    "@deepseek-ai/dsh-web-app": "0.1.1-rc.2",
  });
  writeProfile(dir, "coding", ["@deepseek-ai/dsh-base", "dsh-outline"], {
    "@deepseek-ai/dsh-base": "0.1.1-rc.2",
    "dsh-outline": "1.0.0",
  });
  mkdirSync(join(dir, "profiles", "broken"), { recursive: true });
  writeFileSync(join(dir, "profiles", "broken", "package.json"), "{");
  const all = listAllProfilePlugins(dir, ["web", "coding", "broken", "missing"]);
  assert.deepEqual(
    all.web.map((item) => item.name),
    ["@deepseek-ai/dsh-web-app"],
  );
  assert.deepEqual(
    all.coding.map((item) => item.name),
    ["@deepseek-ai/dsh-base", "dsh-outline"],
  );
  assert.deepEqual(all.broken, []);
  assert.deepEqual(all.missing, []);
});

test("cannot remove protected official bundles", async () => {
  applyAppLocale("en");
  const dir = home();
  writeProfile(dir, "coding", ["@deepseek-ai/dsh-web-app"]);
  assert.equal(isProtectedPlugin("@deepseek-ai/dsh-web-app"), true);
  await assert.rejects(pluginRemove(dir, "coding", "@deepseek-ai/dsh-web-app"), /official bundle|拒绝卸载/);
  await assert.rejects(pluginRemove(dir, "coding", "-evil"), /not allowed|不合法/);
});

test("resolveInstallSpec uses catalog id not a renderer spec", async () => {
  const dir = home();
  const spec = await resolveInstallSpec(dir, {
    catalogId: "urzeye/dsh-outline",
    spec: "-evil",
  });
  assert.equal(spec, "dsh-outline");
  const likely = seedCatalog().entries.find((entry) => entry.tier === "likely-plugin");
  assert.ok(likely);
  await assert.rejects(resolveInstallSpec(dir, { catalogId: likely.id }), /not one-click|不能一键/);
  await assert.rejects(resolveInstallSpec(dir, { spec: "-foo" }), /not allowed|不合法/);
  const typed = await resolveInstallSpec(dir, { spec: "github:owner/repo" });
  assert.equal(typed, "github:owner/repo");
});
