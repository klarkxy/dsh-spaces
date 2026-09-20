#!/usr/bin/env node
/**
 * Distribution gate for @dsh-spaces/llm-bridge.
 * Proves the package is packable and embedded in the plugin payload list.
 * Does not install into a live DSH Home and does not touch ~/.dsh.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LLM_REQUIRED, PLUGIN_REQUIRED } from "./pack-spaces-plugin.mjs";
import { resolveNpmCli } from "./verify-spaces-distribution.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LLM_DIR = join(REPO, "packages", "llm-bridge");

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

const pkg = JSON.parse(readFileSync(join(LLM_DIR, "package.json"), "utf8"));
if (pkg.name !== "@dsh-spaces/llm-bridge") fail(`unexpected package name ${pkg.name}`);
if (!pkg.files?.includes("cordis.patch.yml")) fail("llm-bridge files must include cordis.patch.yml");
if (pkg.dsh?.bundle?.patch !== "./cordis.patch.yml") fail("llm-bridge must declare a DSH bundle patch");
if (!existsSync(join(LLM_DIR, "cordis.patch.yml"))) fail("packages/llm-bridge/cordis.patch.yml is missing");
if (!PLUGIN_REQUIRED.includes("lib/llm-bridge/lib/index.js")) fail("plugin payload list is missing embedded llm-bridge");
for (const rel of LLM_REQUIRED) {
  if (rel.startsWith("lib/") && !existsSync(join(LLM_DIR, rel))) {
    console.log(`INFO  ${rel} is built by npm run build:spaces`);
    continue;
  }
  if (!existsSync(join(LLM_DIR, rel))) fail(`missing ${rel}`);
}
const dest = mkdtempSync(join(tmpdir(), "dsh-llm-dist-"));
const packed = spawnSync(process.execPath, [resolveNpmCli(process.execPath), "pack", "--ignore-scripts", "--pack-destination", dest], {
  cwd: LLM_DIR,
  encoding: "utf8",
  windowsHide: true,
});
if (packed.status !== 0) fail(`npm pack llm-bridge failed: ${packed.error?.message || packed.stderr || packed.stdout}`);
else {
  const name = packed.stdout.trim().split("\n").at(-1) ?? "";
  if (!/dsh-spaces-llm-bridge-.*\.tgz/.test(name)) fail(`unexpected pack name ${name}`);
  const listed = spawnSync("tar", ["-tzf", join(dest, name)], { encoding: "utf8" });
  if (listed.status !== 0) fail(`could not list ${name}`);
  for (const rel of ["package.json", "README.md", "LICENSE", "cordis.patch.yml"]) {
    if (!listed.stdout.includes(`package/${rel}`)) fail(`packed tarball missing ${rel}`);
  }
  if (/credentials\.yaml|catalog\.json|\bsk-/.test(listed.stdout)) fail("packed tarball listed a secret-bearing path");
  rmSync(dest, { recursive: true, force: true });
}

if (process.exitCode) process.exit(process.exitCode);
console.log("PASS  llm-bridge distribution contract");
