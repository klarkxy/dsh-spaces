import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { build } from "esbuild";
import { runRuntimeInstallation } from "../src/adapters/node/runtime-installation.ts";
import { runSnapshotWorker, SnapshotExecutor } from "../src/adapters/node/snapshot-executor.ts";
import { ProcessTerminationError } from "../src/adapters/node/terminate-process.ts";
import type { RunProcessFn } from "../src/adapters/node/runtime-store.ts";
import { npmRegistry } from "../src/adapters/node/package-source.ts";

const temps: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let workerFile = "";

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

after(() => {
  if (workerFile) rmSync(dirname(workerFile), { recursive: true, force: true });
});

before(async () => {
  workerFile = await compileWorker();
});

test("runRuntimeInstallation installs an exact version and does not select it", async () => {
  const home = tempDir("dsh-rt-home-");
  const runtimeRoot = tempDir("dsh-rt-store-");
  const commands: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const installed = await runRuntimeInstallation({
    home,
    runtimeRoot,
    version: "0.1.1-rc.2",
    packageSource: "china",
    run: mockRun({ commands }),
  });
  assert.equal(installed.version, "0.1.1-rc.2");
  assert.ok(existsSync(installed.bin));
  assert.equal(resolve(installed.dir), resolve(join(runtimeRoot, "versions", "0.1.1-rc.2")));
  const npm = commands.find((item) => item.args.includes("install"));
  assert.ok(npm);
  assert.ok(npm.args.includes("@deepseek-ai/dsh@0.1.1-rc.2"));
  assert.ok(!npm.args.includes("@deepseek-ai/dsh@latest"));
  assert.equal(npm.env?.npm_config_registry, npmRegistry("china"));
  assert.equal(existsSync(join(runtimeRoot, "current.json")), false);
});

test("invalid versions never reach npm and keep an empty store", async () => {
  const home = tempDir("dsh-rt-home-");
  const runtimeRoot = tempDir("dsh-rt-store-");
  const installs: string[] = [];
  await assert.rejects(
    () => runRuntimeInstallation({
      home,
      runtimeRoot,
      version: "latest",
      packageSource: "official",
      run: mockRun({ installs }),
    }),
    /invalid runtime version/,
  );
  await assert.rejects(
    () => runRuntimeInstallation({
      home,
      runtimeRoot,
      version: "0.1.0; rm",
      packageSource: "official",
      run: mockRun({ installs }),
    }),
    /invalid runtime version/,
  );
  assert.deepEqual(installs, []);
  assert.deepEqual(leftoverStaging(runtimeRoot), []);
});

test("npm failure keeps the original error and does not publish the version", async () => {
  const home = tempDir("dsh-rt-home-");
  const runtimeRoot = tempDir("dsh-rt-store-");
  await assert.rejects(
    () => runRuntimeInstallation({
      home,
      runtimeRoot,
      version: "0.2.0",
      packageSource: "official",
      run: mockRun({ failInstall: true }),
    }),
    /npm failed/,
  );
  assert.equal(existsSync(join(runtimeRoot, "versions", "0.2.0")), false);
  assert.deepEqual(leftoverStaging(runtimeRoot), []);
});

test("ProcessTerminationError keeps unpublished staging as failure evidence", async () => {
  const home = tempDir("dsh-rt-home-");
  const runtimeRoot = tempDir("dsh-rt-store-");
  await assert.rejects(
    () => runRuntimeInstallation({
      home,
      runtimeRoot,
      version: "0.2.0",
      packageSource: "official",
      run: async () => {
        throw new ProcessTerminationError("killed during npm");
      },
    }),
    (err: unknown) => err instanceof ProcessTerminationError && /killed during npm/.test(err.message),
  );
  assert.equal(existsSync(join(runtimeRoot, "versions", "0.2.0")), false);
  assert.ok(leftoverStaging(runtimeRoot).length > 0);
});

test("actual worker runtimeInstall reuses an already published version", async () => {
  const worker = requireWorker();
  const home = tempDir("dsh-rt-home-");
  const runtimeRoot = tempDir("dsh-rt-store-");
  const prefix = join(runtimeRoot, "versions", "0.1.1-rc.2");
  writeFakeCli(prefix, "0.1.1-rc.2");
  const installed = await runSnapshotWorker<{ version: string; bin: string; dir: string }>(worker, {
    home,
    operation: "runtimeInstall",
    runtimeRoot,
    version: "0.1.1-rc.2",
    packageSource: "official",
  });
  assert.equal(installed.version, "0.1.1-rc.2");
  assert.equal(installed.bin, join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  assert.equal(existsSync(join(runtimeRoot, "current.json")), false);
});

test("actual worker runtimeInstall reports invalid version without publishing", async () => {
  const worker = requireWorker();
  const home = tempDir("dsh-rt-home-");
  const runtimeRoot = tempDir("dsh-rt-store-");
  await assert.rejects(
    () => runSnapshotWorker(worker, {
      home,
      operation: "runtimeInstall",
      runtimeRoot,
      version: "latest",
      packageSource: "official",
    }),
    /invalid runtime version/,
  );
  assert.equal(existsSync(join(runtimeRoot, "versions")), false);
});

test("worker restore/recover/completeRestore are unsupported and leave pending evidence", async () => {
  const worker = requireWorker();
  const home = tempDir("dsh-rt-home-");
  const root = tempDir("dsh-rt-snaps-");
  const pendingPath = join(root, "pending-restore.json");
  const pending = Buffer.from(`${JSON.stringify({
    snapshotId: "59ca7cee-0c06-4610-bc95-e86849247cef",
    beforeRestoreId: "ae95e8a4-691a-4aeb-852b-876076372daa",
    runtimeVersion: "1.0.0",
    binRelative: "bin.js",
    startedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`);
  writeFileSync(pendingPath, pending);
  for (const operation of ["restore", "recover", "completeRestore"] as const) {
    await assert.rejects(
      () => runSnapshotWorker(worker, { home, root, operation, id: "59ca7cee-0c06-4610-bc95-e86849247cef" }),
      /not supported/,
    );
  }
  assert.deepEqual(readFileSync(pendingPath), pending);
});

test("SnapshotExecutor restore methods reject without clearing read-only pending evidence", async () => {
  const worker = requireWorker();
  const home = tempDir("dsh-rt-home-");
  const root = tempDir("dsh-rt-snaps-");
  const pendingPath = join(root, "pending-restore.json");
  const pending = Buffer.from(`${JSON.stringify({
    snapshotId: "59ca7cee-0c06-4610-bc95-e86849247cef",
    beforeRestoreId: "ae95e8a4-691a-4aeb-852b-876076372daa",
    runtimeVersion: "1.0.0",
    binRelative: "bin.js",
    startedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`);
  writeFileSync(pendingPath, pending);
  const executor = new SnapshotExecutor({ home, root, workerFile: worker });
  assert.equal(executor.pendingRestore()?.snapshotId, "59ca7cee-0c06-4610-bc95-e86849247cef");
  await assert.rejects(() => executor.restore("59ca7cee-0c06-4610-bc95-e86849247cef"), /not supported/);
  await assert.rejects(() => executor.recover(), /not supported/);
  await assert.rejects(() => executor.completeRestore(), /not supported/);
  assert.deepEqual(readFileSync(pendingPath), pending);
  assert.equal(executor.pendingRestore()?.snapshotId, "59ca7cee-0c06-4610-bc95-e86849247cef");
});

function mockRun(options: {
  failInstall?: boolean;
  installs?: string[];
  commands?: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>;
} = {}): RunProcessFn {
  return async (_command, args, runOptions) => {
    options.commands?.push({ args, env: runOptions?.env });
    if (args.includes("install")) {
      const spec = args.find((item) => item.startsWith("@deepseek-ai/dsh@"));
      assert.ok(spec);
      const version = spec.slice("@deepseek-ai/dsh@".length);
      options.installs?.push(version);
      const prefix = args[args.indexOf("--prefix") + 1];
      if (options.failInstall) return { code: 1, stdout: "", stderr: "npm failed" };
      writeFakeCli(prefix, version);
      return { code: 0, stdout: "added 1 package", stderr: "" };
    }
    if (args.includes("--version")) {
      const bin = args.find((item) => item.endsWith("bin.js")) ?? args[0];
      const pkg = join(bin, "..", "..", "package.json");
      const version = (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
      return { code: 0, stdout: `dsh ${version}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
}

function writeFakeCli(prefix: string, version: string): string {
  const pkg = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "console.log('dsh')\n", "utf8");
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh", version }, null, 2)}\n`,
    "utf8",
  );
  return bin;
}

function leftoverStaging(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith(".tmp-dsh-"));
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function requireWorker(): string {
  assert.ok(workerFile, "snapshot worker was not compiled");
  return workerFile;
}

async function compileWorker(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-rt-worker-"));
  const outfile = join(dir, "snapshot-worker.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [join(repoRoot, "src", "adapters/node", "snapshot-worker.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
    banner: {
      js: 'import { createRequire as __spacesCreateRequire } from "node:module"; const require = __spacesCreateRequire(import.meta.url);',
    },
  });
  return outfile;
}
