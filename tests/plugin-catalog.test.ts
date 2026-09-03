import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  isCompatibleCatalog,
  isInstallableEntry,
  isSafeSpec,
  loadPluginCatalog,
  parseCatalog,
  resolveCatalogUrl,
  seedCatalog,
  type CatalogFetcher,
} from "../src/main/plugin-catalog.ts";
import { parseCatalogUrl, readSettings, writeSettings as saveSettings } from "../src/main/hub-settings.ts";
import { DEFAULT_HUB_SETTINGS, DEFAULT_PLUGIN_CATALOG_URL } from "../src/shared/types.ts";

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
  assert.equal(isSafeSpec("@liustack/modlens"), true);
  assert.equal(isSafeSpec("github:example/git-bundle"), true);
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
  const first = await loadPluginCatalog(dir, { fetchImpl, refresh: true });
  assert.equal(first.source, "remote");
  assert.equal(first.entries[0].id, "remote/pkg");
  const cached = JSON.parse(readFileSync(join(dir, "hub", "plugin-catalog.json"), "utf8")) as {
    entries: { id: string }[];
  };
  assert.equal(cached.entries[0].id, "remote/pkg");
  const second = await loadPluginCatalog(dir, { fetchImpl });
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

test("settings persist catalogUrl", () => {
  const dir = home();
  saveSettings(dir, { ...DEFAULT_HUB_SETTINGS, catalogUrl: "https://example.com/c.json" });
  assert.equal(readSettings(dir).catalogUrl, "https://example.com/c.json");
});
