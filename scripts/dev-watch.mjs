#!/usr/bin/env node
/**
 * Dev-checkout watch: one build now, then rebuild on source changes.
 *
 * Linked profiles serve the checkout's lib output directly, so a rebuild is
 * all a dsh-client-hmr session needs. A failed build is reported once and the
 * watcher keeps waiting for the next change; the failed build is not retried.
 *
 *   node scripts/dev-watch.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_SCRIPT = join(REPO, "scripts", "build-spaces.mjs");
const DEBOUNCE_MS = 300;

const WATCH_DIRS = [
  "src",
  "packages/plugin/src",
  "packages/view-bridge/src",
  "packages/llm-bridge/src",
  "packages/browser/src",
];
const WATCH_FILES = ["plugin", "view-bridge", "llm-bridge", "browser"].map(
  (pkg) => `packages/${pkg}/cordis.patch.yml`,
);

let building = false;
let followUp = false;
let timer;

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(runBuild, DEBOUNCE_MS);
}

function runBuild() {
  if (building) {
    // Changes during a build schedule exactly one follow-up build.
    followUp = true;
    return;
  }
  building = true;
  const started = Date.now();
  const child = spawn(process.execPath, [BUILD_SCRIPT], { cwd: REPO, stdio: "inherit", windowsHide: true });
  child.on("error", (error) => {
    console.log(`build failed (${error instanceof Error ? error.message : error})`);
    building = false;
    if (followUp) {
      followUp = false;
      runBuild();
    }
  });
  child.on("exit", (code) => {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(code === 0 ? `build ok (${elapsed}s)` : `build failed (exit ${code ?? "unknown"})`);
    building = false;
    if (followUp) {
      followUp = false;
      runBuild();
    }
  });
}

const watchers = [];
for (const dir of WATCH_DIRS) {
  const abs = join(REPO, dir);
  if (!existsSync(abs)) continue;
  watchers.push(watch(abs, { recursive: true }, schedule));
}
for (const file of WATCH_FILES) {
  const abs = join(REPO, file);
  if (!existsSync(abs)) continue;
  watchers.push(watch(abs, schedule));
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

console.log(`dev:watch building once, then watching ${watchers.length} paths (Ctrl+C exits)`);
runBuild();
