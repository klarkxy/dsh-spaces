import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMPONENT_PAYLOAD_PACKAGES,
  writeComponentPayloadManifest,
} from "../src/adapters/node/component-payload.ts";
import { readSelectedComponentPayload, stageComponentPayload } from "../src/adapters/node/component-selection.ts";
import { componentLauncherSrcPath, readHandoffReceipt } from "../src/adapters/node/component-handoff.ts";
import { HomeControlBusyError, HomeController } from "../src/adapters/node/home-controller.ts";

describe("component-handoff", { concurrency: 1 }, () => {
const temps: string[] = [];
const children: ChildProcess[] = [];
const trackedPids: number[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid) trackPid(child.pid);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }
  for (const pid of trackedPids.splice(0)) killPid(pid);
  await delay(80);
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      await delay(80);
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function killPid(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    return;
  }
  try {
    process.kill(pid);
  } catch {
    /* already gone; never touch a real Home lock */
  }
}

function trackPid(pid: number | undefined | null): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (!trackedPids.includes(pid)) trackedPids.push(pid);
}

function noteTransferred(old: Spawned): void {
  const match = /OLD_TRANSFERRED (\d+)/.exec(old.stdoutText);
  if (match) trackPid(Number(match[1]));
}

function noteOwner(home: string): void {
  try {
    const inspect = new HomeController(home).inspect();
    if ("owner" in inspect) trackPid(inspect.owner.pid);
  } catch {
    /* ignore */
  }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeRel(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function dummyPayloadLib(): string {
  const root = tempDir("dsh-ho-payload-");
  const handoffHref = href("../src/adapters/node/component-handoff.ts");
  const homeControllerHref = href("../src/adapters/node/home-controller.ts");
  const supervisor = `import { appendFileSync } from "node:fs";
import { acceptHandoffFromIpc, beginAcceptHandoffChild } from ${JSON.stringify(handoffHref)};
import { HomeController } from ${JSON.stringify(homeControllerHref)};
function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : "";
}
const stamp = arg("--stamp");
const home = arg("--home");
const mode = arg("--mode") || "success";
appendFileSync(stamp, "START\\n");
for (const key of Object.keys(process.env)) {
  if (/handoff[-_]?token|handoff[-_]?secret/i.test(key)) appendFileSync(stamp, "ENV_LEAK\\n");
}
try {
  if (mode === "fail") process.exit(1);
  if (mode === "crash") {
    const session = beginAcceptHandoffChild();
    const token = await session.token;
    const handle = await new HomeController(home).acceptHandoff({ token, kind: "web" });
    appendFileSync(stamp, "ACCEPTED " + handle.owner.pid + "\\n");
    process.exit(1);
  }
  const handle = await acceptHandoffFromIpc({
    home,
    kind: "web",
    async startup(accepted) {
      appendFileSync(stamp, "ACCEPTED " + accepted.owner.pid + "\\n");
    },
  });
  appendFileSync(stamp, "READY " + handle.owner.pid + "\\n");
  await new Promise(() => undefined);
} catch (error) {
  appendFileSync(stamp, "ERROR " + (error instanceof Error ? error.message : String(error)) + "\\n");
  process.exit(1);
}
`;
  const files: Array<[string, string]> = [
    ["package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["manager-plugin"], version: "1.0.0", type: "module" })}\n`],
    ["cordis.patch.yml", "plugin: dummy\n"],
    ["LICENSE", "x\n"],
    ["lib/index.js", "export const plugin = 1;\n"],
    ["lib/typert.host.js", "export const host = 1;\n"],
    ["lib/typert.remote-client.js", "export const remote = 1;\n"],
    ["lib/client.js", "export const client = 1;\n"],
    ["lib/supervisor/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES.supervisor, version: "2.0.0", type: "module" })}\n`],
    ["lib/supervisor/index.js", supervisor],
    ["lib/supervisor/launcher.mjs", "export const launcher = 1;\n"],
    ["lib/supervisor/LICENSE", "x\n"],
    ["lib/supervisor/snapshot-worker.mjs", "export const worker = 1;\n"],
    ["lib/view-bridge/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["view-bridge"], version: "3.0.0" })}\n`],
    ["lib/view-bridge/cordis.patch.yml", "view: dummy\n"],
    ["lib/view-bridge/LICENSE", "x\n"],
    ["lib/view-bridge/lib/index.js", "export const view = 1;\n"],
    ["lib/view-bridge/lib/client.js", "export const viewClient = 1;\n"],
    ["lib/llm-bridge/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["llm-bridge"], version: "4.0.0" })}\n`],
    ["lib/llm-bridge/cordis.patch.yml", "llm: dummy\n"],
    ["lib/llm-bridge/LICENSE", "x\n"],
    ["lib/llm-bridge/lib/index.js", "export const llm = 1;\n"],
  ];
  for (const [rel, content] of files) writeRel(root, rel, content);
  return writeComponentPayloadManifest(join(root, "lib")).payloadRootLib;
}

function href(rel: string): string {
  return pathToFileURL(fileURLToPath(new URL(rel, import.meta.url))).href;
}

type Spawned = ChildProcess & { stdoutText: string; stderrText: string };

function spawnNode(script: string, args: string[]): Spawned {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env },
    shell: false,
  }) as Spawned;
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout?.on("data", (chunk) => {
    child.stdoutText += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    child.stderrText += String(chunk);
  });
  children.push(child);
  if (child.pid) trackPid(child.pid);
  return child;
}

function waitExit(child: ChildProcess & { stdoutText?: string; stderrText?: string }): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const stdoutOf = () => child.stdoutText ?? "";
  const stderrOf = () => child.stderrText ?? "";
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, stdout: stdoutOf(), stderr: stderrOf() });
  }
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(
      () => rejectWait(new Error(`child timed out stdout=${stdoutOf()} stderr=${stderrOf()}`)),
      25_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveWait({ code, stdout: stdoutOf(), stderr: stderrOf() });
    });
  });
}

async function waitUntil(label: string, fn: () => boolean, timeoutMs = 20_000, extra?: () => string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await delay(40);
  }
  let detail = "";
  try {
    detail = extra ? extra() : "";
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  throw new Error(`timed out waiting for ${label}${detail ? ` ${detail}` : ""}`);
}

function writeOldScript(home: string): string {
  const script = join(home, "old-owner.mts");
  writeFileSync(
    script,
    `import { readFileSync } from "node:fs";
import { HomeController } from ${JSON.stringify(href("../src/adapters/node/home-controller.ts"))};
import {
  createComponentHandoffBinding,
  spawnComponentLauncher,
} from ${JSON.stringify(href("../src/adapters/node/component-handoff.ts"))};
const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const controller = new HomeController(cfg.home);
const handle = controller.acquire("web");
const launcher = spawnComponentLauncher({
  home: cfg.home,
  launcherEntry: cfg.launcherEntry,
  execPath: process.execPath,
  execArgv: ["--import", "tsx"],
  cwd: cfg.cwd,
});
const token = await controller.transferToLauncher({
  nonce: handle.owner.nonce,
  binding: createComponentHandoffBinding(cfg.home, handle.owner.nonce, cfg.digest),
  launcher: { pid: launcher.pid, startedAt: launcher.startedAt },
});
const sent = cfg.mutateToken ? { ...token, secret: "00".repeat(32) } : token;
const execArgv = ["--import", "tsx"];
if (cfg.nonceArgv) execArgv.push(token.nonce);
const argv = ["--home", cfg.home, "--stamp", cfg.stamp, "--mode", cfg.mode ?? "success"];
const env = cfg.secretEnv ? { ...process.env, REVIEW_CARRIER: token.secret } : undefined;
await launcher.sendCommit({
  token: sent,
  home: cfg.home,
  toolsRoot: cfg.toolsRoot,
  artifactDigest: cfg.digest,
  oldPid: Number.isInteger(cfg.oldPid) && cfg.oldPid > 0 ? cfg.oldPid : process.pid,
  oldStartedAt: handle.owner.startedAt,
  cleanStopConfirmed: cfg.cleanStopConfirmed,
  deadlineMs: cfg.deadlineMs,
  runtime: {
    execPath: process.execPath,
    execArgv,
    entry: cfg.targetEntry,
    argv,
    cwd: cfg.cwd,
    ...(env ? { env } : {}),
  },
});
launcher.disconnect();
process.stdout.write("OLD_TRANSFERRED " + launcher.pid + "\\n");
if (cfg.stayAlive) {
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", resolve);
  });
}
process.stdout.write("OLD_EXIT\\n");
process.exit(0);
`,
  );
  return script;
}

function writeOrphanWait(home: string): string {
  const script = join(home, "orphan-wait.mts");
  writeFileSync(
    script,
    `import { beginAcceptHandoffChild } from ${JSON.stringify(href("../src/adapters/node/component-handoff.ts"))};
const session = beginAcceptHandoffChild({ deadlineMs: 400 });
try {
  await session.token;
  process.exit(0);
} catch {
  process.exit(4);
}
`,
  );
  return script;
}

function writeRacer(home: string): string {
  const script = join(home, "racer.mts");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
import { HomeController, HomeControlBusyError } from ${JSON.stringify(href("../src/adapters/node/home-controller.ts"))};
const home = process.argv[2];
const out = process.argv[3];
process.stdout.write("RACER_READY\\n");
const timer = setInterval(() => {
  try {
    new HomeController(home).acquire("desktop");
    appendFileSync(out, "WON\\n");
    process.exit(2);
  } catch (error) {
    if (!(error instanceof HomeControlBusyError)) {
      appendFileSync(out, "ERROR\\n");
      process.exit(3);
    }
  }
}, 30);
await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.once("data", resolve);
});
clearInterval(timer);
appendFileSync(out, "BUSY\\n");
process.exit(0);
`,
  );
  return script;
}

async function setup(): Promise<{
  home: string;
  tools: string;
  digest: string;
  stamp: string;
  supervisorEntry: string;
  oldScript: string;
  orphanScript: string;
  racerScript: string;
  racerOut: string;
}> {
  const home = tempDir("dsh-ho-home-");
  const tools = tempDir("dsh-ho-tools-");
  const lib = dummyPayloadLib();
  const staged = stageComponentPayload(home, tools, lib);
  const stamp = join(home, "stamp.txt");
  writeFileSync(stamp, "");
  const racerOut = join(home, "racer.txt");
  writeFileSync(racerOut, "");
  return {
    home,
    tools,
    digest: staged.digest,
    stamp,
    supervisorEntry: join(staged.packageRoot, "lib/supervisor/index.js"),
    oldScript: writeOldScript(home),
    orphanScript: writeOrphanWait(home),
    racerScript: writeRacer(home),
    racerOut,
  };
}

function oldConfig(
  ctx: Awaited<ReturnType<typeof setup>>,
  extra: Record<string, unknown>,
): string {
  const file = join(ctx.home, `old-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({
      home: ctx.home,
      toolsRoot: ctx.tools,
      digest: ctx.digest,
      launcherEntry: componentLauncherSrcPath(),
      targetEntry: ctx.supervisorEntry,
      stamp: ctx.stamp,
      cwd: repoRoot,
      cleanStopConfirmed: true,
      stayAlive: false,
      mutateToken: false,
      secretEnv: false,
      nonceArgv: false,
      mode: "success",
      deadlineMs: 8_000,
      ...extra,
    })}\n`,
  );
  return file;
}

test("old exit hands off over IPC once; competitor never acquires; secrets stay off argv/env", async () => {
  const ctx = await setup();
  const old = spawnNode(ctx.oldScript, [oldConfig(ctx, {})]);
  await waitUntil("old transferred", () => old.stdoutText.includes("OLD_TRANSFERRED"), 15_000);
  noteTransferred(old);
  const racer = spawnNode(ctx.racerScript, [ctx.home, ctx.racerOut]);
  const oldExit = await waitExit(old);
  assert.equal(oldExit.code, 0, oldExit.stderr);
  assert.match(oldExit.stdout, /OLD_EXIT/);
  await waitUntil(
    "accepted",
    () => {
      try {
        return (
          readHandoffReceipt(ctx.home)?.status === "succeeded" &&
          existsSync(ctx.stamp) &&
          readFileSync(ctx.stamp, "utf8").includes("ACCEPTED")
        );
      } catch {
        return false;
      }
    },
    15_000,
    () =>
      `receipt=${JSON.stringify(readHandoffReceipt(ctx.home))} stamp=${existsSync(ctx.stamp) ? readFileSync(ctx.stamp, "utf8") : ""} stdout=${old.stdoutText} stderr=${old.stderrText}`,
  );
  noteOwner(ctx.home);
  const receipt = readHandoffReceipt(ctx.home);
  assert.ok(receipt);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.phase, "accepted");
  assert.equal(receipt.artifactDigest, ctx.digest);
  assert.equal(readSelectedComponentPayload(ctx.home, ctx.tools)?.digest, ctx.digest);
  const stamp = readFileSync(ctx.stamp, "utf8");
  assert.match(stamp, /^START$/m);
  assert.equal(stamp.match(/^START$/gm)?.length, 1);
  assert.equal(stamp.includes("SECRET_LEAK"), false);
  assert.equal(stamp.includes("ENV_LEAK"), false);
  const inspect = new HomeController(ctx.home).inspect();
  assert.equal(inspect.held, true);
  assert.ok("owner" in inspect);
  assert.equal(inspect.owner.kind, "web");
  assert.equal("handoff" in inspect && inspect.handoff ? true : false, false);
  assert.throws(() => new HomeController(ctx.home).acquire("desktop"), HomeControlBusyError);
  racer.stdin?.write("stop\n");
  const racerExit = await waitExit(racer);
  assert.equal(racerExit.code, 0);
  assert.equal(readFileSync(ctx.racerOut, "utf8").includes("WON"), false);
});

test("old process still alive does not switch the pointer", async () => {
  const ctx = await setup();
  const old = spawnNode(ctx.oldScript, [oldConfig(ctx, { stayAlive: true, deadlineMs: 800 })]);
  await waitUntil("transferred", () => old.stdoutText.includes("OLD_TRANSFERRED"), 15_000);
  noteTransferred(old);
  await waitUntil(
    "old-alive receipt",
    () => {
      try {
        const receipt = readHandoffReceipt(ctx.home);
        return receipt?.status === "failed" && receipt.code === "old-alive";
      } catch {
        return false;
      }
    },
    15_000,
  );
  assert.equal(readSelectedComponentPayload(ctx.home, ctx.tools), undefined);
  assert.equal(new HomeController(ctx.home).inspect().held, true);
  old.stdin?.write("done\n");
  await waitExit(old);
});

test("commit oldPid must match reservation original before wait/select", async () => {
  const ctx = await setup();
  const old = spawnNode(ctx.oldScript, [oldConfig(ctx, { stayAlive: true, oldPid: 2147483647, deadlineMs: 800 })]);
  await waitUntil("transferred", () => old.stdoutText.includes("OLD_TRANSFERRED"), 15_000);
  noteTransferred(old);
  await waitUntil(
    "fake-oldpid receipt",
    () => {
      try {
        return readHandoffReceipt(ctx.home)?.code === "invalid-commit";
      } catch {
        return false;
      }
    },
    15_000,
  );
  assert.equal(readSelectedComponentPayload(ctx.home, ctx.tools), undefined);
  const inspect = new HomeController(ctx.home).inspect();
  assert.equal(inspect.held, true);
  assert.ok("handoff" in inspect && inspect.handoff);
  assert.equal(inspect.handoff.original.pid, old.pid);
  assert.notEqual(inspect.handoff.original.pid, 2147483647);
  old.stdin?.write("done\n");
  await waitExit(old);
});

test("missing clean-stop confirmation leaves the old pointer", async () => {
  const ctx = await setup();
  const old = spawnNode(ctx.oldScript, [oldConfig(ctx, { cleanStopConfirmed: false })]);
  await waitUntil("transferred", () => old.stdoutText.includes("OLD_TRANSFERRED"), 15_000).catch(() => undefined);
  noteTransferred(old);
  const oldExit = await waitExit(old);
  assert.equal(oldExit.code, 0, oldExit.stderr);
  await waitUntil("missing-confirmation", () => readHandoffReceipt(ctx.home)?.code === "missing-confirmation");
  assert.equal(readSelectedComponentPayload(ctx.home, ctx.tools), undefined);
  assert.equal(new HomeController(ctx.home).inspect().held, true);
});

test("token mismatch leaves the old pointer", async () => {
  const ctx = await setup();
  const old = spawnNode(ctx.oldScript, [oldConfig(ctx, { mutateToken: true })]);
  await waitUntil("transferred", () => old.stdoutText.includes("OLD_TRANSFERRED"), 15_000).catch(() => undefined);
  noteTransferred(old);
  const oldExit = await waitExit(old);
  assert.equal(oldExit.code, 0, oldExit.stderr);
  await waitUntil("token-mismatch", () => readHandoffReceipt(ctx.home)?.code === "token-mismatch");
  assert.equal(readSelectedComponentPayload(ctx.home, ctx.tools), undefined);
  assert.equal(new HomeController(ctx.home).inspect().held, true);
});

test("runtime entry must match the staged supervisor entry before select", async () => {
  const ctx = await setup();
  const impostor = join(ctx.home, "impostor.mts");
  writeFileSync(impostor, "process.exit(0);\n");
  const old = spawnNode(ctx.oldScript, [oldConfig(ctx, { targetEntry: impostor })]);
  const oldExit = await waitExit(old);
  assert.equal(oldExit.code, 0, oldExit.stderr);
  noteTransferred(old);
  await waitUntil("entry-mismatch", () => readHandoffReceipt(ctx.home)?.code === "invalid-commit", 15_000);
  assert.equal(readSelectedComponentPayload(ctx.home, ctx.tools), undefined);
  assert.equal(new HomeController(ctx.home).inspect().held, true);
  assert.equal(readFileSync(ctx.stamp, "utf8").includes("START"), false);
});

test("effective env values cannot carry the handoff secret", async () => {
  const ctx = await setup();
  const old = spawnNode(ctx.oldScript, [oldConfig(ctx, { secretEnv: true })]);
  const oldExit = await waitExit(old);
  assert.equal(oldExit.code, 0, oldExit.stderr);
  noteTransferred(old);
  await waitUntil("secret-env", () => readHandoffReceipt(ctx.home)?.code === "invalid-commit", 15_000);
  assert.equal(readSelectedComponentPayload(ctx.home, ctx.tools), undefined);
  assert.equal(readFileSync(ctx.stamp, "utf8").includes("START"), false);
});

test("execArgv cannot carry the handoff nonce", async () => {
  const ctx = await setup();
  const old = spawnNode(ctx.oldScript, [oldConfig(ctx, { nonceArgv: true })]);
  const oldExit = await waitExit(old);
  assert.equal(oldExit.code, 0, oldExit.stderr);
  noteTransferred(old);
  await waitUntil("nonce-argv", () => readHandoffReceipt(ctx.home)?.code === "invalid-commit", 15_000);
  assert.equal(readSelectedComponentPayload(ctx.home, ctx.tools), undefined);
  assert.equal(readFileSync(ctx.stamp, "utf8").includes("START"), false);
});

test("failed target start keeps the selected pointer and run evidence", async () => {
  const ctx = await setup();
  const old = spawnNode(ctx.oldScript, [oldConfig(ctx, { mode: "fail" })]);
  const oldExit = await waitExit(old);
  assert.equal(oldExit.code, 0, oldExit.stderr);
  noteTransferred(old);
  await waitUntil("spawn-failed", () => readHandoffReceipt(ctx.home)?.code === "spawn-failed", 15_000);
  noteOwner(ctx.home);
  assert.equal(readSelectedComponentPayload(ctx.home, ctx.tools)?.digest, ctx.digest);
  const inspect = new HomeController(ctx.home).inspect();
  assert.equal(inspect.held, true);
  assert.ok("handoff" in inspect && inspect.handoff);
  assert.equal(readFileSync(ctx.stamp, "utf8").includes("ACCEPTED"), false);
});

test("accept without startup report keeps the selected pointer and run owner", async () => {
  const ctx = await setup();
  const old = spawnNode(ctx.oldScript, [oldConfig(ctx, { mode: "crash" })]);
  const oldExit = await waitExit(old);
  assert.equal(oldExit.code, 0, oldExit.stderr);
  noteTransferred(old);
  await waitUntil(
    "accepted stamp",
    () => existsSync(ctx.stamp) && readFileSync(ctx.stamp, "utf8").includes("ACCEPTED"),
    15_000,
    () =>
      `receipt=${JSON.stringify(readHandoffReceipt(ctx.home))} stamp=${existsSync(ctx.stamp) ? readFileSync(ctx.stamp, "utf8") : ""} stdout=${old.stdoutText}`,
  );
  noteOwner(ctx.home);
  await waitUntil("startup-failed", () => readHandoffReceipt(ctx.home)?.code === "accept-failed", 15_000);
  const receipt = readHandoffReceipt(ctx.home);
  assert.equal(receipt?.status, "failed");
  assert.notEqual(receipt?.status, "succeeded");
  const inspect = new HomeController(ctx.home).inspect();
  assert.equal(inspect.held, true);
  assert.ok("owner" in inspect);
  assert.equal(inspect.owner.kind, "web");
  assert.throws(() => new HomeController(ctx.home).acquire("desktop"), HomeControlBusyError);
  assert.equal(readSelectedComponentPayload(ctx.home, ctx.tools)?.digest, ctx.digest);
});

test("missing launcher token fails the child instead of leaving an unbounded wait", async () => {
  const ctx = await setup();
  const child = spawn(process.execPath, ["--import", "tsx", ctx.orphanScript], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    env: { ...process.env },
    shell: false,
  });
  children.push(child);
  if (child.pid) trackPid(child.pid);
  const result = await waitExit(child);
  assert.equal(result.code, 4);
});
});
