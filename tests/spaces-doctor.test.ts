import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOME_LOCK_DIR_NAME,
  HOME_LOCK_OWNER_FILE,
  HOME_RECLAIM_DIR_NAME,
} from "../src/adapters/node/home-operation-lock.ts";
import { MUTATION_JOURNAL_NAME } from "../src/adapters/node/spaces-control.ts";
import { RESTORE_STAGE_DIR } from "../src/shared/snapshots.ts";

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

async function runDoctor(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
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

function linkOrJunction(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : undefined);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}

function writeCli(prefix: string, version: string, dump: string, extra = ""): string {
  const dir = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(dir, "lib"), { recursive: true });
  const bin = join(dir, "lib", "bin.js");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh", version }, null, 2)}\n`,
  );
  writeFileSync(
    bin,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.DSH_HOME;
if (home) writeFileSync(join(home, ".dump-config-ran"), "1");
${extra}
process.stdout.write(${JSON.stringify(dump)});
`,
  );
  return bin;
}

const goodDump = `- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;

test("importing the doctor module has no CLI side effects", async () => {
  const home = tempDir("dsh-doctor-import-");
  const before = existsSync(join(home, ".dsh-spaces-lock"));
  await import("../packages/doctor/src/index.ts");
  assert.equal(before, false);
  assert.equal(existsSync(join(home, ".dsh-spaces-lock")), false);
});

test("refuses to run without explicit --home and does not use DSH_HOME", async () => {
  const decoy = tempDir("dsh-doctor-decoy-");
  const result = await runDoctor(["doctor"], { DSH_HOME: decoy });
  assert.notEqual(result.code, 0);
  const body = jsonOf(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.code, "USAGE");
  assert.equal(existsSync(join(decoy, ".dsh-spaces-lock")), false);
  assert.doesNotMatch(result.stdout, /credentials|settings\.yaml|dump-config/i);
});

test("doctor reports registry, journals, lock, and optional CLI metadata", async () => {
  const home = tempDir("dsh-doctor-home-");
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(
    join(home, "hub", "spaces.json"),
    `${JSON.stringify({ version: 1, onboarded: true, order: ["coding"], meta: {} }, null, 2)}\n`,
  );
  writeFileSync(
    join(home, MUTATION_JOURNAL_NAME),
    `${JSON.stringify({ version: 1, op: "create", spaceId: "coding", phase: "patch", startedAt: "2026-01-01T00:00:00.000Z" })}\n`,
  );
  mkdirSync(join(home, RESTORE_STAGE_DIR), { recursive: true });
  writeFileSync(
    join(home, RESTORE_STAGE_DIR, "journal.json"),
    `${JSON.stringify({ phase: "swapping", snapshotId: "11111111-1111-1111-1111-111111111111" })}\n`,
  );
  const cli = writeCli(tempDir("dsh-doctor-cli-"), "0.1.5-rc.1", goodDump);
  const result = await runDoctor(["doctor", "--home", home, "--cli", cli]);
  assert.equal(result.code, 0);
  const body = jsonOf(result.stdout);
  assert.equal(body.ok, true);
  assert.deepEqual(body.registry, { status: "ok", version: 1, onboarded: true, order: ["coding"] });
  assert.deepEqual(body.journals, {
    mutation: { present: true, op: "create", phase: "patch", spaceId: "coding" },
    restore: { needed: true, phase: "swapping" },
    upgrade: { needed: false },
    pluginMutation: { present: false },
  });
  assert.deepEqual(body.lock, { held: false });
  assert.deepEqual(body.runtime, { bound: true, version: "0.1.5-rc.1", allowed: true });
  assert.equal("bin" in (body.runtime as object), false);
  assert.doesNotMatch(result.stdout, /11111111-1111-1111-1111-111111111111/);
});

test("unlock refuses a live owner and incomplete residue", async () => {
  const liveHome = tempDir("dsh-doctor-live-");
  mkdirSync(join(liveHome, HOME_LOCK_DIR_NAME));
  writeFileSync(
    join(liveHome, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE),
    `${JSON.stringify({ pid: process.pid, nonce: "abc", startedAt: "2026-01-01T00:00:00.000Z", label: "hold" })}\n`,
  );
  const live = await runDoctor(["unlock", "--home", liveHome]);
  assert.equal(live.code, 3);
  assert.equal(jsonOf(live.stdout).reason, "owner-alive");
  assert.equal(existsSync(join(liveHome, HOME_LOCK_DIR_NAME)), true);

  const incompleteHome = tempDir("dsh-doctor-incomplete-");
  mkdirSync(join(incompleteHome, HOME_LOCK_DIR_NAME));
  const incomplete = await runDoctor(["unlock", "--home", incompleteHome]);
  assert.equal(incomplete.code, 3);
  assert.equal(jsonOf(incomplete.stdout).reason, "incomplete");
});

test("unlock clears a dead owner and is a no-op when nothing is held", async () => {
  const home = tempDir("dsh-doctor-dead-");
  mkdirSync(join(home, HOME_LOCK_DIR_NAME));
  writeFileSync(
    join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE),
    `${JSON.stringify({ pid: 999_999_999, nonce: "dead", startedAt: "2026-01-01T00:00:00.000Z", label: "stale" })}\n`,
  );
  const cleared = await runDoctor(["unlock", "--home", home]);
  assert.equal(cleared.code, 0);
  assert.equal(jsonOf(cleared.stdout).unlocked, true);
  assert.equal(existsSync(join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE)), false);

  const idle = await runDoctor(["unlock", "--home", home]);
  assert.equal(idle.code, 0);
  assert.equal(jsonOf(idle.stdout).unlocked, false);
  assert.equal(jsonOf(idle.stdout).reason, "not-held");
});

test("verify refuses paths, web, relative cli, unsupported versions, and held locks", async () => {
  const home = tempDir("dsh-doctor-verify-");
  mkdirSync(join(home, "profiles", "coding"), { recursive: true });
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  const badVersion = writeCli(tempDir("dsh-doctor-old-"), "0.1.1-rc.2", goodDump);
  const goodCli = writeCli(tempDir("dsh-doctor-ok-"), "0.1.5-rc.2", goodDump);

  const pathName = await runDoctor(["verify", "--home", home, "--cli", goodCli, "--profile", "../coding"]);
  assert.equal(pathName.code, 5);
  assert.equal(jsonOf(pathName.stdout).code, "INVALID_PROFILE");

  const web = await runDoctor(["verify", "--home", home, "--cli", goodCli, "--profile", "web"]);
  assert.equal(web.code, 5);
  assert.equal(jsonOf(web.stdout).code, "HOST_DENIED");

  const relativeCli = await runDoctor(["verify", "--home", home, "--cli", relative(home, goodCli), "--profile", "coding"]);
  assert.notEqual(relativeCli.code, 0);
  assert.equal(jsonOf(relativeCli.stdout).code, "USAGE");

  const version = await runDoctor(["verify", "--home", home, "--cli", badVersion, "--profile", "coding"]);
  assert.equal(version.code, 6);
  assert.equal(jsonOf(version.stdout).code, "RUNTIME_REFUSED");

  mkdirSync(join(home, HOME_LOCK_DIR_NAME));
  writeFileSync(
    join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE),
    `${JSON.stringify({ pid: process.pid, nonce: "live", startedAt: "2026-01-01T00:00:00.000Z", label: "hold" })}\n`,
  );
  const held = await runDoctor(["verify", "--home", home, "--cli", goodCli, "--profile", "coding"]);
  assert.equal(held.code, 3);
  assert.equal(jsonOf(held.stdout).code, "LOCK_HELD");
  assert.equal(existsSync(join(home, ".dump-config-ran")), false);
});

test("verify runs dump-config under the lock and asserts isolation", async () => {
  const home = tempDir("dsh-doctor-dump-");
  mkdirSync(join(home, "profiles", "coding"), { recursive: true });
  const cli = writeCli(tempDir("dsh-doctor-dump-cli-"), "0.1.5-rc.1", goodDump);
  const result = await runDoctor(["verify", "--home", home, "--cli", cli, "--profile", "coding"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const body = jsonOf(result.stdout);
  assert.equal(body.valid, true);
  assert.equal(existsSync(join(home, ".dump-config-ran")), true);
  assert.doesNotMatch(result.stdout, /dshHomePath|session-persistence/);
});

test("verify rejects a symlink profile and ancestor profiles junction", async () => {
  const home = tempDir("dsh-doctor-sym-");
  mkdirSync(join(home, "profiles"), { recursive: true });
  const outside = tempDir("dsh-doctor-outside-");
  if (linkOrJunction(outside, join(home, "profiles", "coding"))) {
    const cli = writeCli(tempDir("dsh-doctor-sym-cli-"), "0.1.5-rc.1", goodDump);
    const linked = await runDoctor(["verify", "--home", home, "--cli", cli, "--profile", "coding"]);
    assert.equal(linked.code, 5);
    assert.equal(jsonOf(linked.stdout).code, "PROFILE_SYMLINK");
    assert.equal(existsSync(join(home, ".dump-config-ran")), false);
  }

  const junctionHome = tempDir("dsh-doctor-junc-");
  const leaked = tempDir("dsh-doctor-leaked-");
  mkdirSync(join(leaked, "coding"), { recursive: true });
  if (!linkOrJunction(leaked, join(junctionHome, "profiles"))) return;
  const cli = writeCli(tempDir("dsh-doctor-junc-cli-"), "0.1.5-rc.1", goodDump);
  const escaped = await runDoctor(["verify", "--home", junctionHome, "--cli", cli, "--profile", "coding"]);
  assert.equal(escaped.code, 5);
  assert.equal(jsonOf(escaped.stdout).code, "PROFILE_SYMLINK");
  assert.equal(existsSync(join(junctionHome, ".dump-config-ran")), false);
});

test("doctor treats a hub junction as unreadable and does not unlock", async () => {
  const home = tempDir("dsh-doctor-hubj-");
  const leaked = tempDir("dsh-doctor-hub-out-");
  writeFileSync(
    join(leaked, "spaces.json"),
    `${JSON.stringify({ version: 1, onboarded: true, order: ["coding"], meta: {} })}\n`,
  );
  if (!linkOrJunction(leaked, join(home, "hub"))) return;
  mkdirSync(join(home, HOME_LOCK_DIR_NAME));
  writeFileSync(
    join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE),
    `${JSON.stringify({ pid: process.pid, nonce: "live", startedAt: "2026-01-01T00:00:00.000Z", label: "hold" })}\n`,
  );
  const result = await runDoctor(["doctor", "--home", home]);
  assert.equal(result.code, 0);
  const body = jsonOf(result.stdout);
  assert.deepEqual(body.registry, { status: "invalid", code: "UNREADABLE" });
  assert.equal((body.lock as { held?: boolean }).held, true);
  assert.equal(existsSync(join(home, HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE)), true);
  assert.doesNotMatch(result.stdout, /onboarded/);
});

test("verify refuses a failing isolation dump without printing it", async () => {
  const plain = tempDir("dsh-doctor-bad-dump-");
  mkdirSync(join(plain, "profiles", "coding"), { recursive: true });
  const bad = writeCli(tempDir("dsh-doctor-bad-cli-"), "0.1.5-rc.1", "- id: other\n");
  const failed = await runDoctor(["verify", "--home", plain, "--cli", bad, "--profile", "coding"]);
  assert.equal(failed.code, 4);
  assert.equal(jsonOf(failed.stdout).code, "VERIFY_FAILED");
  assert.doesNotMatch(failed.stdout, /id: other/);
});

test("verify refuses while mutation or restore journals exist", async () => {
  const home = tempDir("dsh-doctor-recov-");
  mkdirSync(join(home, "profiles", "coding"), { recursive: true });
  const cli = writeCli(tempDir("dsh-doctor-recov-cli-"), "0.1.5-rc.1", goodDump);
  writeFileSync(
    join(home, MUTATION_JOURNAL_NAME),
    `${JSON.stringify({ version: 1, op: "create", spaceId: "coding", phase: "patch" })}\n`,
  );
  const mutation = await runDoctor(["verify", "--home", home, "--cli", cli, "--profile", "coding"]);
  assert.equal(mutation.code, 10);
  assert.equal(jsonOf(mutation.stdout).code, "RECOVERY_NEEDED");
  assert.equal(existsSync(join(home, ".dump-config-ran")), false);

  rmSync(join(home, MUTATION_JOURNAL_NAME));
  mkdirSync(join(home, RESTORE_STAGE_DIR), { recursive: true });
  writeFileSync(join(home, RESTORE_STAGE_DIR, "journal.json"), `${JSON.stringify({ phase: "swapping" })}\n`);
  const restore = await runDoctor(["verify", "--home", home, "--cli", cli, "--profile", "coding"]);
  assert.equal(restore.code, 10);
  assert.equal(jsonOf(restore.stdout).code, "RECOVERY_NEEDED");
  assert.equal(existsSync(join(home, ".dump-config-ran")), false);
});

test("unlock and doctor report reclaim as blocked without stealing", async () => {
  const home = tempDir("dsh-doctor-reclaim-");
  mkdirSync(join(home, HOME_RECLAIM_DIR_NAME));
  const viewed = await runDoctor(["doctor", "--home", home]);
  assert.equal(viewed.code, 0);
  assert.deepEqual(jsonOf(viewed.stdout).lock, { held: true, reclaim: true });
  const unlocked = await runDoctor(["unlock", "--home", home]);
  assert.equal(unlocked.code, 3);
  assert.equal(jsonOf(unlocked.stdout).reason, "reclaim-in-progress");
  assert.equal(existsSync(join(home, HOME_RECLAIM_DIR_NAME)), true);
});

test("real-home guard uses a stable code and no filesystem path", async () => {
  const result = await runDoctor(["doctor", "--home", join(homedir(), ".dsh")]);
  assert.equal(result.code, 2);
  const body = jsonOf(result.stdout);
  assert.equal(body.code, "REAL_HOME");
  assert.equal(result.stdout.includes(homedir()), false);
  assert.equal(result.stdout.includes(".dsh"), false);
});

test("dump-config timeout waits for the child to exit and bounds stdout", async () => {
  const home = tempDir("dsh-doctor-to-");
  mkdirSync(join(home, "profiles", "coding"), { recursive: true });
  const hang = writeCli(
    tempDir("dsh-doctor-hang-"),
    "0.1.5-rc.1",
    "",
    `writeFileSync(join(home, ".dump-config-ran"), String(process.pid));
setInterval(() => process.stdout.write("x".repeat(8192)), 5);`,
  );
  const result = await runDoctor(["verify", "--home", home, "--cli", hang, "--profile", "coding"], {
    DSH_SPACES_DOCTOR_DUMP_MS: "400",
  });
  assert.equal(result.code, 4);
  assert.equal(jsonOf(result.stdout).code, "DUMP_FAILED");
  assert.doesNotMatch(result.stdout, /xxxxx/);
  const pidText = readFileSync(join(home, ".dump-config-ran"), "utf8").trim();
  const pid = Number(pidText);
  assert.ok(pid > 0);
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.throws(() => process.kill(pid, 0));
});

test("recover and rollback refuse unknown journals or missing snapshot ids and keep bytes", async () => {
  const home = tempDir("dsh-doctor-rec-");
  mkdirSync(join(home, RESTORE_STAGE_DIR), { recursive: true });
  writeFileSync(join(home, RESTORE_STAGE_DIR, "journal.json"), "{}\n");

  const recovered = await runDoctor(["recover", "--home", home]);
  assert.equal(recovered.code, 10);
  const recoveredBody = jsonOf(recovered.stdout);
  assert.equal(recoveredBody.code, "RECOVERY_NEEDED");
  assert.equal(recoveredBody.command, "recover");
  assert.equal(readFileSync(join(home, RESTORE_STAGE_DIR, "journal.json"), "utf8"), "{}\n");

  const rolled = await runDoctor(["rollback", "--home", home]);
  assert.equal(rolled.code, 2);
  const rolledBody = jsonOf(rolled.stdout);
  assert.equal(rolledBody.code, "USAGE");
  assert.match(String(rolledBody.message), /snapshot/i);
  assert.equal(readFileSync(join(home, RESTORE_STAGE_DIR, "journal.json"), "utf8"), "{}\n");
});
