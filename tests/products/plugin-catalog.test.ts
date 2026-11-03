import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  CATALOG_CACHE_FILE,
  isCompatibleCatalog,
  isInstallableEntry,
  isSafeSpec,
  loadPluginCatalog,
  parseAnyCatalog,
  parseCatalog,
  parseGitHubRepo,
  readLocalPluginCatalog,
  resolveCatalogUrl,  seedCatalog,
  type CatalogFetcher,
} from "../../src/adapters/node/products/plugin-catalog.ts";
import { parseCatalogUrl, readSettings, writeSettings as saveSettings } from "../../src/adapters/node/home/hub-settings.ts";
import {  isBareNpmPackageName,
  isGitSpec,
  matchesPluginQuery,
  pluginDisplayName,
} from "../../src/shared/plugin.ts";
import { DEFAULT_HUB_SETTINGS, DEFAULT_PLUGIN_CATALOG_URL } from "../../src/shared/types.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-catalog-"));
  temps.push(dir);
  return dir;
}

test("rejects unsafe plugin specs", () => {
  assert.equal(isSafeSpec(""), false);
  assert.equal(isSafeSpec("-foo"), false);
  assert.equal(isSafeSpec("a".repeat(201)), false);
  assert.equal(isSafeSpec("pkg; rm -rf /"), false);
  assert.equal(isSafeSpec("dsh-outline"), true);
  assert.equal(isSafeSpec("dsh-outline@1.2.3"), true);
  assert.equal(isSafeSpec("@liustack/modlens"), true);
  assert.equal(isSafeSpec("github:example/git-bundle"), true);
  assert.equal(isSafeSpec("github:owner/repo#path:/plugins/foo"), true);
});

test("git specs are the github: shorthand", () => {
  assert.equal(isGitSpec("github:example/git-bundle"), true);
  assert.equal(isGitSpec("dsh-outline"), false);
});


test("isBareNpmPackageName accepts names and rejects tags or git specs", () => {
  assert.equal(isBareNpmPackageName("dsh-outline"), true);
  assert.equal(isBareNpmPackageName("@nanmicoder/dsh-plugin-market"), true);
  assert.equal(isBareNpmPackageName("dsh-outline@1.2.3"), false);
  assert.equal(isBareNpmPackageName("dsh-outline@latest"), false);
  assert.equal(isBareNpmPackageName("github:example/git-bundle"), false);
});

test("plugin search matches tokenized names without pinning aliases", () => {
  const autoevo = {
    id: "klarkxy/dsh-plugin-autoevo",
    repo: "klarkxy/dsh-plugin-autoevo",
    owner: "klarkxy",
    packageName: "dsh-plugin-autoevo",
    description: "发现、探索、审查、升级。",
    tags: ["dsh-plugin", "auto-evolution"],
  };
  assert.equal(matchesPluginQuery(autoevo, "dsh-plugin-evo"), true);
  assert.equal(matchesPluginQuery(autoevo, "klarkxy/dsh-plugin-evo"), true);
  assert.equal(matchesPluginQuery(autoevo, "modlens"), false);
});

test("seed catalog parses and only verified entries are one-click installable", () => {
  const seed = seedCatalog();
  assert.equal(seed.meta.schemaVersion, 1);
  assert.ok(seed.entries.length >= 5);
  const npm = seed.entries.find((item) => item.id === "urzeye/dsh-outline");
  assert.ok(npm);
  assert.equal(isInstallableEntry(npm), true);
  const likely = seed.entries.find((item) => item.tier === "likely-plugin");
  assert.ok(likely);
  assert.equal(isInstallableEntry(likely), false);
  const related = seed.entries.find((item) => item.tier === "related");
  assert.ok(related);
  assert.equal(isInstallableEntry(related), false);
});

test("parseCatalog skips broken entries and refuses a newer major schema", () => {
  const parsed = parseCatalog({
    meta: { schemaVersion: 1, generatedAt: "t", count: 2, contentHash: "x" },
    entries: [
      { id: "ok/one", repo: "ok/one", owner: "ok", url: "https://example.com/ok", tier: "verified-npm", installMethod: "npm", installSpec: "ok-one" },
      { id: "bad" },
      { id: "ok/one", repo: "dup", owner: "dup", url: "https://example.com/dup", tier: "verified-npm", installMethod: "npm", installSpec: "dup" },
    ],
  });
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].id, "ok/one");
  assert.throws(() => parseCatalog({ meta: { schemaVersion: 2 } }), /unsupported plugin catalog schema/);
  assert.equal(isCompatibleCatalog({ schemaVersion: 1, generatedAt: "", count: 0, contentHash: "" }), true);
  assert.equal(isCompatibleCatalog({ schemaVersion: 2, generatedAt: "", count: 0, contentHash: "" }), false);
});

test("loadPluginCatalog falls back to seed when fetch fails", async () => {
  const dir = home();
  const fail: CatalogFetcher = async () => {
    throw new Error("offline");
  };
  const snap = await loadPluginCatalog(dir, { fetchImpl: fail });
  assert.equal(snap.source, "seed");
  assert.ok(snap.entries.some((item) => item.installSpec === "dsh-outline"));
});

test("loadPluginCatalog caches a remote document and reuses it on 304", async () => {
  const dir = home();
  const catalog = {
    meta: { schemaVersion: 1, generatedAt: "t", count: 1, contentHash: "h" },
    entries: [
      {
        id: "remote/pkg",
        repo: "remote/pkg",
        owner: "remote",
        url: "https://example.com/pkg",
        tier: "verified-npm",
        installMethod: "npm",
        installSpec: "remote-pkg",
        runsBuildScript: false,
        description: "from network",
        tags: [],
        stars: 3,
        hasClient: false,
      },
    ],
  };
  let fetches = 0;
  const fetchImpl: CatalogFetcher = async (_url, init) => {
    fetches += 1;
    if (init?.headers?.["If-None-Match"] === '"etag-1"') {
      return {
        ok: true,
        status: 304,
        headers: { get: () => '"etag-1"' },
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "etag" ? '"etag-1"' : null) },
      json: async () => catalog,
    };
  };
  const first = await loadPluginCatalog(dir, { fetchImpl, refresh: true, url: "https://example.com/c.json" });
  assert.equal(first.source, "remote");
  assert.equal(first.entries[0].id, "remote/pkg");
  const cached = JSON.parse(readFileSync(join(dir, "hub", "plugin-catalog.json"), "utf8")) as {
    entries: { id: string }[];
  };
  assert.equal(cached.entries[0].id, "remote/pkg");
  const second = await loadPluginCatalog(dir, { fetchImpl, url: "https://example.com/c.json" });
  assert.equal(second.source, "cache");
  assert.equal(fetches, 2);
});

test("catalog URL must be https and empty means default", () => {
  assert.equal(parseCatalogUrl(""), "");
  assert.equal(parseCatalogUrl("http://example.com/c.json"), "");
  assert.equal(parseCatalogUrl("https://example.com/c.json"), "https://example.com/c.json");
  assert.equal(resolveCatalogUrl(""), DEFAULT_PLUGIN_CATALOG_URL);
  assert.equal(resolveCatalogUrl("https://example.com/c.json"), "https://example.com/c.json");
});

test("topic dump catalogs map GitHub repos into git install specs", () => {
  const parsed = parseAnyCatalog({
    "klarkxy/dsh-plugins": {
      full_name: "klarkxy/dsh-plugins",
      html_url: "https://github.com/klarkxy/dsh-plugins",
      description: "Small, independently installable plugins for DeepSeek Harness.",
      stars: 0,
      topics: ["dsh-plugin"],
      category: "other",
      archived: false,
      disabled: false,
    },
    "random/not-dsh": {
      full_name: "random/not-dsh",
      html_url: "https://github.com/random/not-dsh",
      description: "nope",
      stars: 9,
      topics: ["website"],
    },
  });
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].id, "klarkxy/dsh-plugins");
  assert.equal(parsed.entries[0].installSpec, "github:klarkxy/dsh-plugins");
  assert.equal(isInstallableEntry(parsed.entries[0]), true);
});


test("settings persist catalogUrl", () => {
  const dir = home();
  saveSettings(dir, { ...DEFAULT_HUB_SETTINGS, catalogUrl: "https://example.com/c.json" });
  assert.equal(readSettings(dir).catalogUrl, "https://example.com/c.json");
});

test("explicit catalog refresh does not fall back to seed", async () => {
  const dir = home();
  await assert.rejects(
    loadPluginCatalog(dir, {
      refresh: true,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    /offline/,
  );
  assert.equal(existsSync(join(dir, "hub", CATALOG_CACHE_FILE)), false);
});

test("readLocalPluginCatalog returns seed when cache is missing and does not write", () => {
  const dir = home();
  const snap = readLocalPluginCatalog(dir);
  assert.equal(snap.source, "seed");
  assert.equal(existsSync(join(dir, "hub", CATALOG_CACHE_FILE)), false);
});

test("a damaged catalog cache fails instead of becoming seed", () => {
  const dir = home();
  mkdirSync(join(dir, "hub"), { recursive: true });
  const path = join(dir, "hub", CATALOG_CACHE_FILE);
  writeFileSync(path, "{not-json");
  assert.throws(() => readLocalPluginCatalog(dir), /could not be read|Original bytes/i);
  assert.equal(readFileSync(path, "utf8"), "{not-json");
});

test("a malformed catalog envelope is not an empty topic cache", async () => {
  const dir = home();
  mkdirSync(join(dir, "hub"), { recursive: true });
  const path = join(dir, "hub", CATALOG_CACHE_FILE);
  const bytes = JSON.stringify({
    schemaVersion: 999,
    plugins: "not-array",
    meta: "invalid",
    portStart: "wrong",
  });
  writeFileSync(path, bytes);
  assert.throws(() => parseAnyCatalog(JSON.parse(bytes)), /unsupported plugin catalog/);
  assert.throws(() => readLocalPluginCatalog(dir), /could not be read|unsupported plugin catalog/);
  assert.equal(readFileSync(path, "utf8"), bytes);
  let fetched = false;
  await assert.rejects(
    loadPluginCatalog(dir, {
      fetchImpl: async () => {
        fetched = true;
        throw new Error("network");
      },
    }),
    /could not be read|unsupported plugin catalog/,
  );
  assert.equal(fetched, false);
  assert.equal(readFileSync(path, "utf8"), bytes);
});

test("historical topic dumps and current catalog envelopes stay readable", () => {
  const dir = home();
  mkdirSync(join(dir, "hub"), { recursive: true });
  const path = join(dir, "hub", CATALOG_CACHE_FILE);
  const dump = {
    "klarkxy/dsh-plugins": {
      full_name: "klarkxy/dsh-plugins",
      html_url: "https://github.com/klarkxy/dsh-plugins",
      description: "Small plugins.",
      stars: 1,
      topics: ["dsh-plugin"],
    },
  };
  const dumpBytes = `${JSON.stringify(dump)}\n`;
  writeFileSync(path, dumpBytes);
  const historical = readLocalPluginCatalog(dir);
  assert.equal(historical.source, "cache");
  assert.equal(historical.entries[0]?.id, "klarkxy/dsh-plugins");
  assert.equal(readFileSync(path, "utf8"), dumpBytes);

  const envelope = {
    meta: { schemaVersion: 1, generatedAt: "t", count: 0, contentHash: "h" },
    entries: [],
  };
  const envelopeBytes = `${JSON.stringify(envelope)}\n`;
  writeFileSync(path, envelopeBytes);
  const current = readLocalPluginCatalog(dir);
  assert.equal(current.source, "cache");
  assert.equal(current.meta.schemaVersion, 1);
  assert.deepEqual(current.entries, []);
  assert.equal(readFileSync(path, "utf8"), envelopeBytes);
  assert.throws(
    () => parseAnyCatalog({ meta: { schemaVersion: 1 } }),
    /unsupported plugin catalog/,
  );
  assert.throws(
    () => parseAnyCatalog({ meta: { schemaVersion: 2 }, entries: [] }),
    /unsupported plugin catalog schema/,
  );
  assert.throws(() => parseAnyCatalog({}), /unsupported plugin catalog/);
});
