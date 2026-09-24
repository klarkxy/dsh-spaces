import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PINNED_LLM_PI_AI_PROTOCOLS } from "../src/core/domain/llm-connections.ts";
import { PINNED_DSH_PACKAGE_VERSION } from "./helpers/llm-official.ts";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));

function pkg(name: string): { name: string; version: string } {
  return JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")) as {
    name: string;
    version: string;
  };
}

test("P0 pins the published 0.1.7-alpha.1 settings, credentials, and llm-pi-ai packages", () => {
  const names = [
    "@deepseek-ai/dsh-settings",
    "@deepseek-ai/dsh-config-editor",
    "@deepseek-ai/dsh-credentials",
    "@deepseek-ai/dsh-credentials-local",
    "@deepseek-ai/dsh-llm-pi-ai",
    "@deepseek-ai/dsh-agent-default-model",
  ];
  for (const name of names) {
    const meta = pkg(name);
    assert.equal(meta.version, PINNED_DSH_PACKAGE_VERSION, name);
  }
  const repo = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  };
  assert.equal(repo.devDependencies["@deepseek-ai/dsh-client-connection"], PINNED_DSH_PACKAGE_VERSION);
  assert.equal(repo.devDependencies["@deepseek-ai/dsh-settings"], PINNED_DSH_PACKAGE_VERSION);
});

test("0.1.7-alpha.1 SettingsForms and LocalCredentialProvider expose the native composition seams", async () => {
  const settings = await import("@deepseek-ai/dsh-settings");
  const credentialsLocal = await import("@deepseek-ai/dsh-credentials-local");
  const credentials = await import("@deepseek-ai/dsh-credentials");
  const editor = await import("@deepseek-ai/dsh-config-editor");
  assert.equal(typeof settings.SettingsForms.prototype.update, "function");
  assert.equal(typeof settings.SettingsForms.prototype.replace, "function");
  assert.equal(typeof settings.SettingsForms.prototype.mutate, "function");
  assert.equal(typeof (settings.SettingsForms.prototype as { register?: unknown }).register, "undefined");
  assert.equal(typeof (settings.SettingsForms.prototype as { section?: unknown }).section, "undefined");
  assert.equal(typeof (settings.SettingsForms.prototype as { commit?: unknown }).commit, "undefined");
  assert.equal(typeof editor.ConfigEditor.prototype.edit, "function");
  assert.equal(typeof editor.ConfigEditor.prototype.configuration, "function");
  assert.equal(typeof credentialsLocal.resolveSpec, "function");
  assert.equal(typeof credentialsLocal.LocalCredentialProvider, "function");
  assert.equal(typeof credentials.credentialRef, "function");
  assert.equal(typeof credentials.credentialKey, "function");
  const isolatedRoot = resolve(tmpdir(), "dsh-spaces-compat-isolate");
  const credentialsPath = resolve(isolatedRoot, ".credentials.yaml");
  const unusedHome = resolve(isolatedRoot, "unused-home");
  const resolvedCreds = credentialsLocal.resolveSpec({
    path: credentialsPath,
    dshHome: unusedHome,
  });
  assert.equal(resolvedCreds.filename, credentialsPath);
});

test("0.1.7-alpha.1 llm-pi-ai supportedProtocols matches the pinned shared-connection matrix", async () => {
  const { supportedProtocols, Config } = await import("@deepseek-ai/dsh-llm-pi-ai");
  assert.deepEqual([...supportedProtocols()], [...PINNED_LLM_PI_AI_PROTOCOLS]);
  assert.ok(Config);
});
