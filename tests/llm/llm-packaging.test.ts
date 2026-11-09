import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { load as loadYaml } from "js-yaml";
import { LLM_REQUIRED, PLUGIN_REQUIRED, resolveNpmCli, runNpmPack } from "../../scripts/pack-spaces-plugin.mjs";
import { validateComponentPayload } from "../../src/adapters/node/payload/component-payload.ts";
import { stageComponentPayload } from "../../src/adapters/node/payload/component-selection.ts";
import { extractArchiveAsync } from "../../src/adapters/node/runtime/toolchain.ts";

const repo = join(import.meta.dirname, "..", "..");
const patchPath = join(repo, "packages/llm-bridge/cordis.patch.yml");
const BRIDGE_ID = "dsh-spaces-llm-bridge";
const BRIDGE_NAME = "@dsh-spaces/llm-bridge";
const LEGACY_BUNDLE_OBJECT_YAML = "bundle:\n  - id: dsh-spaces-llm-bridge\n    name: '@dsh-spaces/llm-bridge'\n";
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

type PatchRow = { id?: unknown; name?: unknown; insert?: unknown; config?: unknown; inject?: unknown; disabled?:unknown };
type OfficialAppBoot = {
  loadOverlayPatches: (binName: string, file: string) => PatchRow[];
  composeEntries: (layers: unknown[][], warn?: (message: string) => void) => PatchRow[];
};

function isLegacyBundleObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "bundle" in value);
}

function asPatchList(value: unknown): PatchRow[] {
  assert.equal(isLegacyBundleObject(value), false, "cordis.patch.yml must not use the legacy bundle object shape");
  assert.ok(Array.isArray(value), "cordis.patch.yml must be a top-level YAML array of loader patch entries");
  return value as PatchRow[];
}

function insertedBridge(patches: PatchRow[]): PatchRow {
  const inserted = patches.flatMap((row) => (Array.isArray(row.insert) ? row.insert : [])) as PatchRow[];
  const bridge = inserted.find((row) => row.id === BRIDGE_ID);
  assert.equal(bridge?.name, BRIDGE_NAME);
  return bridge as PatchRow;
}

function officialAlphaAppBoot(): string {
  return createRequire(join(repo, "package.json")).resolve("@deepseek-ai/dsh-app-boot");
}

async function loadOfficialAppBoot(): Promise<OfficialAppBoot> {
  const imported = await import(pathToFileURL(officialAlphaAppBoot()).href) as Partial<OfficialAppBoot>;
  assert.equal(typeof imported.loadOverlayPatches, "function");
  assert.equal(typeof imported.composeEntries, "function");
  return imported as OfficialAppBoot;
}

function parseResultJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.lastIndexOf("\n{") >= 0 ? trimmed.lastIndexOf("\n{") + 1 : trimmed.indexOf("{");
    return JSON.parse(trimmed.slice(start)) as Record<string, unknown>;
  }
}


test("llm-bridge is a packable DSH plugin and is embedded in the plugin payload list", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "packages/llm-bridge/package.json"), "utf8")) as {
    name: string;
    files: string[];
    dsh?: { bundle?: { patch?: string } };
  };
  assert.equal(pkg.name, BRIDGE_NAME);
  assert.ok(pkg.files.includes("cordis.patch.yml"));
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.ok(existsSync(patchPath));
  const parsed = loadYaml(readFileSync(patchPath, "utf8"));
  const legacy = loadYaml(LEGACY_BUNDLE_OBJECT_YAML);
  assert.equal(isLegacyBundleObject(legacy), true);
  assert.equal(Array.isArray(legacy), false);
  const patches = asPatchList(parsed);
  insertedBridge(patches);
  assert.ok(PLUGIN_REQUIRED.includes("lib/llm-bridge/lib/index.js"));
  assert.ok(LLM_REQUIRED.includes("cordis.patch.yml"));
  assert.ok(LLM_REQUIRED.includes("lib/index.js"));
});

test("packed auxiliary export survives startup staging and imports from the staged package", { timeout: 120_000 }, async () => {
  // Exercise the distribution unit, not the standalone bridge or an un-staged source directory.
  const built = validateComponentPayload(join(repo, "packages/plugin/lib"));
  const temp = mkdtempSync(join(tmpdir(), "dsh-auxiliary-package-"));
  temps.push(temp);
  const home = join(temp, "home"), tools = join(temp, "tools"), unpacked = join(temp, "unpacked");
  for (const dir of [home, tools, unpacked]) mkdirSync(dir);
  const packed = runNpmPack(process.execPath, resolveNpmCli(process.execPath), join(repo, "packages/plugin"), temp, {
    dryRun: false, env: { ...process.env, npm_config_cache: join(temp, "npm-cache") },
  });
  await extractArchiveAsync(packed.path, unpacked);
  const staged = stageComponentPayload(home, tools, join(unpacked, "package/lib"));
  const rel = "lib/llm-bridge/lib/auxiliary.js";
  assert.equal(staged.digest, built.digest);
  assert.ok(staged.files.some(file => file.path === rel), "staged manifest must cover the auxiliary export");
  assert.deepEqual(readFileSync(join(staged.packageRoot, rel)), readFileSync(join(built.packageRoot, rel)));

  // Supply the real host SDK outside the immutable payload, as the DSH host does.
  symlinkSync(join(repo, "node_modules"), join(temp, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const probe = join(temp, "probe.mjs");
  writeFileSync(probe, `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const require = createRequire(process.argv[2]);
    const entry = require.resolve('@dsh-spaces/llm-bridge/auxiliary');
    assert.equal(entry, process.argv[3]);
    const auxiliary = await import(pathToFileURL(entry).href);
    assert.equal(auxiliary.default.name, 'spaces-auxiliary-services');
    assert.equal(typeof auxiliary.default.apply, 'function');
    console.log('staged auxiliary imported');
  `);
  const child = spawnSync(process.execPath, [probe, join(staged.packageRoot, "lib/llm-bridge/package.json"), join(staged.packageRoot, rel)], {
    cwd: temp, encoding: "utf8", timeout: 30_000, windowsHide: true,
    env: { ...process.env, DSH_HOME: home, DSH_SPACES_HOME: home, DSH_SPACES_WEB_HOME: home },
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stdout, /staged auxiliary imported/);
});

test(
  "bridge rows activate without a spacesLlmSnapshot provider (marker-proof)",
  async () => {
    // The real Cordis loader only mounts an entry after every inject target
    // exists. Mounting composed rows against marker implementations proves the
    // patch no longer blocks on a provider that does not exist.
    const appBoot = await loadOfficialAppBoot();
    const patches = asPatchList(appBoot.loadOverlayPatches("dsh", patchPath));
    const composed = appBoot.composeEntries(
      [[
        {
          insert: [
            { id: "seed", name: "seed-mod" },
            { id: "llm", name: "@deepseek-ai/dsh-llm" },
            { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" },
            { id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model" },
            { id: "session-title-llm", name: "@deepseek-ai/dsh-session-title-first-prompt-llm" },
            { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
            { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
          ],
        },
      ], patches],
    );
    const required = new Set<string>();
    for (const row of composed) {
      for (const name of Object.keys(row.inject ?? {})) required.add(name);
    }
    // Nothing may require the removed snapshot provider.
    assert.equal(required.has("spacesLlmSnapshot"), false);

    const { Context } = await import("@deepseek-ai/cordis");
    const ctx = new Context();
    for (const name of required) ctx.provide(name, {});
    ctx.provide("loader", { import: async () => ({}) });
    ctx.provide("spacesAuxiliarySources", { llm: {} });
    ctx.provide("spacesTitleSource", { realm: Symbol("title") });
    ctx.provide("spacesCommandsSource", { realm: Symbol("commands") });
    ctx.provide("configEditor", { configuration: () => [] });
    // Marker stand-ins for the composed plugins: activation succeeds when the
    // inject graph is satisfiable without spacesLlmSnapshot.
    const applied: string[] = [];
    for (const row of composed) {
      if (row.disabled) continue;
      const plugin = {
        name: String(row.id),
        inject: Object.keys(row.inject ?? {}),
        apply: () => { applied.push(String(row.id)); },
      };
      ctx.plugin(plugin);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(applied.includes("seed"));
    assert.ok(applied.includes("llm-pi-ai"));
    assert.ok(applied.includes("agent-default-model"));
    assert.ok(applied.includes(BRIDGE_ID));
    await ctx.fiber.dispose();
  },
);

test(
  "llm-bridge bundle patch is a loader insert list that official compose mounts",
  async () => {
    const appBoot = await loadOfficialAppBoot();
    const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-llm-pack-"));
    temps.push(dir);
    const legacyFile = join(dir, "legacy-bundle-object.yml");
    writeFileSync(legacyFile, LEGACY_BUNDLE_OBJECT_YAML);
    assert.throws(
      () => appBoot.loadOverlayPatches("dsh", legacyFile),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /must be a top-level YAML array of loader patch entries/);
        return true;
      },
    );
    const patches = asPatchList(appBoot.loadOverlayPatches("dsh", patchPath));
    insertedBridge(patches);
    const warnings: string[] = [];
    const composed = appBoot.composeEntries(
      [[
        {
          insert: [
            { id: "seed", name: "seed-mod" },
            { id: "llm", name: "@deepseek-ai/dsh-llm" },
            { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" },
            { id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model" },
            { id: "session-title-llm", name: "@deepseek-ai/dsh-session-title-first-prompt-llm" },
            { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
            { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
          ],
        },
      ], patches],
      (message) => warnings.push(message),
    );
    assert.deepEqual(warnings, []);
    assert.equal(composed.some((row) => row.id === "seed" && row.name === "seed-mod"), true);
    assert.equal(composed.find(row=>row.id==='llm')?.disabled,true);
    const mounted = composed.find((row) => row.id === BRIDGE_ID);
    assert.equal(mounted?.name, BRIDGE_NAME);
    assert.deepEqual(mounted?.config, {});
    // The retired snapshot provider is gone; nothing may gate activation on it.
    for (const row of composed) {
      const inject = (row.inject ?? {}) as Record<string, unknown>;
      assert.equal("spacesLlmSnapshot" in inject, false, `${String(row.id)} must not inject the removed spacesLlmSnapshot`);
    }
  },
);
