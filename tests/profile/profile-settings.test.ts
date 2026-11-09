import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";
import { profileSettingsPath, readProfileSettings, writeProfileSettings } from "../../src/adapters/node/profile/profile-settings.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test("profile settings writes are readable as a detached namespace view", () => {
  const home = mkdtempSync(join(tmpdir(), "spaces-settings-")); homes.push(home);
  mkdirSync(join(home, "profiles", "alpha"), { recursive: true });
  writeFileSync(profileSettingsPath(home, "alpha"), "# profile comment\n[]\n");
  writeProfileSettings(home, "alpha", { "agent-default-model": { provider: "local", model: "a" } });
  assert.equal(readProfileSettings(home, "alpha").getIn(["agent-default-model", "provider"]), "local");
  assert.match(readFileSync(profileSettingsPath(home, "alpha"), "utf8"), /profile comment/);
});

test("profile settings edits reject duplicate ids and dynamic values without erasing unrelated data", () => {
  for (const patch of ["- id: llm-pi-ai\n  config: !!js env()\n", "- id: llm-pi-ai\n  config: {}\n- id: llm-pi-ai\n  config: {}\n"]) {
    const home = mkdtempSync(join(tmpdir(), "spaces-settings-")); homes.push(home);
    mkdirSync(join(home, "profiles", "alpha"), { recursive: true });
    const path = profileSettingsPath(home, "alpha");
    writeFileSync(path, patch);
    assert.throws(() => writeProfileSettings(home, "alpha", { "llm-pi-ai": {} }));
    assert.equal(readFileSync(path, "utf8"), patch);
  }
});
