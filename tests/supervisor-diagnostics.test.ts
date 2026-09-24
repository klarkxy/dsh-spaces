import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SUPERVISOR_DIAGNOSTICS_ENV,
  SUPERVISOR_DIAGNOSTICS_MAX_BYTES,
  SUPERVISOR_DIAGNOSTICS_MAX_EVENTS,
  SUPERVISOR_DIAGNOSTICS_UNAVAILABLE,
  SUPERVISOR_DIAGNOSTICS_UNREADABLE,
  createSupervisorDiagnosticsReporter,
  readSupervisorDiagnostics,
  reportSupervisorExit,
  reportSupervisorLaunchFailure,
} from "../src/adapters/node/supervisor-diagnostics.ts";

const SECRET = "dsh-diag-secret-sentinel-9f3c2b1a";
const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const diagnosticsModule = fileURLToPath(
  new URL("../src/adapters/node/supervisor-diagnostics.ts", import.meta.url),
);
const supervisorCli = fileURLToPath(new URL("../packages/supervisor/src/index.ts", import.meta.url));

const temps: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-supervisor-diag-"));
  temps.push(dir);
  return dir;
}

function diagFile(dir = tempDir()): string {
  return join(dir, "run-diag.json");
}

function secretPayload(): string {
  return [
    `Authorization: Bearer ${SECRET}`,
    `Cookie: sid=${SECRET}`,
    `Set-Cookie: sid=${SECRET}; HttpOnly`,
    `Authorization: Basic ${SECRET}`,
    `{"bearer":"${SECRET}"}`,
    `token=${SECRET}`,
    `bootstrap=http://127.0.0.1:9/bootstrap/${SECRET}`,
    `http://127.0.0.1:9/bootstrap/${SECRET}`,
    `C:\\Users\\ada\\${SECRET}\\host.bearer`,
    `/home/ada/${SECRET}/host.bearer`,
  ].join(" ");
}

function assertNoSecret(text: string): void {
  assert.equal(text.includes(SECRET), false, `secret sentinel leaked: ${text}`);
}

function trySymlink(target: string, dest: string): boolean {
  try {
    symlinkSync(target, dest, process.platform === "win32" ? "file" : undefined);
    return true;
  } catch {
    return false;
  }
}

async function waitExit(
  child: ChildProcess,
  timeoutMs = 20_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return await new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectWait(new Error(`timed out waiting for child exit; stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectWait(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveWait({ code, signal, stdout, stderr });
    });
  });
}

test("readSupervisorDiagnostics does not throw on missing or corrupt input", () => {
  const missing = join(tempDir(), "missing.json");
  assert.deepEqual(readSupervisorDiagnostics(missing), [SUPERVISOR_DIAGNOSTICS_UNAVAILABLE]);
  assert.deepEqual(readSupervisorDiagnostics(""), [SUPERVISOR_DIAGNOSTICS_UNAVAILABLE]);
  assert.deepEqual(readSupervisorDiagnostics("relative.json"), [SUPERVISOR_DIAGNOSTICS_UNREADABLE]);

  const corrupt = diagFile();
  writeFileSync(corrupt, "{not-json", "utf8");
  assert.deepEqual(readSupervisorDiagnostics(corrupt), [SUPERVISOR_DIAGNOSTICS_UNREADABLE]);

  const wrong = diagFile();
  writeFileSync(wrong, `${JSON.stringify({ version: 2, stage: "failure" })}\n`);
  assert.deepEqual(readSupervisorDiagnostics(wrong), [SUPERVISOR_DIAGNOSTICS_UNREADABLE]);

  const dir = join(tempDir(), "as-dir");
  mkdirSync(dir);
  assert.deepEqual(readSupervisorDiagnostics(dir), [SUPERVISOR_DIAGNOSTICS_UNREADABLE]);
});

test("launch failure and reporter records redact secrets, bootstrap URLs, and absolute paths", () => {
  const file = diagFile();
  reportSupervisorLaunchFailure(file, secretPayload());
  const raw = readFileSync(file, "utf8");
  assertNoSecret(raw);
  assert.equal(/bootstrap=http/i.test(raw), false);
  assert.equal(raw.includes(`/bootstrap/${SECRET}`), false);
  const reasons = readSupervisorDiagnostics(file);
  assert.ok(reasons.length >= 2);
  assert.equal(reasons.some((row) => row.startsWith("Stage: launch-failure")), true);
  assert.equal(reasons.some((row) => row.startsWith("At: ")), true);
  assertNoSecret(reasons.join("\n"));
  assert.equal(reasons.join("\n").includes(`/bootstrap/${SECRET}`), false);

  const reporter = createSupervisorDiagnosticsReporter(file);
  reporter.recordStarting();
  reporter.recordFailure(new Error(secretPayload()), { exit: 1 });
  const after = readFileSync(file, "utf8");
  assertNoSecret(after);
  const failed = readSupervisorDiagnostics(file);
  assert.equal(failed.some((row) => row === "Stage: failure"), true);
  assert.equal(failed.some((row) => row === "Exit code: 1"), true);
  assertNoSecret(failed.join("\n"));
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test("parent launch failure omits observer pid", () => {
  const file = diagFile();
  reportSupervisorLaunchFailure(file, "spawn failed");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; events: Array<{ pid?: number }> };
  assert.equal(parsed.pid, undefined);
  assert.equal(parsed.events[0]?.pid, undefined);
});

test("each HTTP and JSON credential shape is redacted independently on disk and readback", () => {
  for (const message of [
    `Cookie: sid=${SECRET}`,
    `Set-Cookie: sid=${SECRET}; HttpOnly`,
    `Authorization: Basic ${SECRET}`,
    `{"bearer":"${SECRET}"}`,
    `{"authorization":"Basic ${SECRET}"}`,
    `{"nonce":"${SECRET}"}`,
  ]) {
    const file = diagFile();
    createSupervisorDiagnosticsReporter(file).recordFailure(message, { exit: 1 });
    assertNoSecret(readFileSync(file, "utf8"));
    assertNoSecret(readSupervisorDiagnostics(file).join("\n"));
    // Reading a pre-existing record must apply the same redaction boundary.
    const document = JSON.parse(readFileSync(file, "utf8"));
    document.events[0].message = message;
    writeFileSync(file, JSON.stringify(document));
    assertNoSecret(readSupervisorDiagnostics(file).join("\n"));
  }
});

test("oversized and corrupt existing files are not rewritten", () => {
  const oversized = diagFile();
  const oversizedBody = "x".repeat(SUPERVISOR_DIAGNOSTICS_MAX_BYTES + 8);
  writeFileSync(oversized, oversizedBody, "utf8");
  assert.deepEqual(readSupervisorDiagnostics(oversized), [SUPERVISOR_DIAGNOSTICS_UNREADABLE]);
  reportSupervisorLaunchFailure(oversized, secretPayload());
  createSupervisorDiagnosticsReporter(oversized).recordFailure(new Error(SECRET));
  reportSupervisorExit(oversized, 1, null);
  assert.equal(readFileSync(oversized, "utf8"), oversizedBody);
  assertNoSecret(readSupervisorDiagnostics(oversized).join("\n"));

  const corrupt = diagFile();
  const corruptBody = `{not-json ${SECRET}`;
  writeFileSync(corrupt, corruptBody, "utf8");
  assert.deepEqual(readSupervisorDiagnostics(corrupt), [SUPERVISOR_DIAGNOSTICS_UNREADABLE]);
  reportSupervisorLaunchFailure(corrupt, secretPayload());
  createSupervisorDiagnosticsReporter(corrupt).recordStarting();
  reportSupervisorExit(corrupt, null, "SIGKILL");
  assert.equal(readFileSync(corrupt, "utf8"), corruptBody);

  const tooMany = diagFile();
  const events = Array.from({ length: SUPERVISOR_DIAGNOSTICS_MAX_EVENTS + 1 }, (_, i) => ({
    at: "2026-01-01T00:00:00.000Z",
    stage: "ready",
    message: `event-${i}`,
  }));
  const tooManyBody = `${JSON.stringify({
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    stage: "ready",
    events,
  })}\n`;
  writeFileSync(tooMany, tooManyBody, "utf8");
  assert.ok(Buffer.byteLength(tooManyBody, "utf8") <= SUPERVISOR_DIAGNOSTICS_MAX_BYTES);
  assert.deepEqual(readSupervisorDiagnostics(tooMany), [SUPERVISOR_DIAGNOSTICS_UNREADABLE]);
  createSupervisorDiagnosticsReporter(tooMany).recordFailure(new Error("should not replace"));
  assert.equal(readFileSync(tooMany, "utf8"), tooManyBody);
});

test("diagnostic writes stay within the size and event bounds", () => {
  const file = diagFile();
  const reporter = createSupervisorDiagnosticsReporter(file);
  const bulky = "n".repeat(1800);
  for (let i = 0; i < SUPERVISOR_DIAGNOSTICS_MAX_EVENTS + 20; i += 1) {
    reporter.recordFailure(new Error(`${bulky}-${i}`), { exit: 1 });
  }
  const raw = readFileSync(file, "utf8");
  assert.ok(Buffer.byteLength(raw, "utf8") <= SUPERVISOR_DIAGNOSTICS_MAX_BYTES);
  const parsed = JSON.parse(raw) as { events: unknown[] };
  assert.ok(Array.isArray(parsed.events));
  assert.ok(parsed.events.length <= SUPERVISOR_DIAGNOSTICS_MAX_EVENTS);
  assert.ok(parsed.events.length >= 1);
  const reasons = readSupervisorDiagnostics(file);
  assert.ok(reasons.length >= 1);
  assert.ok(reasons.length <= 32);
  assert.equal(reasons.some((row) => row === "Stage: failure"), true);
});

test("existing symlink diagnostic files are not followed or rewritten", (t) => {
  const dir = tempDir();
  const target = join(dir, "target.json");
  writeFileSync(target, SECRET, "utf8");
  const link = join(dir, "run-diag.json");
  if (!trySymlink(target, link)) {
    t.skip("file symlink is not testable on this Windows account");
    return;
  }
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  reportSupervisorLaunchFailure(link, `failed ${SECRET}`);
  createSupervisorDiagnosticsReporter(link).recordFailure(new Error(SECRET));
  assert.equal(readFileSync(target, "utf8"), SECRET);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  const reasons = readSupervisorDiagnostics(link);
  assert.deepEqual(reasons, [SUPERVISOR_DIAGNOSTICS_UNREADABLE]);
  assertNoSecret(reasons.join("\n"));
});

test("symlink parent directories are refused", (t) => {
  const dir = tempDir();
  const real = join(dir, "real");
  mkdirSync(real);
  writeFileSync(join(real, "keep.txt"), "keep", "utf8");
  const linked = join(dir, "linked");
  try {
    symlinkSync(real, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`directory junction is not testable: ${String(error)}`);
    return;
  }
  const file = join(linked, "run-diag.json");
  reportSupervisorLaunchFailure(file, "spawn failed");
  assert.equal(existsSync(join(real, "run-diag.json")), false);
  assert.deepEqual(readSupervisorDiagnostics(file), [SUPERVISOR_DIAGNOSTICS_UNREADABLE]);
});

test("reportSupervisorExit preserves failure details and omits observer pid", () => {
  const file = diagFile();
  const reporter = createSupervisorDiagnosticsReporter(file);
  reporter.recordStarting();
  reporter.recordFailure(new Error(`boom ${secretPayload()}`), { exit: 1 });
  reportSupervisorExit(file, null, "SIGKILL");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    stage: string;
    pid?: number;
    events: Array<{ stage: string; pid?: number; signal?: string | null; message?: string }>;
  };
  assert.equal(parsed.stage, "failure");
  const exitEvent = parsed.events.at(-1);
  assert.equal(exitEvent?.stage, "exit");
  assert.equal(exitEvent?.signal, "SIGKILL");
  assert.equal("pid" in (exitEvent ?? {}), false);
  assert.equal(parsed.events.some((event) => event.stage === "failure"), true);
  const reasons = readSupervisorDiagnostics(file);
  assert.equal(reasons.some((row) => row === "Stage: exit"), true);
  assert.equal(reasons.some((row) => /Last failure: boom/.test(row)), true);
  assert.equal(reasons.some((row) => row === "Signal: SIGKILL"), true);
  assertNoSecret(readFileSync(file, "utf8"));
  assertNoSecret(reasons.join("\n"));
});

test("reportSupervisorExit keeps a recorded normal stop on exit 0", () => {
  const file = diagFile();
  const reporter = createSupervisorDiagnosticsReporter(file);
  reporter.recordStarting();
  reporter.recordReady();
  reporter.recordNormalStop({ exit: 0 });
  const before = readFileSync(file, "utf8");
  reportSupervisorExit(file, 0, null);
  assert.equal(readFileSync(file, "utf8"), before);
  const reasons = readSupervisorDiagnostics(file);
  assert.equal(reasons.some((row) => row === "Stage: stop"), true);
  assert.equal(reasons.some((row) => row === "Supervisor stopped."), true);
});

test("reportSupervisorExit records an honest observation when JS never wrote a stop", () => {
  const file = diagFile();
  reportSupervisorExit(file, 137, null);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    stage: string;
    pid?: number;
    events: Array<{ stage: string; pid?: number; exit?: number | null }>;
  };
  assert.equal(parsed.pid, undefined);
  assert.equal(parsed.stage, "exit");
  assert.equal(parsed.events[0]?.stage, "exit");
  assert.equal(parsed.events[0]?.exit, 137);
  assert.equal("pid" in parsed.events[0], false);
  const reasons = readSupervisorDiagnostics(file);
  assert.equal(reasons.some((row) => row === "Stage: exit"), true);
  assert.equal(reasons.some((row) => row === "Exit code: 137"), true);
});

test("reporting never throws for unusable paths", () => {
  const dir = join(tempDir(), "as-dir");
  mkdirSync(dir);
  assert.doesNotThrow(() => reportSupervisorLaunchFailure(dir, secretPayload()));
  assert.doesNotThrow(() => createSupervisorDiagnosticsReporter(dir).recordFailure(new Error(SECRET)));
  assert.doesNotThrow(() => reportSupervisorExit(dir, 1, "SIGKILL"));
  assert.doesNotThrow(() => createSupervisorDiagnosticsReporter("relative.json").recordStarting());
  assert.deepEqual(readSupervisorDiagnostics(dir), [SUPERVISOR_DIAGNOSTICS_UNREADABLE]);
});

test("CLI entry startup failure records starting then failure in an isolated subprocess", async () => {
  const file = diagFile();
  const child = spawn(process.execPath, ["--import", "tsx", supervisorCli], {
    cwd: repoRoot,
    env: {
      ...process.env,
      [SUPERVISOR_DIAGNOSTICS_ENV]: file,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const result = await waitExit(child);
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as { stage: string; events: Array<{ stage: string }> };
  assert.equal(parsed.events.filter((event) => event.stage === "starting").length, 1);
  assert.equal(parsed.stage, "failure");
  assert.equal(parsed.events.some((event) => event.stage === "failure"), true);
  assert.equal(parsed.events.some((event) => event.stage === "ready"), false);
  const reasons = readSupervisorDiagnostics(file);
  assert.equal(reasons.some((row) => row === "Stage: failure"), true);
  assert.equal(reasons.some((row) => row.startsWith("At: ")), true);
  assert.equal(reasons.some((row) => /--home is required|supervisor failed/i.test(row)), true);
  assertNoSecret(raw);
});

test("uncaughtExceptionMonitor records failure without restart in an isolated subprocess", async () => {
  const dir = tempDir();
  const file = join(dir, "run-diag.json");
  const script = join(dir, "throw-uncaught.mts");
  writeFileSync(
    script,
    `import { bindSupervisorDiagnostics } from ${JSON.stringify(pathToFileURL(diagnosticsModule).href)};
const reporter = bindSupervisorDiagnostics(process.env);
reporter?.recordStarting();
setImmediate(() => {
  throw new Error(${JSON.stringify(`uncaught Authorization: Bearer ${SECRET}`)});
});
`,
    "utf8",
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      [SUPERVISOR_DIAGNOSTICS_ENV]: file,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const result = await waitExit(child);
  assert.notEqual(result.code, 0);
  const raw = readFileSync(file, "utf8");
  assertNoSecret(raw);
  const parsed = JSON.parse(raw) as { stage: string; events: Array<{ stage: string; message?: string }> };
  assert.equal(parsed.events.filter((event) => event.stage === "starting").length, 1);
  assert.equal(parsed.stage, "failure");
  const reasons = readSupervisorDiagnostics(file);
  assert.equal(reasons.some((row) => row === "Stage: failure"), true);
  assert.equal(reasons.some((row) => /uncaught/i.test(row)), true);
  assertNoSecret(reasons.join("\n"));
  assert.equal(parsed.events.some((event) => event.stage === "ready"), false);
});

test("process.exit without a recorded outcome writes an unplanned exit in an isolated subprocess", async () => {
  const dir = tempDir();
  const file = join(dir, "run-diag.json");
  const script = join(dir, "unplanned-exit.mts");
  writeFileSync(
    script,
    `import { bindSupervisorDiagnostics } from ${JSON.stringify(pathToFileURL(diagnosticsModule).href)};
const reporter = bindSupervisorDiagnostics(process.env);
reporter?.recordStarting();
process.exit(2);
`,
    "utf8",
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: repoRoot,
    env: { ...process.env, [SUPERVISOR_DIAGNOSTICS_ENV]: file },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const result = await waitExit(child);
  assert.equal(result.code, 2);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    stage: string;
    events: Array<{ stage: string; message?: string; exit?: number | null }>;
  };
  assert.equal(parsed.events.filter((event) => event.stage === "starting").length, 1);
  assert.equal(parsed.stage, "failure");
  assert.equal(parsed.events.some((event) => /without a recorded stop/i.test(event.message ?? "")), true);
  assert.equal(parsed.events.some((event) => event.exit === 2), true);
  const reasons = readSupervisorDiagnostics(file);
  assert.equal(reasons.some((row) => row === "Exit code: 2"), true);
});

test("process.exit after a recorded failure does not replace it", async () => {
  const dir = tempDir();
  const file = join(dir, "run-diag.json");
  const script = join(dir, "planned-failure-exit.mts");
  writeFileSync(
    script,
    `import { bindSupervisorDiagnostics } from ${JSON.stringify(pathToFileURL(diagnosticsModule).href)};
const reporter = bindSupervisorDiagnostics(process.env);
reporter?.recordStarting();
reporter?.recordFailure(new Error(${JSON.stringify(`kept Authorization: Bearer ${SECRET}`)}), { exit: 1 });
process.exit(1);
`,
    "utf8",
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: repoRoot,
    env: { ...process.env, [SUPERVISOR_DIAGNOSTICS_ENV]: file },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const result = await waitExit(child);
  assert.equal(result.code, 1);
  const raw = readFileSync(file, "utf8");
  assertNoSecret(raw);
  const parsed = JSON.parse(raw) as { events: Array<{ stage: string; message?: string }> };
  const failures = parsed.events.filter((event) => event.stage === "failure");
  assert.equal(failures.length, 1);
  assert.match(failures[0]?.message ?? "", /kept /);
  assert.equal(parsed.events.some((event) => /without a recorded stop/i.test(event.message ?? "")), false);
});

test("supervisor CLI binds diagnostics before main and does not restart on failure", () => {
  const source = readFileSync(supervisorCli, "utf8");
  const diagnosticsSource = readFileSync(diagnosticsModule, "utf8");
  const bindAt = source.indexOf("bindSupervisorDiagnostics");
  const startingAt = source.indexOf("recordStarting");
  const mainCallAt = source.indexOf("main(process.argv.slice(2), diagnostics)");
  assert.ok(bindAt >= 0);
  assert.ok(startingAt >= 0);
  assert.ok(mainCallAt >= 0);
  assert.ok(bindAt < mainCallAt);
  assert.ok(startingAt < mainCallAt);
  const stopFn = source.slice(source.indexOf("const stop = async"), source.indexOf("const onSignal"));
  const closeAt = stopFn.indexOf("await handle.close()");
  const recordedStopAt = stopFn.indexOf("recordNormalStop");
  assert.ok(closeAt >= 0);
  assert.ok(recordedStopAt > closeAt);
  assert.match(source, /recordReady/);
  assert.match(diagnosticsSource, /uncaughtExceptionMonitor/);
  assert.match(diagnosticsSource, /process\.on\(\s*"exit"/);
  assert.match(diagnosticsSource, /export function reportSupervisorExit/);
  assert.equal(/binary search|while \(lo <= hi\)/.test(diagnosticsSource), false);
  assert.equal(source.includes("void stop()"), false);
  assert.equal(/main\(\s*process\.argv[\s\S]*main\(\s*process\.argv/.test(source), false);
  assert.equal(/setTimeout\(\s*\(\)\s*=>\s*main\(/.test(source), false);
  assert.equal(/setInterval|restart\(/.test(diagnosticsSource), false);
});
