import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_OWNER_FILE,
  HOME_CONTROL_RUN_DIR_NAME,
} from "../src/adapters/node/home-controller.ts";
import {
  HOME_LOCK_DIR_NAME,
  HOME_LOCK_OWNER_FILE,
} from "../src/adapters/node/home-operation-lock.ts";
import { WORKBENCH_JOBS_DIR_NAME } from "../src/adapters/node/workbench-jobs.ts";
import { SnapshotStore } from "../src/adapters/node/snapshot-store.ts";
import type { SnapshotRuntime } from "../src/shared/snapshots.ts";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const cliEntry = join(root, "packages", "doctor", "src", "index.ts");
const temps: string[] = [];

after(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function runDoctor(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, ...args], {
      cwd: root,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}

function jsonOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

function writeRuntime(prefix: string, version: string): { bin: string; root: string; runtime: SnapshotRuntime } {
  const pkg = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version }, null, 2)}\n`);
  writeFileSync(
    bin,
    `if (process.argv.includes("--version")) {
  process.stdout.write(${JSON.stringify(`dsh ${version}\n`)});
  process.exit(0);
}
process.stdout.write("simulated-cli");
`,
  );
  return {
    bin,
    root: prefix,
    runtime: { version, root: prefix, binRelative: "node_modules/@deepseek-ai/dsh/lib/bin.js" },
  };
}

function writePendingRestore(root: string, snapshotId: string): void {
  writeFileSync(
    join(root, "pending-restore.json"),
    `${JSON.stringify({
      snapshotId,
      beforeRestoreId: snapshotId,
      runtimeVersion: "0.1.5-rc.1",
      binRelative: "node_modules/@deepseek-ai/dsh/lib/bin.js",
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

function seedHome(home: string, settings: string): void {
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  mkdirSync(join(home, "profiles", "coding"), { recursive: true });
  writeFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "web\n");
  writeFileSync(join(home, "profiles", "coding", "cordis.patch.yml"), "coding\n");
  writeFileSync(join(home, "settings.yaml"), settings);
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", "chat.jsonl"), "session-a\n");
}

function writeQueuedJob(home: string, id: string): void {
  const dir = join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      id,
      requestId: id,
      kind: "space.start",
      command: { kind: "space.start", spaceId: "coding" },
      commandCanonical: "space.start:coding",
      status: "queued",
      phase: "queued",
      message: "",
      affectedSpaceIds: ["coding"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canCancel: true,
    }, null, 2)}\n`,
  );
}

function writePlan(
  home: string,
  id: string,
  command: Record<string, unknown>,
  status = "running",
): void {
  const dir = join(home, HOME_CONTROL_DIR_NAME, "plans");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      id,
      public: { id, kind: command.kind, title: "plan", fingerprint: "fp", expiresAt: "2026-01-01T00:05:00.000Z", changes: [] },
      command,
      fingerprint: "fp",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
      status,
    }, null, 2)}\n`,
  );
}

function writeToolchain(
  home: string,
  fields: Record<string, unknown>,
): void {
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(
    join(home, HOME_CONTROL_DIR_NAME, "toolchain.json"),
    `${JSON.stringify({ version: 1, boundAt: "2026-01-01T00:00:00.000Z", ...fields }, null, 2)}\n`,
  );
}

function writeRunningPluginJob(home: string, id: string, planId = "plan-plugin-1"): void {
  const dir = join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      id,
      requestId: id,
      kind: "plan.execute",
      command: { kind: "plan.execute", planId },
      commandCanonical: `plan.execute:${planId}`,
      status: "running",
      phase: "mutating",
      message: "",
      affectedSpaceIds: ["coding"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canCancel: false,
    }, null, 2)}\n`,
  );
}

test("recover unlock and rollback are unsupported and leave Home bytes", async () => {
  const home = tempDir("dsh-wb-doctor-unsup-");
  seedHome(home, "preserve\n");
  const before = readFileSync(join(home, "settings.yaml"), "utf8");
  for (const command of ["unlock", "recover", "rollback"] as const) {
    const result = await runDoctor([command, "--home", home]);
    assert.equal(result.code, 7, command);
    assert.equal(jsonOf(result.stdout).code, "UNSUPPORTED");
  }
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), before);
});

test("ROOT doctor does not settle an abandoned package receipt or invent a runtime pointer", async () => {
  const home = tempDir("dsh-wb-package-doctor-");
  seedHome(home, "preserve\n");
  const planId = "11111111-1111-4111-8111-111111111111";
  writePlan(home, planId, { kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  writeRunningPluginJob(home, "package-abandoned", planId);
  const receipts = join(home, HOME_CONTROL_DIR_NAME, "workbench-upgrade-receipts");
  mkdirSync(receipts, { recursive: true });
  writeFileSync(join(receipts, `${planId}.json`), JSON.stringify({
    schemaVersion: 1, planId, outcome: "abandoned", rolledBack: false, at: new Date().toISOString(),
  }));
  const jobPath = join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "package-abandoned.json");
  const beforeJob = readFileSync(jobPath);
  const result = await runDoctor(["recover", "--home", home]);
  assert.equal(result.code, 7);
  assert.equal(jsonOf(result.stdout).code, "UNSUPPORTED");
  assert.deepEqual(readFileSync(jobPath), beforeJob);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "preserve\n");
});

test("read-only doctor does not write Home, jobs, or locks", async () => {
  const home = tempDir("dsh-wb-doctor-ro-");
  seedHome(home, "keep\n");
  writeQueuedJob(home, "job-queued-1");
  mkdirSync(join(home, HOME_LOCK_DIR_NAME));
  writeFileSync(
    join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE),
    `${JSON.stringify({ pid: process.pid, nonce: "live", startedAt: new Date().toISOString(), label: "hold" })}\n`,
  );
  const jobPath = join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "job-queued-1.json");
  const beforeJob = readFileSync(jobPath, "utf8");
  const beforeLock = readFileSync(join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE), "utf8");
  const result = await runDoctor(["doctor", "--home", home]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(readFileSync(jobPath, "utf8"), beforeJob);
  assert.equal(readFileSync(join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE), "utf8"), beforeLock);
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME)), false);
  assert.doesNotMatch(result.stdout, /token|cookie|credentials|settings\.yaml/i);
  const jobs = body.jobs as { unfinished?: number };
  assert.equal(jobs.unfinished, 1);
});

test("live lock and live instance are not killed and recover is unsupported", async () => {
  const home = tempDir("dsh-wb-doctor-live-");
  seedHome(home, "live-home\n");
  mkdirSync(join(home, HOME_LOCK_DIR_NAME));
  writeFileSync(
    join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE),
    `${JSON.stringify({ pid: process.pid, nonce: "live", startedAt: new Date().toISOString(), label: "hold" })}\n`,
  );
  const instances = join(home, HOME_CONTROL_DIR_NAME, "instances");
  mkdirSync(instances, { recursive: true });
  writeFileSync(
    join(instances, "coding.json"),
    `${JSON.stringify({
      version: 1,
      spaceId: "coding",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      port: 9,
      generation: 1,
      origin: "http://127.0.0.1:9",
    })}\n`,
  );
  const beforeLock = readFileSync(join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE));
  const inspect = await runDoctor(["doctor", "--home", home]);
  assert.equal(inspect.code, 0, inspect.stdout + inspect.stderr);
  const recover = await runDoctor(["recover", "--home", home]);
  assert.equal(recover.code, 7);
  assert.equal(jsonOf(recover.stdout).code, "UNSUPPORTED");
  assert.deepEqual(readFileSync(join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE)), beforeLock);
  assert.equal(existsSync(join(instances, "coding.json")), true);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("ambiguous control ownership is not stolen", async () => {
  const home = tempDir("dsh-wb-doctor-amb-");
  seedHome(home, "amb\n");
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME), { recursive: true });
  const owner = join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE);
  writeFileSync(owner, "not-json\n");
  const inspect = await runDoctor(["doctor", "--home", home]);
  assert.equal(inspect.code, 0, inspect.stdout + inspect.stderr);
  const result = await runDoctor(["recover", "--home", home]);
  assert.equal(result.code, 7);
  assert.equal(jsonOf(result.stdout).code, "UNSUPPORTED");
  assert.equal(readFileSync(owner, "utf8"), "not-json\n");
});

test("truncated job bytes stay in place and are not settled", async () => {
  const home = tempDir("dsh-wb-doctor-badjob-");
  seedHome(home, "jobs\n");
  const runtime = writeRuntime(tempDir("dsh-wb-rt-job-"), "0.1.5-rc.1");
  const snapshotRoot = tempDir("dsh-wb-snaps-job-");
  const runtimeRoot = tempDir("dsh-wb-runtimes-job-");
  const store = new SnapshotStore({ home, root: snapshotRoot });
  const snap = store.create(runtime.runtime);
  writeFileSync(join(home, "settings.yaml"), "dirty\n");
  writePendingRestore(snapshotRoot, snap.id);
  const jobPath = join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "broken.json");
  mkdirSync(dirname(jobPath), { recursive: true });
  writeFileSync(jobPath, "{\"schemaVersion\":1,\"status\":\"running\"");
  writeQueuedJob(home, "queued-ok");
  writeRunningPluginJob(home, "plugin-running");

  const otherSnap = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  writePlan(home, "plan-other-snap", { kind: "snapshot.restore", snapshotId: otherSnap });
  writeRunningPluginJob(home, "other-snap-job", "plan-other-snap");

  const result = await runDoctor([
    "recover",
    "--home",
    home,
    "--cli",
    runtime.bin,
    "--snapshot-root",
    snapshotRoot,
    "--runtime-root",
    runtimeRoot,
  ]);
  assert.equal(result.code, 7, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  assert.equal(body.code, "UNSUPPORTED");
  assert.equal(readFileSync(jobPath, "utf8"), "{\"schemaVersion\":1,\"status\":\"running\"");
  const queued = JSON.parse(readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "queued-ok.json"), "utf8")) as {
    status: string;
  };
  assert.equal(queued.status, "queued");
  const plugin = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "plugin-running.json"), "utf8"),
  ) as { status: string };
  assert.equal(plugin.status, "running");
  const other = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "other-snap-job.json"), "utf8"),
  ) as { status: string };
  assert.equal(other.status, "running");
  assert.ok(store.pendingRestore()?.snapshotId);
  assert.doesNotMatch(result.stdout, /Offline recovery finished/);
});

test("recover does not complete a pending SnapshotStore restore", async () => {
  const home = tempDir("dsh-wb-doctor-recov-");
  seedHome(home, "original-settings\n");
  writeFileSync(join(home, ".credentials.yaml"), "secret-key\n");
  const runtime = writeRuntime(tempDir("dsh-wb-rt-rec-"), "0.1.5-rc.1");
  const snapshotRoot = tempDir("dsh-wb-snaps-rec-");
  const runtimeRoot = tempDir("dsh-wb-runtimes-rec-");
  const store = new SnapshotStore({ home, root: snapshotRoot });
  const snap = store.create(runtime.runtime, "upgrade");
  writeFileSync(join(home, "settings.yaml"), "dirty-settings\n");
  writeFileSync(join(home, "profiles", "coding", "cordis.patch.yml"), "dirty-coding\n");
  writeToolchain(home, {
    bin: join(runtimeRoot, "old-bin.js"),
    nodeExe: join(runtimeRoot, "node.exe"),
    dshVersion: "0.0.0",
    runtimeRoot,
    snapshotRoot,
    toolchainRoot: join(runtimeRoot, "toolchain"),
  });
  writePendingRestore(snapshotRoot, snap.id);
  assert.ok(store.pendingRestore());
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "dirty-settings\n");

  const beforeSettings = readFileSync(join(home, "settings.yaml"));
  const beforeCreds = readFileSync(join(home, ".credentials.yaml"));
  const result = await runDoctor(["recover", "--home", home]);
  assert.equal(result.code, 7);
  assert.equal(jsonOf(result.stdout).code, "UNSUPPORTED");
  assert.ok(store.pendingRestore());
  assert.deepEqual(readFileSync(join(home, "settings.yaml")), beforeSettings);
  assert.deepEqual(readFileSync(join(home, ".credentials.yaml")), beforeCreds);
  assert.doesNotMatch(result.stdout, /secret-key/);
});

test("rollback does not restore a whole Home", async () => {
  const home = tempDir("dsh-wb-doctor-rb-");
  seedHome(home, "snap-a\n");
  const runtime = writeRuntime(tempDir("dsh-wb-rt-rb-"), "0.1.5-rc.1");
  const snapshotRoot = tempDir("dsh-wb-snaps-rb-");
  const runtimeRoot = tempDir("dsh-wb-runtimes-rb-");
  const store = new SnapshotStore({ home, root: snapshotRoot });
  const snap = store.create(runtime.runtime, "manual");
  writeFileSync(join(home, "settings.yaml"), "snap-b\n");
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(join(home, "hub", "spaces.json"), '{"version":1}\n');

  const missingId = await runDoctor([
    "rollback",
    "--home",
    home,
    "--cli",
    runtime.bin,
    "--snapshot-root",
    snapshotRoot,
    "--runtime-root",
    runtimeRoot,
  ]);
  assert.equal(missingId.code, 7);
  assert.equal(jsonOf(missingId.stdout).code, "UNSUPPORTED");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "snap-b\n");

  const result = await runDoctor([
    "rollback",
    "--home",
    home,
    "--cli",
    runtime.bin,
    "--snapshot-root",
    snapshotRoot,
    "--runtime-root",
    runtimeRoot,
    "--snapshot",
    snap.id,
  ]);
  assert.equal(result.code, 7);
  assert.equal(jsonOf(result.stdout).code, "UNSUPPORTED");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "snap-b\n");
  assert.equal(existsSync(join(home, "hub")), true);
});

test("unknown CLI cannot write recover or rollback", async () => {
  const home = tempDir("dsh-wb-doctor-ver-");
  seedHome(home, "v\n");
  const snapshotRoot = tempDir("dsh-wb-snaps-ver-");
  const runtimeRoot = tempDir("dsh-wb-runtimes-ver-");
  const old = writeRuntime(tempDir("dsh-wb-rt-old-"), "0.1.1-rc.2");
  const rc2 = writeRuntime(tempDir("dsh-wb-rt-rc2-"), "0.1.5-rc.2");
  const later = writeRuntime(tempDir("dsh-wb-rt-later-"), "0.1.5-rc.3");
  const good = writeRuntime(tempDir("dsh-wb-rt-good-"), "0.1.5-rc.1");
  const store = new SnapshotStore({ home, root: snapshotRoot });
  const snap = store.create(good.runtime);

  const unknown = await runDoctor([
    "rollback",
    "--home",
    home,
    "--cli",
    old.bin,
    "--snapshot-root",
    snapshotRoot,
    "--runtime-root",
    runtimeRoot,
    "--snapshot",
    snap.id,
  ]);
  assert.equal(unknown.code, 7);
  assert.equal(jsonOf(unknown.stdout).code, "UNSUPPORTED");

  const unpublished = await runDoctor([
    "rollback",
    "--home",
    home,
    "--cli",
    later.bin,
    "--snapshot-root",
    snapshotRoot,
    "--runtime-root",
    runtimeRoot,
    "--snapshot",
    snap.id,
  ]);
  assert.equal(unpublished.code, 7);
  assert.equal(jsonOf(unpublished.stdout).code, "UNSUPPORTED");

  const rc2write = await runDoctor([
    "recover",
    "--home",
    home,
    "--cli",
    rc2.bin,
    "--snapshot-root",
    snapshotRoot,
    "--runtime-root",
    runtimeRoot,
  ]);
  assert.equal(jsonOf(rc2write.stdout).code, "UNSUPPORTED");
  assert.equal(rc2write.code, 7);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "v\n");
});

test("doctor reports plugin mutation and missing roots without guessing app data", async () => {
  const home = tempDir("dsh-wb-doctor-plug-");
  seedHome(home, "p\n");
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(
    join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      phase: "failed",
      spaceIds: ["coding"],
      expected: [{ spaceId: "coding", action: "install", packageName: "demo" }],
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
  writeFileSync(
    join(home, HOME_CONTROL_DIR_NAME, "toolchain.json"),
    `${JSON.stringify({ version: 1, bin: "C:\\\\missing\\\\bin.js", nodeExe: "C:\\\\missing\\\\node.exe", dshVersion: "0.1.5-rc.1", boundAt: "2026-01-01T00:00:00.000Z" })}\n`,
  );
  const result = await runDoctor(["doctor", "--home", home]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  const plugin = (body.journals as { pluginMutation: { present: boolean; rollbackRequired?: boolean } }).pluginMutation;
  assert.equal(plugin.present, true);
  assert.equal(plugin.rollbackRequired, true);
  const findings = body.findings as string[];
  assert.ok(findings.some((row) => /plugin mutation evidence is present/i.test(row)));
  assert.equal(findings.some((row) => /rollback|restore/i.test(row)), false);
  assert.ok(findings.some((row) => /not guessed/i.test(row)));
  assert.doesNotMatch(result.stdout, /AppData|appuserdata/i);
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json")), true);
});

test("runtime readback failure does not settle jobs or claim success", async () => {
  const home = tempDir("dsh-wb-doctor-rtfail-");
  seedHome(home, "rt\n");
  const runtime = writeRuntime(tempDir("dsh-wb-rt-fail-"), "0.1.5-rc.1");
  const snapshotRoot = tempDir("dsh-wb-snaps-fail-");
  const runtimeRoot = tempDir("dsh-wb-runtimes-fail-");
  const store = new SnapshotStore({ home, root: snapshotRoot });
  const snap = store.create(runtime.runtime);
  writeFileSync(join(home, "settings.yaml"), "dirty\n");
  writePendingRestore(snapshotRoot, snap.id);
  writeQueuedJob(home, "queued-keep");
  writeFileSync(
    join(snapshotRoot, snap.id, "runtime", "node_modules", "@deepseek-ai", "dsh", "package.json"),
    "{",
  );

  const result = await runDoctor([
    "recover",
    "--home",
    home,
    "--cli",
    runtime.bin,
    "--snapshot-root",
    snapshotRoot,
    "--runtime-root",
    runtimeRoot,
  ]);
  assert.equal(result.code, 7);
  const body = jsonOf(result.stdout);
  assert.equal(body.code, "UNSUPPORTED");
  const queued = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "queued-keep.json"), "utf8"),
  ) as { status: string };
  assert.equal(queued.status, "queued");
});

test("upgrade preparing leftover does not clear plugin mutation evidence", async () => {
  const home = tempDir("dsh-wb-doctor-prep-");
  seedHome(home, "prep\n");
  const runtime = writeRuntime(tempDir("dsh-wb-rt-prep-"), "0.1.5-rc.1");
  const snapshotRoot = tempDir("dsh-wb-snaps-prep-");
  const runtimeRoot = tempDir("dsh-wb-runtimes-prep-");
  mkdirSync(join(home, ".dsh-spaces-upgrade"), { recursive: true });
  writeFileSync(
    join(home, ".dsh-spaces-upgrade", "journal.json"),
    `${JSON.stringify({
      phase: "preparing",
      snapshotId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      version: "0.1.5-rc.1",
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
  const mutation = `${JSON.stringify({
    schemaVersion: 1,
    phase: "failed",
    planId: "plan-plugin-1",
    spaceIds: ["coding"],
    expected: [{ spaceId: "coding", action: "install", packageName: "demo" }],
    startedAt: "2026-01-01T00:00:00.000Z",
  })}\n`;
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json"), mutation);
  writeRunningPluginJob(home, "plugin-running");

  const result = await runDoctor([
    "recover",
    "--home",
    home,
    "--cli",
    runtime.bin,
    "--snapshot-root",
    snapshotRoot,
    "--runtime-root",
    runtimeRoot,
  ]);
  assert.equal(result.code, 7, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  assert.equal(body.code, "UNSUPPORTED");
  assert.equal(readFileSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json"), "utf8"), mutation);
  const plugin = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "plugin-running.json"), "utf8"),
  ) as { status: string };
  assert.notEqual(plugin.status, "succeeded");
});

test("whole-home rollback is unsupported and leaves plugin mutation evidence", async () => {
  const home = tempDir("dsh-wb-doctor-mut-");
  seedHome(home, "snap-a\n");
  const runtime = writeRuntime(tempDir("dsh-wb-rt-mut-"), "0.1.5-rc.1");
  const snapshotRoot = tempDir("dsh-wb-snaps-mut-");
  const runtimeRoot = tempDir("dsh-wb-runtimes-mut-");
  const store = new SnapshotStore({ home, root: snapshotRoot });
  const snap = store.create(runtime.runtime, "manual");
  writeFileSync(join(home, "settings.yaml"), "snap-b\n");
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation-files", "coding"), { recursive: true });
  writeFileSync(
    join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation-files", "coding", "package.json"),
    '{"name":"coding"}\n',
  );
  writeFileSync(
    join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      phase: "failed",
      planId: "plan-plugin-1",
      spaceIds: ["coding"],
      expected: [{ spaceId: "coding", action: "install", packageName: "demo" }],
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
  writePlan(home, "plan-plugin-1", {
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "demo",
    packageName: "demo",
    version: "1.0.0",
  });
  writeRunningPluginJob(home, "plugin-running", "plan-plugin-1");
  writePlan(home, "plan-other-snap", {
    kind: "snapshot.restore",
    snapshotId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  });
  writeRunningPluginJob(home, "other-snap-job", "plan-other-snap");
  writeToolchain(home, {
    bin: runtime.bin,
    nodeExe: process.execPath,
    dshVersion: "0.1.5-rc.1",
    runtimeRoot,
    snapshotRoot,
  });

  const result = await runDoctor([
    "rollback",
    "--home",
    home,
    "--cli",
    runtime.bin,
    "--snapshot-root",
    snapshotRoot,
    "--runtime-root",
    runtimeRoot,
    "--snapshot",
    snap.id,
  ]);
  assert.equal(result.code, 7, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  assert.equal(body.code, "UNSUPPORTED");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "snap-b\n");
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json")), true);
  const plugin = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "plugin-running.json"), "utf8"),
  ) as { status: string };
  assert.equal(plugin.status, "running");
  const again = await runDoctor(["recover", "--home", home]);
  assert.equal(again.code, 7);
  assert.equal(jsonOf(again.stdout).code, "UNSUPPORTED");
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json")), true);
});
