import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DSH_CLI_SPEC, dshBinCandidates, findDshBin, resetDshBinCache, setManagedCliPrefix } from "../src/main/dsh-cli.ts";
import { DSH_DEFAULT_CHANNEL } from "../src/shared/runtime.ts";

const temps: string[] = [];

function fakeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-cli-"));
  temps.push(dir);
  return dir;
}

function writeFakeBin(prefix: string): string {
  const bin = join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  mkdirSync(join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  writeFileSync(bin, "console.log('dsh')\n", "utf8");
  return bin;
}

afterEach(() => {
  resetDshBinCache();
  delete process.env.DSH_SPACES_CLI;
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed CLI install follows the official latest dist-tag", () => {
  assert.equal(DSH_DEFAULT_CHANNEL, "latest");
  assert.equal(DSH_CLI_SPEC, `@deepseek-ai/dsh@${DSH_DEFAULT_CHANNEL}`);
});

test("candidates prefer the managed prefix over a global npm root", () => {
  const managed = join("/tmp", "managed-cli");
  const paths = dshBinCandidates({
    managedPrefix: managed,
    appData: join("/tmp", "appdata"),
    npmGlobalRoot: join("/tmp", "npm-global"),
  });
  assert.equal(paths[0], join(managed, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  assert.ok(paths.some((path) => path.includes(join("appdata", "npm", "node_modules"))));
  assert.ok(paths.some((path) => path.includes(join("npm-global", "@deepseek-ai", "dsh"))));
});

test("findDshBin returns the managed CLI when present", () => {
  const prefix = fakeDir();
  const bin = writeFakeBin(prefix);
  setManagedCliPrefix(prefix);
  resetDshBinCache();
  assert.equal(findDshBin(), bin);
});
