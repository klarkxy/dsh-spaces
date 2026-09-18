import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LLM_REQUIRED, PLUGIN_REQUIRED } from "../scripts/pack-spaces-plugin.mjs";

const repo = join(import.meta.dirname, "..");

test("llm-bridge is a packable DSH plugin and is embedded in the plugin payload list", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "packages/llm-bridge/package.json"), "utf8")) as {
    name: string;
    files: string[];
    dsh?: { bundle?: { patch?: string } };
  };
  assert.equal(pkg.name, "@dsh-spaces/llm-bridge");
  assert.ok(pkg.files.includes("cordis.patch.yml"));
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.ok(existsSync(join(repo, "packages/llm-bridge/cordis.patch.yml")));
  assert.match(readFileSync(join(repo, "packages/llm-bridge/cordis.patch.yml"), "utf8"), /dsh-spaces-llm-bridge/);
  assert.ok(PLUGIN_REQUIRED.includes("lib/llm-bridge/lib/index.js"));
  assert.ok(LLM_REQUIRED.includes("cordis.patch.yml"));
  assert.ok(LLM_REQUIRED.includes("lib/index.js"));
});
