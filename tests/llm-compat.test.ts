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

test("P0 pins the published 0.1.5-rc.2 settings, credentials, and llm-pi-ai packages", () => {
  const names = [
    "@deepseek-ai/dsh-settings",
    "@deepseek-ai/dsh-settings-file",
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
});

test("0.1.5-rc.2 FileSettingsProvider and LocalCredentialProvider expose custom path resolution", async () => {
  const settingsFile = await import("@deepseek-ai/dsh-settings-file");
  const credentialsLocal = await import("@deepseek-ai/dsh-credentials-local");
  const settings = await import("@deepseek-ai/dsh-settings");
  const credentials = await import("@deepseek-ai/dsh-credentials");
  assert.equal(typeof settingsFile.resolveSpec, "function");
  assert.equal(typeof settingsFile.FileSettingsProvider, "function");
  assert.equal(typeof credentialsLocal.resolveSpec, "function");
  assert.equal(typeof credentialsLocal.LocalCredentialProvider, "function");
  assert.equal(typeof settings.SettingsProvider.prototype.register, "function");
  assert.equal(typeof settings.SettingsProvider.prototype.installSection, "function");
  assert.equal(typeof settings.SettingsProvider.prototype.update, "function");
  assert.equal(typeof settings.SettingsProvider.prototype.replace, "function");
  assert.equal(typeof settings.SettingsProvider.prototype.mutate, "function");
  assert.equal(typeof credentials.credentialRef, "function");
  assert.equal(typeof credentials.credentialKey, "function");
  const isolatedRoot = resolve(tmpdir(), "dsh-spaces-compat-isolate");
  const settingsPath = resolve(isolatedRoot, "settings.yaml");
  const credentialsPath = resolve(isolatedRoot, ".credentials.yaml");
  const unusedHome = resolve(isolatedRoot, "unused-home");
  const resolvedSettings = settingsFile.resolveSpec({
    path: settingsPath,
    dshHome: unusedHome,
  });
  assert.equal(resolvedSettings.filename, settingsPath);
  const resolvedCreds = credentialsLocal.resolveSpec({
    path: credentialsPath,
    dshHome: unusedHome,
  });
  assert.equal(resolvedCreds.filename, credentialsPath);
});

test("0.1.5-rc.2 llm-pi-ai supportedProtocols matches the pinned shared-connection matrix", async () => {
  const { supportedProtocols, Config } = await import("@deepseek-ai/dsh-llm-pi-ai");
  assert.deepEqual([...supportedProtocols()], [...PINNED_LLM_PI_AI_PROTOCOLS]);
  assert.ok(Config);
});
