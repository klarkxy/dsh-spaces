import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { buildManageRows } from "../src/shared/plugin.ts";
import {
  archiveAbsPath,
  isHubPluginArchive,
  lookupLibraryEntry,
  readPluginLibrary,
  syncLibraryFromProfiles,
  upsertLibraryEntry,
} from "../src/main/plugin-library.ts";
import {
  downloadPlugin,
  listPluginLibrary,
  listProfilePlugins,
  removeDownloadedPlugin,
  setSpacePlugin,
} from "../src/main/plugin-ops.ts";
import { applyAppLocale, t } from "../src/shared/i18n/index.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-lib-"));
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

test("buildManageRows puts locked official plugins first then library checkboxes", () => {
  const rows = buildManageRows(
    [
      {
        id: "urzeye/dsh-outline",
        spec: "dsh-outline",
        packageName: "dsh-outline",
        title: "dsh-outline",
        source: "catalog",
        downloadedAt: "t",
      },
    ],
    [
      { name: "@deepseek-ai/dsh-base", version: "1", protected: true },
      { name: "dsh-outline", version: "2", protected: false },
      { name: "extra-dep", version: "3", protected: false },
    ],
  );
  assert.deepEqual(
    rows.map((row) => ({ id: row.id, enabled: row.enabled, protected: row.protected })),
    [
      { id: "@deepseek-ai/dsh-base", enabled: true, protected: true },
      { id: "urzeye/dsh-outline", enabled: true, protected: false },
      { id: "extra-dep", enabled: true, protected: false },
    ],
  );
});

test("library upsert and archive path stay inside hub/plugins", () => {
  const dir = home();
  const dest = archiveAbsPath(dir, "urzeye/dsh-outline");
  mkdirSync(join(dir, "hub", "plugins"), { recursive: true });
  writeFileSync(dest, "tarball");
  assert.equal(isHubPluginArchive(dir, dest), true);
  assert.equal(isHubPluginArchive(dir, join(dir, "hub", "plugin-catalog.json")), false);
  assert.equal(isHubPluginArchive(dir, join(dir, "hub", "plugins", "..", "plugin-catalog.json")), false);
  upsertLibraryEntry(dir, {
    id: "urzeye/dsh-outline",
    spec: "dsh-outline",
    packageName: "dsh-outline",
    title: "Outline",
    tarball: "hub/plugins/urzeye__dsh-outline.tgz",
    source: "catalog",
    downloadedAt: "t",
  });
  const hit = lookupLibraryEntry(dir, "urzeye/dsh-outline");
  assert.equal(hit?.packageName, "dsh-outline");
  assert.equal(hit?.title, "Outline");
});

test("syncLibraryFromProfiles records extra installed plugins", () => {
  const dir = home();
  writeProfile(
    dir,
    "coding",
    ["@deepseek-ai/dsh-base", "dsh-outline"],
    { "@deepseek-ai/dsh-base": "1", "dsh-outline": "2" },
  );
  const list = listPluginLibrary(dir, ["coding"]);
  assert.equal(list.some((item) => item.packageName === "dsh-outline"), true);
  assert.equal(list.some((item) => item.packageName === "@deepseek-ai/dsh-base"), false);
  const again = syncLibraryFromProfiles(dir, {
    coding: listProfilePlugins(dir, "coding"),
  });
  assert.equal(again.filter((item) => item.packageName === "dsh-outline").length, 1);
});

test("downloadPlugin fetches an npm tarball into the hub library", async () => {
  const dir = home();
  let urls: string[] = [];
  const entry = await downloadPlugin(
    dir,
    { spec: "dsh-outline" },
    {
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.includes("dsh-outline") && !url.endsWith(".tgz")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              name: "dsh-outline",
              "dist-tags": { latest: "1.2.3" },
              versions: { "1.2.3": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-1.2.3.tgz" } } },
            }),
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
        };
      },
    },
  );
  assert.equal(entry.packageName, "dsh-outline");
  assert.equal(entry.source, "manual");
  assert.ok(entry.tarball);
  const bytes = readFileSync(join(dir, entry.tarball!));
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
  assert.ok(urls.some((url) => url.includes("dsh-outline")));
  const second = await downloadPlugin(dir, { spec: "dsh-outline" }, { fetchImpl: async () => {
    throw new Error("should use cached tarball");
  } });
  assert.equal(second.id, entry.id);
});

test("downloadPlugin packs github specs with the injected packer", async () => {
  const dir = home();
  const entry = await downloadPlugin(
    dir,
    { spec: "github:example/git-bundle" },
    {
      packGit: async (_spec, dest) => {
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, "git-tarball");
      },
    },
  );
  assert.equal(entry.spec, "github:example/git-bundle");
  assert.equal(readFileSync(join(dir, entry.tarball!), "utf8"), "git-tarball");
});

test("downloadPlugin refuses likely catalog entries", async () => {
  applyAppLocale("en");
  const dir = home();
  await assert.rejects(
    downloadPlugin(dir, { catalogId: "example/likely" }),
    /not one-click|不能一键/,
  );
});

test("removeDownloadedPlugin refuses plugins still installed on a space", async () => {
  applyAppLocale("en");
  const dir = home();
  writeProfile(dir, "coding", ["dsh-outline"], { "dsh-outline": "1" });
  upsertLibraryEntry(dir, {
    id: "dsh-outline",
    spec: "dsh-outline",
    packageName: "dsh-outline",
    title: "dsh-outline",
    source: "installed",
    downloadedAt: "t",
  });
  await assert.rejects(removeDownloadedPlugin(dir, "dsh-outline", ["coding"]), /installed|仍安装/);
  assert.equal(readPluginLibrary(dir).length, 1);
});

test("setSpacePlugin rejects unknown and protected plugins", async () => {
  applyAppLocale("en");
  const dir = home();
  writeProfile(dir, "coding", ["@deepseek-ai/dsh-web-app"], { "@deepseek-ai/dsh-web-app": "1" });
  await assert.rejects(setSpacePlugin(dir, "coding", "missing-plugin", true, () => false), /No local plugin|本机没有/);
  await assert.rejects(
    setSpacePlugin(dir, "coding", "@deepseek-ai/dsh-web-app", false, () => false),
    /official bundle|拒绝卸载/,
  );
});
