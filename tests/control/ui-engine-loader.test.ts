/**
 * The supervisor's playwright-core loader: it resolves the engine at the one
 * fixed payload position relative to the supervisor bundle — never through
 * node_modules, never with a fallback. A staged component payload under
 * <toolsRoot>/components/<digest>/lib/ has no node_modules ancestors that
 * carry playwright-core, so the tarball install would always fail there with
 * the old bare-specifier import; this test pins the bundled resolution.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { uiEngineLoader, UI_ENGINE_ENTRY_REL } from "../../src/adapters/node/supervisor/ui-playwright.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A staged package layout: <root>/lib/supervisor/index.js + ui-engine/. */
function writeStagedSupervisor(root: string): string {
  const bundle = join(root, "lib", "supervisor", "index.js");
  mkdirSync(dirname(bundle), { recursive: true });
  writeFileSync(bundle, "export {};\n");
  const engine = join(
    root, "lib", "supervisor", "ui-engine", "node_modules", "playwright-core",
  );
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "package.json"), `${JSON.stringify({ name: "playwright-core", version: "1.62.1" })}\n`);
  writeFileSync(join(engine, "index.mjs"), "export const chromium = { launch: async () => 'engine' };\n");
  writeFileSync(join(engine, "index.js"), "module.exports = {};\n");
  return bundle;
}

test("the loader resolves ./ui-engine relative to the supervisor bundle, nowhere else", async () => {
  const staged = tempDir("dsh-engine-staged-");
  const bundle = writeStagedSupervisor(staged);
  // A decoy bare package must NOT be consulted: the loader imports exactly
  // the bundled path and nothing else.
  const decoy = join(staged, "node_modules", "playwright-core");
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, "package.json"), `${JSON.stringify({ name: "playwright-core", version: "9.9.9", type: "module" })}\n`);
  writeFileSync(join(decoy, "index.mjs"), "throw new Error('decoy imported');\n");

  const loader = uiEngineLoader(pathToFileURL(bundle).href);
  const launcher = await loader();
  assert.equal(typeof launcher.launch, "function", "the bundled index.mjs export is returned");

  // The anchored URL is the file inside the staged ui-engine tree.
  const source = readFileSync(
    join(staged, "lib", "supervisor", "ui-engine", "node_modules", "playwright-core", "index.mjs"),
    "utf8",
  );
  assert.match(source, /engine/, "the staged engine entry was the imported module");
});

test("a missing engine reports the fixed path, not a lookup or retry", async () => {
  const staged = tempDir("dsh-engine-missing-");
  const bundle = join(staged, "lib", "supervisor", "index.js");
  mkdirSync(dirname(bundle), { recursive: true });
  writeFileSync(bundle, "export {};\n");

  const loader = uiEngineLoader(pathToFileURL(bundle).href);
  const failure = await loader().then(
    () => assert.fail("missing engine must reject"),
    (error: unknown) => String(error instanceof Error ? error.message : error),
  );
  assert.match(failure, /ui-engine\/node_modules\/playwright-core\/index\.mjs/);
  assert.match(failure, /missing|unavailable/i);
});

test("the default export anchors at this bundle via import.meta.url", () => {
  assert.equal(UI_ENGINE_ENTRY_REL, "./ui-engine/node_modules/playwright-core/index.mjs");
});
