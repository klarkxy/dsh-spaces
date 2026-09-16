import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMPATIBLE_DSH_CLI_VERSION,
  isCompatibleDshCliVersion,
  NodeSpacesControl,
  SpacesPublicError,
} from "../src/adapters/node/spaces-control.ts";

const temps: string[] = [];
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../src/adapters/node/spaces-control.ts");

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeCli(root: string, version: string): string {
  const pkg = join(root, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version })}\n`);
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "export {};\n");
  return bin;
}

function writeWeb(home: string): void {
  const dir = join(home, "profiles", "web");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({
      name: "dsh-profile-web",
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
    })}\n`,
  );
  writeFileSync(join(dir, "cordis.patch.yml"), "[]\n");
}

test("exact CLI versions can bind; tags and junk stay out", () => {
  assert.equal(COMPATIBLE_DSH_CLI_VERSION, "0.1.5-rc.1");
  assert.equal(isCompatibleDshCliVersion("0.1.5-rc.1"), true);
  assert.equal(isCompatibleDshCliVersion("0.1.5-rc.2"), true);
  assert.equal(isCompatibleDshCliVersion("0.1.5-rc.3"), true);
  assert.equal(isCompatibleDshCliVersion("0.1.1-rc.2"), true);
  assert.equal(isCompatibleDshCliVersion("latest"), false);
  assert.equal(isCompatibleDshCliVersion("next"), false);
  assert.equal(isCompatibleDshCliVersion("1.0.0; rm -rf /"), false);
  const source = readFileSync(SOURCE, "utf8");
  assert.match(source, /return isExactRuntimeVersion\(version\);/);
  assert.doesNotMatch(source, /COMPATIBLE_DSH_CLI_VERSIONS/);
});

function control(home: string, bin: string, extra: Partial<ConstructorParameters<typeof NodeSpacesControl>[0]> = {}) {
  return new NodeSpacesControl({
    home,
    env: { ...process.env, DSH_HOME: home },
    argv: [process.execPath, bin, "--profile", "web"],
    baseUrl: `${pathToFileURL(join(home, "profiles", "web")).href}/`,
    loader: {
      entries() {
        return [
          { options: { id: "session-persistence-jsonl", config: { root: "!!js dshHomePath('sessions')" } } },
          { options: { id: "storage-json", config: { root: "!!js dshHomePath('storages')" } } },
        ];
      },
    },
    ...extra,
  });
}

test("src gate admits exact CLI writes; tags stay unbound and read-only", async () => {
  const rc2Home = tempDir("dsh-cli-gate-rc2-");
  writeWeb(rc2Home);
  const rc2 = writeCli(rc2Home, "0.1.5-rc.2");
  const admitted = control(rc2Home, rc2, {
    runCli: async (args) => {
      const name = args[args.indexOf("--profile") + 1];
      if (args.includes("--from-default-profile")) {
        const dir = join(rc2Home, "profiles", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          `${JSON.stringify({
            name: `dsh-profile-${name}`,
            dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
          })}\n`,
        );
        writeFileSync(
          join(dir, "cordis.patch.yml"),
          `- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/${name}/sessions')\n- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/${name}/storages')\n`,
        );
      }
      return {
        code: 0,
        stdout: `- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/${name}/sessions')\n- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/${name}/storages')\n`,
        stderr: "",
      };
    },
  });
  const overview = await admitted.overview();
  assert.equal(overview.capabilities.mode, "verified-full");
  assert.equal(overview.capabilities.canCreate, true);
  assert.equal(overview.capabilities.canVerify, true);
  assert.equal(overview.capabilities.dshVersion, "0.1.5-rc.2");
  const created = await admitted.create({ name: "notes" });
  assert.equal(created.id, "notes");

  const laterHome = tempDir("dsh-cli-gate-later-");
  writeWeb(laterHome);
  const later = control(laterHome, writeCli(laterHome, "0.1.5-rc.3"), {
    runCli: async (args) => {
      const name = args[args.indexOf("--profile") + 1];
      if (args.includes("--from-default-profile")) {
        const dir = join(laterHome, "profiles", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          `${JSON.stringify({
            name: `dsh-profile-${name}`,
            dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
          })}\n`,
        );
        writeFileSync(
          join(dir, "cordis.patch.yml"),
          `- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/${name}/sessions')\n- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/${name}/storages')\n`,
        );
      }
      return {
        code: 0,
        stdout: `- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/${name}/sessions')\n- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/${name}/storages')\n`,
        stderr: "",
      };
    },
  });
  const laterOverview = await later.overview();
  assert.equal(laterOverview.capabilities.mode, "verified-full");
  assert.equal(laterOverview.capabilities.canCreate, true);
  assert.equal(laterOverview.capabilities.dshVersion, "0.1.5-rc.3");

  const tagHome = tempDir("dsh-cli-gate-tag-");
  writeWeb(tagHome);
  const tagged = control(tagHome, writeCli(tagHome, "latest"));
  const blocked = await tagged.overview();
  assert.equal(blocked.capabilities.mode, "unknown-readonly");
  assert.equal(blocked.capabilities.canCreate, false);
  assert.equal(blocked.capabilities.canVerify, false);
  assert.equal(blocked.capabilities.dshVersion, null);
  await assert.rejects(() => tagged.create({ name: "notes" }), (error: unknown) => {
    assert.ok(error instanceof SpacesPublicError);
    assert.equal(error.code, "spaces/read-only");
    return true;
  });
});

const OFFICIAL_CLI_BIN = process.env.DSH_TEST_CLI_BIN || process.env.DSH_TEST_RC2_BIN;

test("real official CLI refuses cloning shipped web onto itself and accepts dump-config seed", {
  skip: !OFFICIAL_CLI_BIN && "Set DSH_TEST_CLI_BIN to run the optional official CLI integration test",
}, () => {
  assert.ok(OFFICIAL_CLI_BIN);
  assert.equal(existsSync(OFFICIAL_CLI_BIN), true);
  const wrongHome = tempDir("dsh-cli-wrong-web-");
  const wrong = spawnSync(
    process.execPath,
    [OFFICIAL_CLI_BIN, "--profile", "web", "--from-default-profile", "web", "--dump-config"],
    { env: { ...process.env, DSH_HOME: wrongHome }, encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  assert.notEqual(wrong.status, 0);
  assert.match(
    `${wrong.stderr}\n${wrong.stdout}`,
    /shipped and cannot be a custom profile target|omit --from-default-profile/i,
  );

  const okHome = tempDir("dsh-cli-web-seed-");
  const ok = spawnSync(
    process.execPath,
    [OFFICIAL_CLI_BIN, "--profile", "web", "--dump-config"],
    { env: { ...process.env, DSH_HOME: okHome }, encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  assert.equal(ok.status, 0, `${ok.stderr}\n${ok.stdout}`);
  assert.equal(existsSync(join(okHome, "profiles", "web", "package.json")), true);
});
