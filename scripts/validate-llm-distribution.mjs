#!/usr/bin/env node
/**
 * Distribution gate for @dsh-spaces/llm-bridge.
 * Proves the package is packable and embedded in the plugin payload list.
 * Does not install into a live DSH Home and does not touch ~/.dsh.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LLM_REQUIRED, PLUGIN_REQUIRED } from "./pack-spaces-plugin.mjs";

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
if (process.exitCode) process.exit(process.exitCode);
console.log("PASS  llm-bridge distribution contract");
