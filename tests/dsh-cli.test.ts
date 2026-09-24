import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  DSH_CLI_SPEC,
  dshBinCandidates,
  findDshBin,
  resetDshBinCache,
  setManagedCliPrefix,
  setManagedNodeExecutable,
  spawnNode,
} from "../src/adapters/node/dsh-cli.ts";
import { setToolchainRoot } from "../src/adapters/node/toolchain.ts";
import { DSH_DEFAULT_VERSION } from "../src/shared/runtime.ts";

const temps: string[] = [];
const children: ChildProcess[] = [];
const originalElectron = process.env.ELECTRON_RUN_AS_NODE;

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

function restoreElectronEnv(): void {
  if (originalElectron === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = originalElectron;
}

async function waitClosed(child: ChildProcess): Promise<void> {
  children.push(child);
  child.stdout?.resume();
  child.stderr?.resume();
  await new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  resetDshBinCache();
  setManagedNodeExecutable(undefined);
  restoreElectronEnv();
  delete process.env.DSH_SPACES_CLI;
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed CLI install pins the default official release", () => {
  assert.equal(DSH_DEFAULT_VERSION, "0.1.7-alpha.1");
  assert.equal(DSH_CLI_SPEC, `@deepseek-ai/dsh@${DSH_DEFAULT_VERSION}`);
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

test("spawnNode fallback strips inherited ELECTRON_RUN_AS_NODE when toolchain has no Node", async () => {
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    setManagedNodeExecutable(undefined);
    setToolchainRoot(fakeDir());
    const stamp = join(fakeDir(), "env.json");
    const child = spawnNode(
      [
        "-e",
        "require('node:fs').writeFileSync(process.env.DSH_ENV_STAMP, JSON.stringify({ electron: process.env.ELECTRON_RUN_AS_NODE ?? null }))",
      ],
      {
        windowsHide: true,
        env: { DSH_ENV_STAMP: stamp },
      },
    );
    await waitClosed(child);
    const parsed = JSON.parse(readFileSync(stamp, "utf8")) as { electron: string | null };
    assert.equal(parsed.electron, null);
  } finally {
    restoreElectronEnv();
  }
});

test("spawnNode default stdio ignores stdin and pipes stdout/stderr", async () => {
  setManagedNodeExecutable(undefined);
  setToolchainRoot(fakeDir());
  const dir = fakeDir();
  const script = join(dir, "stamp.mjs");
  const stamp = join(dir, "out.json");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify({ ok: true, argv2: process.argv[2] }));
`,
  );
  const child = spawnNode([script, stamp], { windowsHide: true });
  assert.equal(child.stdin, null);
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  await waitClosed(child);
  const parsed = JSON.parse(readFileSync(stamp, "utf8")) as { ok: boolean; argv2: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.argv2, stamp);
});
