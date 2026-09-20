import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMPATIBLE_DSH_CLI_VERSION,
  COMPATIBLE_DSH_CLI_VERSIONS,
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

test("formal compatible CLI array is still only 0.1.5-rc.1", () => {
  assert.equal(COMPATIBLE_DSH_CLI_VERSION, "0.1.5-rc.1");
  assert.deepEqual([...COMPATIBLE_DSH_CLI_VERSIONS], ["0.1.5-rc.1"]);
  assert.equal(isCompatibleDshCliVersion("0.1.5-rc.1"), true);
  assert.equal(isCompatibleDshCliVersion("0.1.5-rc.2"), false);
  assert.equal(isCompatibleDshCliVersion("0.1.1-rc.2"), false);
  const source = readFileSync(SOURCE, "utf8");
  assert.match(source, /export const COMPATIBLE_DSH_CLI_VERSION = "0\.1\.5-rc\.1";/);
  assert.match(source, /export const COMPATIBLE_DSH_CLI_VERSIONS = \[COMPATIBLE_DSH_CLI_VERSION\] as const;/);
  const array = source.match(/export const COMPATIBLE_DSH_CLI_VERSIONS = \[([^\]]+)\] as const;/);
  assert.ok(array);
  assert.equal(array[1].includes("0.1.5-rc.2"), false);
});

test("src gate keeps rc.2 unknown-readonly and refuses mutation", async () => {
  const home = tempDir("dsh-cli-gate-rc2-");
  writeWeb(home);
  const bin = writeCli(home, "0.1.5-rc.2");
  const spaces = new NodeSpacesControl({
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
  });
  const overview = await spaces.overview();
  assert.equal(overview.capabilities.mode, "unknown-readonly");
  assert.equal(overview.capabilities.canCreate, false);
  assert.equal(overview.capabilities.canVerify, false);
  assert.equal(overview.capabilities.dshVersion, "0.1.5-rc.2");
  await assert.rejects(() => spaces.create({ name: "notes" }), (error: unknown) => {
    assert.ok(error instanceof SpacesPublicError);
    assert.equal(error.code, "spaces/read-only");
    return true;
  });
});
