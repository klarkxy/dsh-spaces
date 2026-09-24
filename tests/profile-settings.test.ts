import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";
import { migrateLegacyProfileSettings, profileSettingsPath, readProfileSettings, writeProfileSettings } from "../src/adapters/node/profile-settings.ts";

const homes: string[] = [];
function fixture(patch = "# profile comment\n[]\n", legacy = "llm-pi-ai:\n  providers:\n    local:\n      api: openai-completions\n") {
  const home = mkdtempSync(join(tmpdir(), "spaces-alpha-settings-")); homes.push(home);
  mkdirSync(join(home, "profiles", "alpha"), { recursive: true });
  mkdirSync(join(home, "hub", "alpha"), { recursive: true });
  const path = profileSettingsPath(home, "alpha");
  const source = join(home, "hub", "alpha", "settings.yaml");
  writeFileSync(path, patch); writeFileSync(source, legacy);
  writeFileSync(join(home, "settings.yaml"), "global sentinel\n");
  return { home, path, source };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const dump = "- id: llm-pi-ai\n- id: agent-default-model\n- id: ui-settings\n";

test("normal migration commits native configuration and retains exact isolated source evidence", () => {
  const { home, source, path } = fixture(); const original = readFileSync(source, "utf8");
  migrateLegacyProfileSettings(home, "alpha", dump);
  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(`${source}.migrated`, "utf8"), original);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "global sentinel\n");
  assert.equal(readProfileSettings(home, "alpha").getIn(["llm-pi-ai", "providers", "local", "api"]), "openai-completions");
  writeProfileSettings(home, "alpha", { "agent-default-model": { provider: "local", model: "a" } });
  assert.match(readFileSync(path, "utf8"), /dsh-spaces-settings-v1-sha256:/);
  assert.match(readFileSync(path, "utf8"), /profile comment/);
  migrateLegacyProfileSettings(home, "alpha", dump);
});

test("conflicting, unknown, dynamic or malformed legacy sections fail before changing either file", () => {
  for (const legacy of ["unknown:\n  a: 1\n", "llm-pi-ai: !!js dangerous()\n", "llm-pi-ai: [\n", "llm-pi-ai:\n  providers:\n    local:\n      api: anthropic-messages\n"]) {
    const { home, source, path } = fixture("- id: llm-pi-ai\n  config:\n    providers:\n      local:\n        api: openai-completions\n", legacy);
    const before = readFileSync(path, "utf8");
    assert.throws(() => migrateLegacyProfileSettings(home, "alpha", dump));
    assert.equal(readFileSync(path, "utf8"), before); assert.equal(readFileSync(source, "utf8"), legacy);
  }
});

test("previous evidence and an interrupted committed migration are never overwritten or replayed", () => {
  const { home, source, path } = fixture();
  writeFileSync(`${source}.migrated`, "older evidence");
  assert.throws(() => migrateLegacyProfileSettings(home, "alpha", dump), /destination/);
  assert.equal(readFileSync(`${source}.migrated`, "utf8"), "older evidence");
  writeFileSync(path, "# dsh-spaces-settings-v1-sha256:abc\n[]\n");
  assert.throws(() => migrateLegacyProfileSettings(home, "alpha", dump), /Interrupted/);
  assert.equal(existsSync(source), true);
});

test("model ids nested inside plugin config are not valid migration entry targets", () => {
  const { home, source, path } = fixture("[]\n", "model-id-not-entry:\n  retained: true\n");
  const composed = "- id: llm-pi-ai\n  config:\n    models:\n      - id: model-id-not-entry\n";
  assert.throws(() => migrateLegacyProfileSettings(home, "alpha", composed), /Unsupported/);
  assert.equal(readFileSync(path, "utf8"), "[]\n");
  assert.equal(existsSync(source), true);
});

test("profile settings edits reject duplicate ids and dynamic values without erasing unrelated data", () => {
  for (const patch of ["- id: llm-pi-ai\n  config: !!js env()\n", "- id: llm-pi-ai\n  config: {}\n- id: llm-pi-ai\n  config: {}\n"]) {
    const { home, path } = fixture(patch);
    assert.throws(() => writeProfileSettings(home, "alpha", { "llm-pi-ai": {} }));
    assert.equal(readFileSync(path, "utf8"), patch);
  }
});
