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
import { SnapshotStore } from "../src/main/snapshot-store.ts";
import { RESTORE_STAGE_DIR, type SnapshotRuntime } from "../src/shared/snapshots.ts";

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

test("ROOT doctor settles an abandoned package receipt as failed without inventing a runtime pointer", async () => {
  const home = tempDir("dsh-wb-package-doctor-");
  seedHome(home, "preserve\n");
  const runtime = writeRuntime(tempDir("dsh-wb-package-runtime-"), "0.1.5-rc.1");
  const snapshots = tempDir("dsh-wb-package-snaps-");
  const runtimes = tempDir("dsh-wb-package-runtimes-");
  const planId = "11111111-1111-4111-8111-111111111111";
  writePlan(home, planId, { kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  writeRunningPluginJob(home, "package-abandoned", planId);
  const receipts = join(home, HOME_CONTROL_DIR_NAME, "workbench-upgrade-receipts");
  mkdirSync(receipts, { recursive: true });
  writeFileSync(join(receipts, `${planId}.json`), JSON.stringify({
    schemaVersion: 1, planId, outcome: "abandoned", rolledBack: false, at: new Date().toISOString(),
  }));
  const result = await runDoctor(["recover", "--home", home, "--cli", runtime.bin, "--snapshot-root", snapshots, "--runtime-root", runtimes]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const job = JSON.parse(readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "package-abandoned.json"), "utf8"));
  assert.equal(job.status, "failed");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "preserve\n");
  assert.equal(existsSync(join(runtimes, "current.json")), false);
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

test("live lock and live instance are not killed and recover stays in recovery mode", async () => {
  const home = tempDir("dsh-wb-doctor-live-");
  seedHome(home, "live-home\n");
  const runtime = writeRuntime(tempDir("dsh-wb-rt-"), "0.1.5-rc.1");
  const snapshotRoot = tempDir("dsh-wb-snaps-");
  const runtimeRoot = tempDir("dsh-wb-runtimes-");
  const store = new SnapshotStore({ home, root: snapshotRoot });
  const snap = store.create(runtime.runtime, "fixture");
  writeFileSync(join(home, "settings.yaml"), "dirty\n");
  store.restore(snap.id, runtime.runtime);

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

  const locked = await runDoctor([
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
  assert.equal(locked.code, 3);
  assert.equal(jsonOf(locked.stdout).code, "LOCK_HELD");
  assert.equal(existsSync(join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE)), true);

  rmSync(join(home, HOME_LOCK_DIR_NAME), { recursive: true, force: true });
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
  assert.equal(result.code, 10);
  assert.equal(jsonOf(result.stdout).code, "RECOVERY_MODE");
  assert.equal(existsSync(join(instances, "coding.json")), true);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  assert.equal(store.pendingRestore()?.snapshotId, snap.id);
});

test("ambiguous control ownership is not stolen", async () => {
  const home = tempDir("dsh-wb-doctor-amb-");
  seedHome(home, "amb\n");
  const runtime = writeRuntime(tempDir("dsh-wb-rt-amb-"), "0.1.5-rc.1");
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME), { recursive: true });
  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE), "not-json\n");
  const result = await runDoctor([
    "recover",
    "--home",
    home,
    "--cli",
    runtime.bin,
    "--snapshot-root",
    tempDir("dsh-wb-snaps-amb-"),
    "--runtime-root",
    tempDir("dsh-wb-rtroot-amb-"),
  ]);
  assert.equal(result.code, 3);
  assert.equal(jsonOf(result.stdout).code, "LOCK_HELD");
  assert.equal(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE), "utf8"),
    "not-json\n",
  );
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
  store.restore(snap.id, runtime.runtime);
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
  assert.equal(result.code, 10, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.code, "RECOVERY_REQUIRED");
  assert.equal(body.recoveryRequired, true);
  assert.equal(body.restoreCompleted, true);
  assert.equal(body.reopenWorkbench, false);
  assert.equal(readFileSync(jobPath, "utf8"), "{\"schemaVersion\":1,\"status\":\"running\"");
  const queued = JSON.parse(readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "queued-ok.json"), "utf8")) as {
    status: string;
  };
  assert.equal(queued.status, "cancelled");
  const plugin = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "plugin-running.json"), "utf8"),
  ) as { status: string };
  assert.equal(plugin.status, "recovery-required");
  const other = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "other-snap-job.json"), "utf8"),
  ) as { status: string };
  assert.equal(other.status, "recovery-required");
  assert.equal(store.pendingRestore(), undefined);
  const blockers = body.blockers as string[];
  assert.ok(Array.isArray(blockers) && blockers.length > 0);
  assert.doesNotMatch(String(body.message), /real DSH/i);
  assert.doesNotMatch(result.stdout, /Offline recovery finished/);
});

test("recover completes a real SnapshotStore pending restore and reads runtime back", async () => {
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
  store.restore(snap.id, runtime.runtime);
  assert.ok(store.pendingRestore());
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "original-settings\n");

  const dry = await runDoctor([
    "recover",
    "--home",
    home,
    "--cli",
    runtime.bin,
    "--snapshot-root",
    snapshotRoot,
    "--runtime-root",
    runtimeRoot,
    "--dry-run",
  ]);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.equal(jsonOf(dry.stdout).dryRun, true);
  assert.ok(store.pendingRestore());

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
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.restoreCompleted, true);
  assert.equal(body.instancesStopped, true);
  assert.equal(body.reopenWorkbench, true);
  assert.equal(body.controllerKind, "web");
  assert.equal(body.runtimeVersion, "0.1.5-rc.1");
  assert.equal(store.pendingRestore(), undefined);
  assert.equal(existsSync(join(home, RESTORE_STAGE_DIR)), false);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "original-settings\n");
  assert.equal(readFileSync(join(home, "profiles", "coding", "cordis.patch.yml"), "utf8"), "coding\n");
  assert.equal(readFileSync(join(home, ".credentials.yaml"), "utf8"), "secret-key\n");
  const pointer = JSON.parse(readFileSync(join(runtimeRoot, "current.json"), "utf8")) as { version: string };
  assert.equal(pointer.version, "0.1.5-rc.1");
  const toolchain = JSON.parse(readFileSync(join(home, HOME_CONTROL_DIR_NAME, "toolchain.json"), "utf8")) as {
    bin: string;
    dshVersion: string;
    nodeExe: string;
    runtimeRoot: string;
    snapshotRoot: string;
    toolchainRoot: string;
    boundAt: string;
  };
  assert.equal(toolchain.dshVersion, "0.1.5-rc.1");
  assert.notEqual(toolchain.bin, join(runtimeRoot, "old-bin.js"));
  assert.equal(toolchain.nodeExe, join(runtimeRoot, "node.exe"));
  assert.equal(toolchain.runtimeRoot, runtimeRoot);
  assert.equal(toolchain.snapshotRoot, snapshotRoot);
  assert.equal(toolchain.toolchainRoot, join(runtimeRoot, "toolchain"));
  assert.equal(toolchain.boundAt, "2026-01-01T00:00:00.000Z");
  assert.doesNotMatch(result.stdout, /secret-key/);
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME)), false);
});

test("rollback requires explicit snapshot id and restores whole Home with a before-restore backup", async () => {
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
  assert.equal(missingId.code, 2);
  assert.equal(jsonOf(missingId.stdout).code, "USAGE");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "snap-b\n");

  const dry = await runDoctor([
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
    "--dry-run",
  ]);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  const dryBody = jsonOf(dry.stdout);
  assert.equal(dryBody.dryRun, true);
  assert.equal(dryBody.target, snap.id);
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
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.snapshotId, snap.id);
  assert.equal(typeof body.beforeRestoreId, "string");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "snap-a\n");
  assert.equal(existsSync(join(home, "hub")), false);
  assert.equal(store.pendingRestore(), undefined);
  const before = store.preview(String(body.beforeRestoreId));
  assert.equal(before.reason, "before-restore");
  assert.equal(before.presence.hub, true);
  assert.equal(body.runtimeVersion, "0.1.5-rc.1");
  assert.equal(body.instancesStopped, true);
});

test("unknown CLI cannot write recover or rollback; rc.2 is a validated write version", async () => {
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
  assert.equal(unknown.code, 6);
  assert.equal(jsonOf(unknown.stdout).code, "RUNTIME_REFUSED");

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
  assert.equal(unpublished.code, 6);
  assert.equal(jsonOf(unpublished.stdout).code, "RUNTIME_REFUSED");

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
  assert.notEqual(jsonOf(rc2write.stdout).code, "RUNTIME_REFUSED");
  assert.notEqual(rc2write.code, 6);
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
  assert.ok(findings.some((row) => /whole-home snapshot rollback/i.test(row)));
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
  store.restore(snap.id, runtime.runtime);
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
  assert.notEqual(result.code, 0);
  const body = jsonOf(result.stdout);
  assert.equal(body.ok, false);
  assert.notEqual(body.code, undefined);
  assert.notEqual(body.reopenWorkbench, true);
  const queued = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "queued-keep.json"), "utf8"),
  ) as { status: string };
  assert.equal(queued.status, "queued");
});

test("upgrade preparing cleanup does not clear plugin mutation evidence", async () => {
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
  assert.equal(result.code, 10, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.recoveryRequired, true);
  assert.equal(body.restoreCompleted, false);
  assert.equal(readFileSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json"), "utf8"), mutation);
  const plugin = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "plugin-running.json"), "utf8"),
  ) as { status: string };
  assert.notEqual(plugin.status, "succeeded");
});

test("whole-home rollback archives plugin mutation and settles only the matching plan", async () => {
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
  assert.equal(result.code, 10, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.recoveryRequired, true);
  assert.equal(body.restoreCompleted, true);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "snap-a\n");
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json")), false);
  const archived = readdirSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation-archive"));
  assert.equal(archived.length, 1);
  assert.equal(
    existsSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation-files", "coding", "package.json")),
    true,
  );
  const plugin = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "plugin-running.json"), "utf8"),
  ) as { status: string };
  assert.equal(plugin.status, "failed");
  const other = JSON.parse(
    readFileSync(join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, "other-snap-job.json"), "utf8"),
  ) as { status: string };
  assert.equal(other.status, "recovery-required");
  const toolchain = JSON.parse(readFileSync(join(home, HOME_CONTROL_DIR_NAME, "toolchain.json"), "utf8")) as {
    dshVersion: string;
    nodeExe: string;
    runtimeRoot: string;
    snapshotRoot: string;
  };
  assert.equal(toolchain.dshVersion, "0.1.5-rc.1");
  assert.equal(toolchain.nodeExe, process.execPath);
  assert.equal(toolchain.runtimeRoot, runtimeRoot);
  assert.equal(toolchain.snapshotRoot, snapshotRoot);

  const again = await runDoctor([
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
  assert.equal(again.code, 10);
  assert.equal(jsonOf(again.stdout).code, "RECOVERY_REQUIRED");
  assert.notEqual(jsonOf(again.stdout).code, "PLUGIN_MUTATION_OPEN");
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json")), false);
});
