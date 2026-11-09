import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { load } from "js-yaml";
import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";

// dev-index preinstall contract. Composition and mount use the official
// @deepseek-ai/dsh-app-boot boot()/Loader (the same code path `dsh` runs),
// not a re-implemented patch algorithm. Rows resolve to marker plugin files
// written under the fixture profile so no real service stack is required.

const ROOT = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DEV_INDEX_ROW_ID = "dsh-dev-index";
const DEV_INDEX_PACKAGE = "@klarkxy/dsh-dev-index";
const DEV_INDEX_VERSION = "0.2.8";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function patchFile(rel: string): string {
  return join(ROOT, rel);
}

function patchesOf(rel: string): Record<string, unknown>[] {
  const rows = loadOverlayPatches("test", patchFile(rel));
  assert.ok(rows.length > 0, `${rel} must declare at least one patch`);
  return rows as Record<string, unknown>[];
}

function devIndexRow(rel: string): Record<string, unknown> {
  const row = patchesOf(rel)
    .flatMap((patch) => (Array.isArray(patch.insert) ? (patch.insert as Record<string, unknown>[]) : []))
    .find((entry) => entry.id === DEV_INDEX_ROW_ID);
  assert.ok(row, `${rel} must insert ${DEV_INDEX_ROW_ID}`);
  return row;
}

interface AppliedEntry {
  marker: string;
  id: string;
}

async function mountFixture(
  overlayPatches: Record<string, unknown>[],
): Promise<{ entries: { id: string; name: string; disabled: boolean }[]; applied: AppliedEntry[]; dispose: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-dev-index-preinstall-"));
  roots.push(dir);
  const applied: AppliedEntry[] = [];
  const markerSource = (marker: string) =>
    `export function apply(ctx, config) { globalThis.__devIndexProbe.applied.push({ marker: ${JSON.stringify(marker)}, id: ctx.fiber?.entry?.id ?? "" }); }\n`;
  writeFileSync(join(dir, "dev-index.mjs"), markerSource("published"), "utf8");
  writeFileSync(join(dir, "bundle-a.mjs"), markerSource("bundle-a"), "utf8");
  writeFileSync(join(dir, "cordis.yml"), "[]\n", "utf8");
  (globalThis as Record<string, unknown>).__devIndexProbe = { applied };

  // Rewire dev-index rows to local fixture files: the contract under test is
  // the canonical id semantics, not the name string (real profiles resolve it).
  // Only the real package name maps to the "published" marker; a row naming a
  // different specifier (e.g. an explicit-install fixture) keeps its own marker.
  const rewireName = (name: unknown): unknown =>
    name === DEV_INDEX_PACKAGE ? "./dev-index.mjs" : name;
  const rewire = (row: Record<string, unknown>): Record<string, unknown> => {
    if (row.id === DEV_INDEX_ROW_ID && !Array.isArray(row.insert)) {
      return { ...row, name: rewireName(row.name) };
    }
    if (Array.isArray(row.insert)) {
      return {
        ...row,
        insert: (row.insert as Record<string, unknown>[]).map((entry) =>
          entry.id === DEV_INDEX_ROW_ID ? { ...entry, name: rewireName(entry.name) } : entry),
      };
    }
    return row;
  };
  const layers = overlayPatches.map(rewire);
  const ctx = await boot("dev-index-preinstall", join(dir, "cordis.yml"), layers, async () => {});
  const entries = [...ctx.loader.entries()].map((entry) => ({
    id: entry.id,
    name: String(entry.options.name),
    disabled: entry.disabled,
  }));
  return { entries, applied, dispose: () => ctx.fiber.dispose() };
}

test("bundle patches insert the canonical dev-index row by package name and pin 0.2.8", () => {
  for (const rel of ["packages/plugin/cordis.patch.yml", "packages/view-bridge/cordis.patch.yml"]) {
    const row = devIndexRow(rel);
    assert.equal(row.name, DEV_INDEX_PACKAGE, `${rel} dev-index row must name the published package`);
  }
  for (const rel of ["package.json", "packages/plugin/package.json", "packages/view-bridge/package.json"]) {
    const pkg = JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as { dependencies?: Record<string, string> };
    assert.equal(pkg.dependencies?.[DEV_INDEX_PACKAGE], DEV_INDEX_VERSION, `${rel} must pin dev-index ${DEV_INDEX_VERSION}`);
  }
  const published = JSON.parse(readFileSync(join(ROOT, "node_modules/@klarkxy/dsh-dev-index/package.json"), "utf8")) as { version?: string };
  assert.equal(published.version, DEV_INDEX_VERSION, "installed dev-index must be the pinned version");
});

test("dev-index's own patch uses the same canonical row id", () => {
  const row = devIndexRow("node_modules/@klarkxy/dsh-dev-index/cordis.patch.yml");
  assert.equal(row.name, DEV_INDEX_PACKAGE);
});

test("bundled row and explicit install mount as exactly one dev-index registration (last wins)", async () => {
  const pluginRow = devIndexRow("packages/plugin/cordis.patch.yml");
  const explicitRow = { ...pluginRow, name: "./bundle-a.mjs", config: { source: "explicit" } };
  const fixture = await mountFixture([
    { insert: [pluginRow] },
    { insert: [explicitRow] },
  ]);
  try {
    const devIndexEntries = fixture.entries.filter((entry) => entry.id.endsWith(DEV_INDEX_ROW_ID));
    assert.equal(devIndexEntries.length, 1, "duplicate canonical ids collapse to one mounted entry");
    assert.equal(fixture.applied.length, 1, "the plugin's apply runs exactly once");
    assert.equal(fixture.applied[0]!.marker, "bundle-a", "the last composed row wins the canonical id");
  } finally {
    await fixture.dispose();
  }
});

test("explicit install applied before the bundled row still mounts once (bundled last wins)", async () => {
  const pluginRow = devIndexRow("packages/plugin/cordis.patch.yml");
  const explicitRow = { ...pluginRow, name: "./bundle-a.mjs", config: { source: "explicit" } };
  const fixture = await mountFixture([
    { insert: [explicitRow] },
    { insert: [pluginRow] },
  ]);
  try {
    assert.equal(fixture.entries.filter((entry) => entry.id.endsWith(DEV_INDEX_ROW_ID)).length, 1);
    assert.equal(fixture.applied.length, 1);
    assert.equal(fixture.applied[0]!.marker, "published", "the bundled row wins the canonical id");
  } finally {
    await fixture.dispose();
  }
});

test("browser-space profile patch disables the bundled dev-index row", async () => {
  // Only the canonical dev-index insert from the real view-bridge patch — the
  // other rows mount unrelated plugins that need services not provided here.
  const devIndexInsert = { insert: [devIndexRow("packages/view-bridge/cordis.patch.yml")] };
  const browserProfilePatch: Record<string, unknown>[] = [{ id: DEV_INDEX_ROW_ID, disabled: true }];
  const fixture = await mountFixture([devIndexInsert, ...browserProfilePatch]);
  try {
    const entry = fixture.entries.find((item) => item.id.endsWith(DEV_INDEX_ROW_ID));
    assert.ok(entry, "the row must exist so the disable patch matches an entry");
    assert.equal(entry.disabled, true, "browser profile keeps dev-index disabled");
    assert.equal(fixture.applied.length, 0, "disabled dev-index never applies");
  } finally {
    await fixture.dispose();
  }
});

test("the disable must live in the browser profile patch, not the browser bundle patch", async () => {
  // base-creation installs [browser, view-bridge]; a disable shipped inside the
  // browser bundle patch applies before the row exists and is skipped by the
  // official loader as "patch: entry not found" — no disable happens.
  const browserBundlePatch: Record<string, unknown>[] = [{ id: DEV_INDEX_ROW_ID, disabled: true }];
  const devIndexInsert = { insert: [devIndexRow("packages/view-bridge/cordis.patch.yml")] };
  const fixture = await mountFixture([...browserBundlePatch, devIndexInsert]);
  try {
    const entry = fixture.entries.find((item) => item.id.endsWith(DEV_INDEX_ROW_ID));
    assert.ok(entry && entry.disabled === false, "without a later profile patch the row stays enabled");
  } finally {
    await fixture.dispose();
  }
});
