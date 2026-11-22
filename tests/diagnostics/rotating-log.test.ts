import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  DIAGNOSTIC_LOG_MAX_AGE_MS,
  DIAGNOSTIC_LOG_MAX_ARCHIVE_BYTES,
  DIAGNOSTIC_LOG_MAX_FILE_BYTES,
  createDiagnosticLogger,
  diagnosticLogDirectory,
  readDiagnosticLogTail,
  sanitizeDiagnosticText,
} from "../../src/adapters/node/diagnostics/rotating-log.ts";
import { diagnosticLevelEnabled } from "../../src/shared/diagnostic-log.ts";
import { attachHostDiagnosticLogger } from "../../src/adapters/node/diagnostics/host-log.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { currentOperationDetails, diagnosticCorrelation, diagnosticStep } from "../../src/adapters/node/diagnostics/operation-log.ts";
import { WorkbenchJobStore } from "../../src/adapters/node/maintenance/workbench-jobs.ts";
import { SpacesPlugin } from "../../packages/plugin/src/host/plugin.ts";
import { WorkbenchHostRuntime } from "../../packages/plugin/src/host/runtime.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-rotating-log-"));
  temps.push(dir);
  return dir;
}

function readEntries(dir: string, source = "supervisor"): Array<Record<string, unknown>> {
  const file = join(diagnosticLogDirectory(dir), `${source}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
}

test("diagnostic defaults are seven days and 100 MiB per active file", () => {
  assert.equal(DIAGNOSTIC_LOG_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(DIAGNOSTIC_LOG_MAX_FILE_BYTES, 100 * 1024 * 1024);
  assert.equal(DIAGNOSTIC_LOG_MAX_ARCHIVE_BYTES, 100 * 1024 * 1024);
  assert.equal(diagnosticLevelEnabled("debug", "info"), false);
  for (const level of ["info", "error", "fault"] as const) assert.equal(diagnosticLevelEnabled(level, "info"), true);
});

test("all four levels produce queryable JSONL with error details and without credentials or paths", () => {
  const dir = home();
  const log = createDiagnosticLogger(dir, "supervisor", { now: () => new Date("2026-11-12T01:02:03.004Z") });
  log.debug("probe.stage", "probe ready", { stage: "payload" });
  log.info("service.ready", "ready");
  const secret = "dsh-log-test-secret";
  const error = Object.assign(new Error(`failed Authorization: Bearer ${secret} C:\\Users\\private\\file.txt`), { code: "EIO" });
  error.stack = `Error: failed\n    at fn (C:\\Users\\private\\file.ts:1:2)`;
  log.error("request.failed", `token=${secret}`, error);
  log.fault("process.uncaught", "fatal", new Error(`Cookie: sid=${secret}`));
  const entries = readEntries(dir);
  assert.deepEqual(entries.map(row => row.level), ["debug", "info", "error", "fault"]);
  assert.equal(entries[0]?.at, "2026-11-12T01:02:03.004Z");
  assert.equal(entries[0]?.version, 1);
  assert.equal((entries[2]?.error as { code?: string }).code, "EIO");
  assert.match(String((entries[2]?.error as { stack?: string }).stack), /\[path\]/);
  const raw = readFileSync(join(diagnosticLogDirectory(dir), "supervisor.jsonl"), "utf8");
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes("C:\\Users"), false);
});

test("size rotation archives a complete file and continues the active log", () => {
  const dir = home();
  const log = createDiagnosticLogger(dir, "supervisor", { maxFileBytes: 350, maxArchiveBytes: 10_000 });
  log.info("one", "a".repeat(100));
  log.info("two", "b".repeat(100));
  const files = readdirSync(diagnosticLogDirectory(dir));
  assert.equal(files.filter(file => /^supervisor\..*\.jsonl$/.test(file)).length, 1);
  assert.equal(readEntries(dir).at(-1)?.event, "two");
});

test("age rotation and archive retention remove only expired diagnostic archives", () => {
  const dir = home();
  let now = new Date();
  const log = createDiagnosticLogger(dir, "supervisor", { now: () => now, maxFileBytes: 1, maxAgeMs: 1000, maxArchiveBytes: 10_000 });
  log.info("old", "old");
  now = new Date(now.getTime() + 1000);
  log.info("rotate", "rotate the previous current file");
  const archive = readdirSync(diagnosticLogDirectory(dir)).find(file => /^supervisor\..*Z\.\d+\.\d+\.jsonl$/.test(file));
  assert.ok(archive);
  utimesSync(join(diagnosticLogDirectory(dir), archive), new Date(now.getTime() - 10000), new Date(now.getTime() - 10000));
  now = new Date(now.getTime() + 60_000);
  log.info("new", "new");
  assert.equal(existsSync(join(diagnosticLogDirectory(dir), archive)), false);
  const unrelated = join(diagnosticLogDirectory(dir), "keep.txt");
  writeFileSync(unrelated, "keep");
  log.info("later", "later");
  assert.equal(readFileSync(unrelated, "utf8"), "keep");
});

test("a reopened logger rotates an existing oversized file before appending", () => {
  const dir = home();
  const file = join(diagnosticLogDirectory(dir), "supervisor.jsonl");
  mkdirSync(diagnosticLogDirectory(dir), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, level: "info", event: "old", message: "x".repeat(200) })}\n`);
  createDiagnosticLogger(dir, "supervisor", { maxFileBytes: 100 }).info("new", "new");
  assert.equal(readEntries(dir).length, 1);
  assert.equal(readEntries(dir)[0]?.event, "new");
  assert.equal(readdirSync(diagnosticLogDirectory(dir)).some(name => name.startsWith("supervisor.")), true);
});

test("archive byte cap drops the oldest archive and keeps the current file", () => {
  const dir = home();
  const log = createDiagnosticLogger(dir, "supervisor", { maxFileBytes: 300, maxArchiveBytes: 500 });
  for (let index = 0; index < 6; index += 1) log.info(`event.${index}`, "x".repeat(80));
  assert.ok(readDiagnosticLogTail(log.file).includes("event.5"));
  const archiveBytes = readdirSync(diagnosticLogDirectory(dir))
    .filter(name => name !== "supervisor.jsonl")
    .reduce((total, name) => total + readFileSync(join(diagnosticLogDirectory(dir), name)).length, 0);
  assert.ok(archiveBytes <= 500);
});

test("npm minimum filters only debug records", () => {
  const dir = home();
  const log = createDiagnosticLogger(dir, "supervisor", { minimumLevel: "info" });
  assert.equal(log.debug("hidden", "debug"), false);
  log.info("visible", "info");
  log.error("failure", "error");
  log.fault("fatal", "fault");
  assert.deepEqual(readEntries(dir).map(row => row.event), ["visible", "failure", "fatal"]);
});

test("invalid paths and symlinked active logs are not overwritten", (t) => {
  const dir = home();
  assert.equal(createDiagnosticLogger(dir, "supervisor").debug("bad event", "not valid"), false);
  const target = join(dir, "outside.txt");
  writeFileSync(target, "keep");
  mkdirSync(diagnosticLogDirectory(dir), { recursive: true });
  const link = join(diagnosticLogDirectory(dir), "supervisor.jsonl");
  try { symlinkSync(target, link); } catch { t.skip("File symlink is unavailable on this account."); return; }
  const log = createDiagnosticLogger(dir, "supervisor");
  assert.equal(log.info("event", "not written"), false);
  assert.equal(readFileSync(target, "utf8"), "keep");
  assert.match(log.lastWriteError ?? "", /^The local diagnostic log could not be written:/);
});

test("tail reading returns whole recent lines and text redaction covers URL credentials", () => {
  const dir = home();
  const log = createDiagnosticLogger(dir, "supervisor");
  log.info("first", "first");
  log.info("last", "https://user:password@example.com/?token=secret");
  const tail = readDiagnosticLogTail(log.file, 190);
  assert.equal(tail.includes("first"), false);
  assert.equal(tail.includes("last"), true);
  assert.equal(tail.includes("password"), false);
  assert.equal(tail.includes("token=secret"), false);
  assert.equal(sanitizeDiagnosticText("https://127.0.0.1/bootstrap/private"), "https://127.0.0.1/bootstrap/[redacted]");
});

test("Cordis exporter keeps host debug/info/error records and releases its subscription", () => {
  const dir = home();
  let sink: ((message: { type: string; name: string; args: unknown[] }) => void) | undefined;
  let disposed = false;
  const ctx = { logger: { exporter(exporter: { export(message: { type: string; name: string; args: unknown[] }): void }) {
    sink = message => exporter.export(message);
    return () => { disposed = true; };
  } } };
  const dispose = attachHostDiagnosticLogger(ctx, createDiagnosticLogger(dir, "host"));
  sink?.({ type: "debug", name: "plugin-loader", args: ["debug detail"] });
  sink?.({ type: "info", name: "plugin-loader", args: ["info detail"] });
  sink?.({ type: "error", name: "plugin-loader", args: [new Error("failed")] });
  assert.deepEqual(readEntries(dir, "host").map(row => row.level), ["debug", "info", "error"]);
  assert.equal(readEntries(dir, "host")[0]?.event, "host.log");
  dispose();
  assert.equal(disposed, true);
});

test("process fault hook records an uncaught exception without changing the exit", () => {
  const dir = home();
  const secret = "supervisor-launch-secret";
  const script = join(dir, "fault.mts");
  const module = fileURLToPath(new URL("../../src/adapters/node/diagnostics/rotating-log.ts", import.meta.url));
  writeFileSync(script, `import { createDiagnosticLogger, installProcessDiagnosticLogging } from ${JSON.stringify(new URL(`file:///${module.replace(/\\/g, "/")}`).href)};\ninstallProcessDiagnosticLogging(createDiagnosticLogger(${JSON.stringify(dir)}, "supervisor"));\nsetImmediate(() => { throw new Error("failed token=${secret}"); });\n`);
  const run = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 20_000 });
  assert.notEqual(run.status, 0, run.stderr);
  assert.equal(run.signal, null, run.stderr);
  const entries = readEntries(dir);
  assert.equal(entries.some(row => row.event === "process.uncaught" && row.level === "fault"), true, run.stderr);
  assert.equal(readFileSync(join(diagnosticLogDirectory(dir), "supervisor.jsonl"), "utf8").includes(secret), false);
});

test("job phases and failures persist their job correlation in diagnostic JSONL", async () => {
  const dir = home();
  const log = createDiagnosticLogger(dir, "supervisor");
  const jobs = new WorkbenchJobStore({ home: dir, diagnosticLog: log });
  await jobs.submit({ kind: "space.start", spaceId: "coding" }, "diagnostic-job", async (ctx) => {
    await diagnosticStep(log, "space.verify", { space: "coding" }, async () => {
      ctx.phase("verify");
    });
    throw new Error("token=job-secret C:\\private\\job.log");
  });
  await jobs.whenIdle();
  const entries = readEntries(dir);
  const step = entries.find(row => row.event === "step.completed");
  const stepContext = step?.context as Record<string, unknown>;
  assert.equal(stepContext.space, "coding");
  assert.equal(stepContext.operation, "space.start");
  assert.equal(stepContext.operationId, "diagnostic-job");
  assert.equal(stepContext.step, "space.verify");
  assert.equal(typeof stepContext.durationMs, "number");
  const phase = entries.find(row => row.event === "job.phase");
  assert.equal((phase?.context as { phase?: unknown })?.phase, "verify");
  const failure = entries.find(row => row.event === "job.failed");
  assert.equal(failure?.level, "error");
  assert.equal(readFileSync(log.file, "utf8").includes("job-secret"), false);
  assert.equal(readFileSync(log.file, "utf8").includes("C:\\private"), false);
});

test("logging leaves Node's unhandled rejection exit policy intact", () => {
  const dir = home();
  const module = new URL("../../src/adapters/node/diagnostics/rotating-log.ts", import.meta.url).href;
  const script = join(dir, "rejected.mts");
  writeFileSync(script, `import { createDiagnosticLogger, installProcessDiagnosticLogging } from ${JSON.stringify(module)};
installProcessDiagnosticLogging(createDiagnosticLogger(${JSON.stringify(dir)}, "supervisor"));
Promise.reject(new Error("unhandled-probe"));
`);
  const run = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(readEntries(dir).some(row => row.event === "process.unhandled-rejection"));
});

test("a request correlation crosses asynchronous boundaries and nested steps", async () => {
  const dir = home();
  const log = createDiagnosticLogger(dir, "supervisor");
  await diagnosticCorrelation("http-test-17", async () => {
    assert.equal(currentOperationDetails()?.operationId, "http-test-17");
    log.debug("request.started", "Request started.");
    await diagnosticStep(log, "product.read", { space: "coding" }, async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  });
  assert.deepEqual(readEntries(dir).map(row => (row.context as { operationId?: unknown })?.operationId), [undefined, "http-test-17", "http-test-17"]);
  assert.deepEqual(readEntries(dir).map(row => row.event), ["request.started", "step.started", "step.completed"]);
});

test("unconfirmed host identity does not open or write host.jsonl", () => {
  const dir = home();
  mkdirSync(join(dir, "profiles", "web"), { recursive: true });
  const runtime = new WorkbenchHostRuntime({
    home: dir,
    allowRealHome: true,
    argv: [process.execPath, "dsh", "--profile", "web"],
    env: { ...process.env, DSH_HOME: dir },
  });
  assert.equal(runtime.identity.confirmed, false);
  new SpacesPlugin(new Context(), {}, runtime);
  assert.equal(existsSync(diagnosticLogDirectory(dir)), false);
});

test("real ~/.dsh stays refused by default and works on explicit product host, bootstrap, and supervisor entries", () => {
  const fakeUser = home();
  const realHome = join(fakeUser, ".dsh");
  mkdirSync(join(realHome, "profiles", "web"), { recursive: true });
  const fakeBin = join(fakeUser, "dsh-cli.mjs");
  writeFileSync(fakeBin, "export {};\n");

  const rotatingModule = pathToFileURL(fileURLToPath(new URL("../../src/adapters/node/diagnostics/rotating-log.ts", import.meta.url))).href;
  const pluginModule = pathToFileURL(fileURLToPath(new URL("../../packages/plugin/src/host/plugin.ts", import.meta.url))).href;
  const bootstrapModule = pathToFileURL(fileURLToPath(new URL("../../packages/plugin/src/host/supervisor-bootstrap.ts", import.meta.url))).href;
  const cordisModule = import.meta.resolve("@deepseek-ai/cordis");
  const supervisorEntry = fileURLToPath(new URL("../../packages/supervisor/src/index.ts", import.meta.url));

  const hostScript = join(fakeUser, "real-home-host.mts");
  writeFileSync(
    hostScript,
    [
      `import assert from "node:assert/strict";`,
      `import { Context } from ${JSON.stringify(cordisModule)};`,
      `import { createDiagnosticLogger } from ${JSON.stringify(rotatingModule)};`,
      `import { SpacesPlugin } from ${JSON.stringify(pluginModule)};`,
      `import { bootstrapSupervisor } from ${JSON.stringify(bootstrapModule)};`,
      `const realHome = ${JSON.stringify(realHome)};`,
      `assert.throws(() => createDiagnosticLogger(realHome, "host"), /refusing to use the real DSH home/);`,
      `await assert.rejects(() => bootstrapSupervisor({ home: realHome, allowRealHome: false, allowColdStart: false }), /refusing to use the real DSH home/);`,
      `const ctx = Object.assign(new Context(), { baseUrl: ${JSON.stringify(`${pathToFileURL(join(realHome, "profiles", "web")).href}/`)} });`,
      `new SpacesPlugin(ctx, {});`,
      `ctx.logger.info("real home cordis log");`,
      `const discovery = await bootstrapSupervisor({ home: realHome, allowRealHome: true, allowColdStart: false });`,
      `assert.equal(discovery.connected, false);`,
    ].join("\n"),
  );
  const env = {
    ...process.env,
    HOME: fakeUser,
    USERPROFILE: fakeUser,
    DSH_HOME: realHome,
    DSH_SPACES_ALLOW_REAL_HOME: "",
  };
  const hostRun = spawnSync(
    process.execPath,
    ["--import", "tsx", hostScript, "--profile", "web"],
    { encoding: "utf8", env, timeout: 20_000 },
  );
  assert.equal(hostRun.status, 0, hostRun.stderr || hostRun.stdout);
  const hostEvents = readEntries(realHome, "host").map(row => row.event);
  assert.equal(hostEvents.includes("host.plugin-loaded"), true);
  assert.equal(hostEvents.includes("host.log"), true);
  assert.equal(hostEvents.includes("supervisor.discovery"), true);

  const supervisorRun = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      supervisorEntry,
      "--home",
      realHome,
      "--bin",
      fakeBin,
      "--component-payload",
      join(fakeUser, "missing-payload"),
      "--allow-real-home",
    ],
    { encoding: "utf8", env, timeout: 20_000 },
  );
  assert.notEqual(supervisorRun.status, 0);
  assert.doesNotMatch(supervisorRun.stderr, /refusing to use the real DSH home/);
  const supervisorEvents = readEntries(realHome, "supervisor").map(row => row.event);
  assert.equal(supervisorEvents.includes("supervisor.starting"), true, supervisorRun.stderr);
  assert.equal(supervisorEvents.includes("supervisor.launch-failed"), true, supervisorRun.stderr);
});

test("two logger instances sharing one source interleave on disk without creating archives", () => {
  const dir = home();
  const first = createDiagnosticLogger(dir, "supervisor");
  const second = createDiagnosticLogger(dir, "supervisor");
  for (let index = 0; index < 6; index += 1) (index % 2 ? second : first).info(`event.${index}`, "x");
  assert.deepEqual(
    readdirSync(diagnosticLogDirectory(dir)).filter(name => name !== "supervisor.jsonl"),
    [],
    "alternating instances must not rotate each other's records",
  );
  assert.deepEqual(readEntries(dir).map(row => row.event), ["event.0", "event.1", "event.2", "event.3", "event.4", "event.5"]);
});

test("size rotation uses the on-disk size shared between live logger instances", () => {
  const dir = home();
  const first = createDiagnosticLogger(dir, "supervisor", { maxFileBytes: 1200, maxArchiveBytes: 100_000 });
  const second = createDiagnosticLogger(dir, "supervisor", { maxFileBytes: 1200, maxArchiveBytes: 100_000 });
  first.info("one", "x".repeat(300));
  second.info("two", "y".repeat(300));
  assert.deepEqual(readdirSync(diagnosticLogDirectory(dir)).filter(name => name !== "supervisor.jsonl"), []);
  // The first instance's own writes are far below the cap, but the on-disk
  // total it shares with the second instance is not.
  first.info("three", "z".repeat(300));
  const archives = readdirSync(diagnosticLogDirectory(dir)).filter(name => name !== "supervisor.jsonl");
  assert.equal(archives.length, 1);
  second.info("four", "w".repeat(300));
  assert.equal(readdirSync(diagnosticLogDirectory(dir)).filter(name => name !== "supervisor.jsonl").length, 1);
  assert.deepEqual(readEntries(dir).map(row => row.event), ["three", "four"]);
});

test("an eight-day-old first record rotates exactly once and the fresh file ages anew", () => {
  const dir = home();
  const file = join(diagnosticLogDirectory(dir), "supervisor.jsonl");
  mkdirSync(diagnosticLogDirectory(dir), { recursive: true });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(file, `${JSON.stringify({ version: 1, at: old, level: "info", source: "supervisor", event: "old", message: "x", pid: 1 })}\n`);
  const log = createDiagnosticLogger(dir, "supervisor");
  log.info("new", "y");
  assert.equal(readdirSync(diagnosticLogDirectory(dir)).filter(name => name !== "supervisor.jsonl").length, 1);
  assert.deepEqual(readEntries(dir).map(row => row.event), ["new"]);
  log.info("next", "z");
  assert.equal(readdirSync(diagnosticLogDirectory(dir)).filter(name => name !== "supervisor.jsonl").length, 1, "the fresh first record must not rotate again");
  assert.deepEqual(readEntries(dir).map(row => row.event), ["new", "next"]);
});

test("an unparseable first record falls back to the file mtime for age rotation", () => {
  const dir = home();
  const file = join(diagnosticLogDirectory(dir), "supervisor.jsonl");
  mkdirSync(diagnosticLogDirectory(dir), { recursive: true });
  writeFileSync(file, `not json\n${JSON.stringify({ version: 1, at: new Date().toISOString(), level: "info", source: "supervisor", event: "later", message: "x", pid: 1 })}\n`);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(file, old, old);
  createDiagnosticLogger(dir, "supervisor").info("new", "y");
  assert.deepEqual(readEntries(dir).map(row => row.event), ["new"], "mtime-older-than-7d active file must rotate");
});
