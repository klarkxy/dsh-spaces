import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, test } from "node:test";
import { composeMainProfileDump } from "../../src/adapters/node/profile/bound-app-boot.ts";
import { prepareMainModelSync } from "../../src/adapters/node/llm/main-model-sync.ts";

/**
 * The main-profile dump the model sync reads is composed in process from the
 * bound Host's app-boot: the official CLI refuses the Electron-owned
 * "desktop" profile, and `dsh --dump-config` rewrites the profile root. The
 * CLI under comparison is the declared dev-dependency @deepseek-ai/dsh bin by
 * default; DSH_CREATOR_TEST_BIN overrides it with an isolated runtime.
 */
const TEST_BIN = process.env.DSH_CREATOR_TEST_BIN?.trim()
  || resolve("node_modules/@deepseek-ai/dsh/lib/bin.js");

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-main-dump-"));
  temps.push(home);
  return home;
}

const MODEL_PATCH = `- insert:
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: gw
        model: gw-large
        reasoningEffort: high
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          gw:
            api: openai-completions
            baseURL: http://127.0.0.1:9/v1
            apiKeyEnv: GW_KEY
            models:
              - id: gw-large
    - id: llm-deepseek
      name: '@deepseek-ai/dsh-llm-deepseek-api-key'
`;

const HOME_PATCH = `- insert:
    - id: home-note
      name: 'home-fixture'
`;

const BUNDLE_PATCH = `- insert:
    - id: bundle-note
      name: 'bundle-fixture'
`;

function writeMainProfile(home: string, profile: string, bundle = false): string {
  const dir = join(home, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: bundle ? ["dump-fixture-bundle"] : [] } } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "cordis.yml"), "[]\n");
  writeFileSync(join(dir, "cordis.patch.yml"), MODEL_PATCH);
  if (bundle) {
    const pkg = join(dir, "node_modules", "dump-fixture-bundle");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      `${JSON.stringify({ name: "dump-fixture-bundle", version: "0.0.1", dsh: { bundle: { patch: "cordis.patch.yml" } } }, null, 2)}\n`,
    );
    writeFileSync(join(pkg, "cordis.patch.yml"), BUNDLE_PATCH);
  }
  return dir;
}

function writeCredentials(home: string): void {
  writeFileSync(
    join(home, ".credentials.yaml"),
    "version: 1\nrefs:\n  GW_KEY: test-gw-value\n  DEEPSEEK_API_KEY: test-deepseek-value\n",
  );
}

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}

test("the Electron-reserved desktop profile composes and feeds the model sync", async () => {
  const home = tempHome();
  writeMainProfile(home, "desktop", true);
  writeCredentials(home);
  writeFileSync(join(home, "cordis.patch.yml"), HOME_PATCH);
  assert.ok(existsSync(TEST_BIN), `dsh CLI bin missing at ${TEST_BIN}`);

  const dump = await composeMainProfileDump({ home, profile: "desktop", bin: TEST_BIN });
  const rows = parse(dump) as Array<{ id?: string }>;
  // Bundle layer, then the profile patch, then the Home patch — the CLI order.
  assert.deepEqual(rows.map((row) => row.id), ["bundle-note", "agent-default-model", "llm-pi-ai", "llm-deepseek", "home-note"]);

  const prepared = await prepareMainModelSync({
    home,
    mainProfile: "desktop",
    spaceId: "space-a",
    dumpConfig: async (profile) => {
      assert.equal(profile, "desktop");
      return dump;
    },
  });
  assert.equal(prepared.summary.mainProfile, "desktop");
  assert.deepEqual(prepared.summary.routes, ["gw"]);
  assert.equal(prepared.summary.deepseek, true);
  assert.equal(prepared.summary.defaultModel, "gw/gw-large");
  assert.deepEqual(prepared.summary.credentials.sort(), ["DEEPSEEK_API_KEY", "GW_KEY"]);
});

test("the composed dump matches the official CLI dump for the same profile", async () => {
  const home = tempHome();
  writeMainProfile(home, "main-space");
  writeCredentials(home);
  writeFileSync(join(home, "cordis.patch.yml"), HOME_PATCH);
  assert.ok(existsSync(TEST_BIN), `dsh CLI bin missing at ${TEST_BIN}`);

  const composed = await composeMainProfileDump({ home, profile: "main-space", bin: TEST_BIN });
  const cli = spawnSync(
    process.execPath,
    [TEST_BIN, "--profile", "main-space", "--dump-config"],
    { encoding: "utf8", env: { ...process.env, DSH_HOME: home }, timeout: 120_000 },
  );
  assert.equal(cli.status, 0, `dsh --dump-config exited ${cli.status}:\n${cli.stderr}`);
  // Comment separators carry layer labels; the composed rows are the contract.
  assert.deepEqual(parse(composed), parse(cli.stdout));
});

test("the composed dump leaves the profile directory byte-identical", async () => {
  const home = tempHome();
  const dir = writeMainProfile(home, "desktop");
  writeCredentials(home);
  const before = snapshotTree(dir);
  await composeMainProfileDump({ home, profile: "desktop", bin: TEST_BIN });
  assert.deepEqual(snapshotTree(dir), before);
});

test("a missing profile fails instead of being initialized", async () => {
  const home = tempHome();
  await assert.rejects(
    composeMainProfileDump({ home, profile: "desktop", bin: TEST_BIN }),
    /not installed/,
  );
  assert.equal(existsSync(join(home, "profiles")), false);
});

test("a missing cordis.yml root fails instead of being recreated", async () => {
  const home = tempHome();
  const dir = writeMainProfile(home, "desktop");
  rmSync(join(dir, "cordis.yml"));
  await assert.rejects(
    composeMainProfileDump({ home, profile: "desktop", bin: TEST_BIN }),
    /no cordis\.yml/,
  );
  assert.equal(existsSync(join(dir, "cordis.yml")), false);
});
