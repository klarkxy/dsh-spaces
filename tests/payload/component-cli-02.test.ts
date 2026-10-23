import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dshPeerRangesFromPackages, unmetDshPeers } from "../../src/adapters/node/payload/component-cli.ts";
import { satisfies } from "semver";
import { DSH_DEFAULT_VERSION, SPACES_MIN_DSH_VERSION } from "../../src/shared/runtime.ts";
import { unmetDshRequirements, unmetProfileDshRequirements } from "../../src/adapters/node/payload/component-cli.ts";

test("target requirements match the selected official evaluator, including malformed contracts", async () => {
  const officialPath = process.env.DSH_COMPAT_APP_BOOT
    ?? createRequire(import.meta.url).resolve("@deepseek-ai/dsh-app-boot");
  const official = await import(pathToFileURL(officialPath).href);
  const version = official.getDshRuntimeVersion();
  const cases = [
    {},
    { engines: { dsh: ">=0.2.0-0" }, peerDependencies: { "@deepseek-ai/dsh": "<0.1.0" } },
    { engines: { dsh: "<0.1.0" }, peerDependencies: { "@deepseek-ai/dsh": "workspace:*" } },
    { engines: { dsh: ">=0.2.0-0" }, peerDependencies: null },
    { engines: { dsh: "" } }, { engines: { dsh: "workspace:*" } },
    { engines: null }, { engines: [] }, { engines: { dsh: 42 } },
    { engines: { node: ">=26" }, peerDependencies: { "@deepseek-ai/dsh": "<0.1.0" } },
    { peerDependencies: [] }, { peerDependencies: { react: 42 } },
    { peerDependencies: { "@deepseek-ai/dsh": "invalid range" } },
    { peerDependencies: { "@deepseek-ai/dsh": "workspace:*" } },
    { peerDependencies: { "@deepseek-ai/dsh": "workspace:^" } },
    { peerDependencies: { "@deepseek-ai/dsh": "workspace:~" } },
  ];
  for (const fields of cases) {
    const manifest = { name: "contract-fixture", version: "1.0.0", ...fields };
    let issue;
    try { issue = official.evaluatePluginCompatibility(manifest, {}, version); }
    catch {
      assert.throws(() => unmetDshRequirements(manifest, version), JSON.stringify(fields));
      continue;
    }
    assert.deepEqual(unmetDshRequirements(manifest, version), issue?.requirements ?? issue?.peers ?? {}, JSON.stringify(fields));
  }
  assert.throws(() => unmetDshRequirements({}, "latest"), /runtime version/);
  assert.throws(() => unmetDshRequirements({ peerDependencies: { "@deepseek-ai/dsh": "<0.1.0" } }, version), /name/);
});

test("engine precedence starts at alpha.4 and component constraints cannot overwrite each other", (t) => {
  const manifest = {
    name: "contract-fixture", version: "1.0.0",
    engines: { dsh: ">=0.2.1-alpha.4" }, peerDependencies: { "@deepseek-ai/dsh": "<0.1.0" },
  };
  assert.deepEqual(unmetDshRequirements(manifest, "0.2.1-alpha.3"), { "@deepseek-ai/dsh": "<0.1.0" });
  assert.deepEqual(unmetDshRequirements(manifest, "0.2.1-alpha.4"), {});
  const root = mkdtempSync(join(tmpdir(), "spaces-component-requirements-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, range] of [["plugin", "<0.1.0"], ["view-bridge", ">=0.2.0-0"]]) {
    const dir = join(root, "node_modules", "@dsh-spaces", name!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...manifest, name: `@dsh-spaces/${name}`, engines: { dsh: range } }));
  }
  assert.deepEqual(unmetProfileDshRequirements(root, DSH_DEFAULT_VERSION), ["@dsh-spaces/plugin (engines.dsh@<0.1.0)"]);
  writeFileSync(join(root, "node_modules", "@dsh-spaces", "plugin", "package.json"), "{");
  assert.throws(() => unmetProfileDshRequirements(root, DSH_DEFAULT_VERSION), /could not be read/);
});

test("distributed components admit the default prerelease with npm's normal peer semantics", () => {
  for (const component of ["plugin", "blueprint", "browser", "llm-bridge", "view-bridge"]) {
    const manifest = JSON.parse(readFileSync(new URL(`../../packages/${component}/package.json`, import.meta.url), "utf8"));
    for (const [name, range] of Object.entries(manifest.peerDependencies) as [string, string][]) {
      if (!name.startsWith("@deepseek-ai/dsh-")) continue;
      assert.ok(satisfies(DSH_DEFAULT_VERSION, range), `${component}: ${name}@${range} excludes the new runtime`);
      assert.ok(satisfies(SPACES_MIN_DSH_VERSION, range), `${component}: ${name}@${range} drops the existing minimum`);
    }
    if (manifest.engines?.dsh) {
      assert.ok(satisfies(DSH_DEFAULT_VERSION, manifest.engines.dsh));
      assert.ok(satisfies(SPACES_MIN_DSH_VERSION, manifest.engines.dsh));
    }
  }
});

test("component compatibility checks bare DSH peers as well as named subsystems", (t) => {
  const root = mkdtempSync(join(tmpdir(), "spaces-peer-02-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "package.json");
  writeFileSync(path, JSON.stringify({ peerDependencies: {
    "@deepseek-ai/dsh": "^0.1.7-alpha.1", "@deepseek-ai/dsh-settings": ">=0.2.0-rc.2",
  } }));
  assert.deepEqual(unmetDshPeers("0.2.0-rc.2", dshPeerRangesFromPackages([path])), ["@deepseek-ai/dsh@^0.1.7-alpha.1"]);
});

test("component compatibility follows official workspace tokens and rejects empty/invalid ranges", () => {
  for (const range of ["workspace:^", "workspace:~", "workspace:*"]) {
    assert.deepEqual(unmetDshPeers("0.2.0-rc.2", { "@deepseek-ai/dsh": range }), []);
  }
  for (const range of ["", "workspace:1.0.0", "not-a-range"]) {
    assert.equal(unmetDshPeers("0.2.0-rc.2", { "@deepseek-ai/dsh": range }).length, 1);
  }
});
