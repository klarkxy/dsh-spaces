import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_MANAGER_FILE,
  HOME_CONTROL_OWNER_FILE,
  HOME_CONTROL_RECLAIM_DIR_NAME,
  HOME_CONTROL_RUN_DIR_NAME,
  HomeControlBusyError,
  HomeControlPathError,
  HomeControlReleaseError,
  HomeController,
  parseControlEndpoint,
  type HomeControlOwner,
  type ReclaimDeadResult,
} from "../src/adapters/node/home-controller.ts";
import { HomeLockBusyError, HomeOperationLock } from "../src/adapters/node/home-operation-lock.ts";
import { MANAGED_HOME_ENTRIES } from "../src/shared/snapshots.ts";

const temps: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-control-"));
  temps.push(home);
  return home;
}

function writeProfile(home: string, name: string, pkg: unknown = {}): string {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  return dir;
}

function controlModuleHref(): string {
  return pathToFileURL(
    fileURLToPath(new URL("../src/adapters/node/home-controller.ts", import.meta.url)),
  ).href;
}

test("ROOT existing manager identity remains readable while a maintenance lock is held", async () => {
  const home = tempHome();
  const controller = new HomeController(home);
  const identity = await controller.ensureManager();
  const lock = new HomeOperationLock(home);
  await lock.run("held-maintenance", async () => {
    assert.deepEqual(await controller.ensureManager(), identity);
    assert.equal(lock.inspect().held, true);
  });
});

function spawnHolder(home: string): { child: ChildProcess; waitFor: (text: string) => Promise<void> } {
  const script = join(home, "hold-control.mts");
  writeFileSync(
    script,
    `import { HomeController } from ${JSON.stringify(controlModuleHref())};
const handle = new HomeController(process.argv[2]).acquire("desktop");
process.stdout.write("HELD\\n");
await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.once("data", resolve);
});
handle.release();
process.stdout.write("RELEASED\\n");
`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", script, home], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env },
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  const waiters: Array<{
    text: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const notify = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (stdout.includes(waiters[i].text)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  };
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
    notify();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.once("exit", (code, signal) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      if (!stdout.includes(waiter.text)) {
        waiter.reject(
          new Error(`child exited ${code}/${signal} before ${JSON.stringify(waiter.text)}; stderr=${stderr}`),
        );
      }
    }
  });
  return {
    child,
    waitFor(text: string) {
      if (stdout.includes(text)) return Promise.resolve();
      return new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          rejectWait(
            new Error(
              `timed out waiting for ${JSON.stringify(text)}; stdout=${JSON.stringify(stdout)} stderr=${stderr}`,
            ),
          );
        }, 15_000);
        waiters.push({ text, resolve: resolveWait, reject: rejectWait, timer });
      });
    },
  };
}

test("control state directory is not a snapshot-managed home entry", () => {
  assert.equal((MANAGED_HOME_ENTRIES as readonly string[]).includes(HOME_CONTROL_DIR_NAME), false);
  assert.equal((MANAGED_HOME_ENTRIES as readonly string[]).includes(".dsh-spaces-control"), false);
  const home = tempHome();
  const controller = new HomeController(home);
  assert.equal(controller.controlDir, join(controller.home, HOME_CONTROL_DIR_NAME));
  assert.equal(controller.controlDir.startsWith(join(home, "hub")), false);
  assert.equal(controller.controlDir.startsWith(join(home, "profiles")), false);
});

test("path aliases resolve to one canonical control directory", () => {
  const home = tempHome();
  mkdirSync(join(home, "hub"), { recursive: true });
  mkdirSync(join(home, "profiles"), { recursive: true });
  const a = new HomeController(home);
  const b = new HomeController(join(home, ".", "profiles", ".."));
  assert.equal(a.home, b.home);
  assert.equal(a.controlDir, b.controlDir);
  assert.equal(a.runDir, join(a.controlDir, HOME_CONTROL_RUN_DIR_NAME));
  assert.equal(a.reclaimDir, join(a.controlDir, HOME_CONTROL_RECLAIM_DIR_NAME));
});

test("ensureManager registers spaces-hub without installing a profile and is idempotent", async () => {
  const home = tempHome();
  const controller = new HomeController(home);
  const first = await controller.ensureManager();
  assert.equal(first.profileId, "spaces-hub");
  assert.equal(first.needsBootstrap, true);
  assert.equal(existsSync(join(home, "profiles", "spaces-hub")), false);
  assert.equal(controller.roleOf("spaces-hub"), "manager");
  assert.equal(controller.roleOf("coding"), "uninitialized");
  const persisted = JSON.parse(readFileSync(join(controller.controlDir, HOME_CONTROL_MANAGER_FILE), "utf8")) as {
    version: number;
    profileId: string;
  };
  assert.equal(persisted.version, 1);
  assert.equal(persisted.profileId, "spaces-hub");
  const second = await new HomeController(home).ensureManager();
  assert.deepEqual(second, first);
});

test("existing workspace named spaces-hub is not overwritten; suffix is reserved only", async () => {
  const home = tempHome();
  const marker = join(writeProfile(home, "spaces-hub", { name: "user-space" }), "keep.txt");
  writeFileSync(marker, "original\n");
  writeProfile(home, "spaces-hub-2", { name: "also-taken" });
  const identity = await new HomeController(home).ensureManager();
  assert.equal(identity.profileId, "spaces-hub-3");
  assert.equal(identity.needsBootstrap, true);
  assert.equal(readFileSync(marker, "utf8"), "original\n");
  assert.equal(existsSync(join(home, "profiles", "spaces-hub-3")), false);
  const controller = new HomeController(home);
  assert.equal(controller.roleOf("spaces-hub"), "workspace");
  assert.equal(controller.roleOf("spaces-hub-2"), "workspace");
  assert.equal(controller.roleOf("spaces-hub-3"), "manager");
});

test("package.json name or profile name does not guess manager identity", async () => {
  const home = tempHome();
  writeProfile(home, "coding", { name: "spaces-hub", dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app"] } } });
  const controller = new HomeController(home);
  assert.equal(controller.roleOf("coding"), "workspace");
  assert.equal(controller.roleOf("spaces-hub"), "uninitialized");
  const identity = await controller.ensureManager();
  assert.equal(identity.profileId, "spaces-hub");
  assert.equal(controller.roleOf("coding"), "workspace");
  assert.equal(controller.roleOf("spaces-hub"), "manager");
});

test("control dir without manager.json can finish init; valid reservation is reentrant until bootstrap", async () => {
  const home = tempHome();
  const controller = new HomeController(home);
  mkdirSync(controller.controlDir);
  const managerPath = join(controller.controlDir, HOME_CONTROL_MANAGER_FILE);
  assert.equal(existsSync(managerPath), false);
  const reserved = await controller.ensureManager();
  assert.equal(reserved.profileId, "spaces-hub");
  assert.equal(reserved.needsBootstrap, true);
  const before = readFileSync(managerPath);
  const again = await new HomeController(home).ensureManager();
  assert.deepEqual(again, reserved);
  assert.deepEqual(readFileSync(managerPath), before);
  writeProfile(home, "spaces-hub", { name: "later-workspace" });
  const afterDir = await new HomeController(home).ensureManager();
  assert.equal(afterDir.profileId, "spaces-hub");
  assert.equal(afterDir.needsBootstrap, false);
  assert.equal(controller.roleOf("spaces-hub"), "manager");
});

test("corrupt manager.json is recovery and is not rebuilt", async () => {
  const home = tempHome();
  const controller = new HomeController(home);
  await controller.ensureManager();
  const managerPath = join(controller.controlDir, HOME_CONTROL_MANAGER_FILE);
  const payloads = [
    "{broken",
    "{not-json\n",
    `${JSON.stringify({ version: 2, profileId: "spaces-hub", createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    `${JSON.stringify({ version: 1, profileId: "web", createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    `${JSON.stringify({ version: 1, profileId: "spaces-hub" })}\n`,
  ];
  for (const payload of payloads) {
    writeFileSync(managerPath, payload);
    const before = readFileSync(managerPath);
    await assert.rejects(controller.ensureManager(), HomeControlPathError);
    await assert.rejects(new HomeController(home).ensureManager(), HomeControlPathError);
    assert.deepEqual(readFileSync(managerPath), before);
    assert.throws(() => controller.roleOf("spaces-hub"), HomeControlPathError);
    assert.throws(() => controller.roleOf("coding"), HomeControlPathError);
  }
});

test("case-alias profile occupancy is not taken over as spaces-hub", async () => {
  const home = tempHome();
  const occupied = writeProfile(home, "Spaces-Hub", {});
  const marker = join(occupied, "keep.txt");
  writeFileSync(marker, "original-spaces-hub\n");
  const beforeMarker = readFileSync(marker);
  const beforePkg = readFileSync(join(occupied, "package.json"));
  const controller = new HomeController(home);
  const identity = await controller.ensureManager();
  assert.equal(identity.profileId, "spaces-hub-2");
  assert.equal(identity.needsBootstrap, true);
  assert.deepEqual(readFileSync(marker), beforeMarker);
  assert.deepEqual(readFileSync(join(occupied, "package.json")), beforePkg);
  assert.equal(existsSync(join(home, "profiles", "spaces-hub-2")), false);
  const managerPath = join(controller.controlDir, HOME_CONTROL_MANAGER_FILE);
  const beforeManager = readFileSync(managerPath);
  const again = await new HomeController(home).ensureManager();
  assert.deepEqual(again, identity);
  assert.deepEqual(readFileSync(managerPath), beforeManager);
  assert.deepEqual(readFileSync(marker), beforeMarker);
  assert.equal(controller.roleOf("spaces-hub-2"), "manager");
  assert.equal(controller.roleOf("spaces-hub"), "workspace");
  assert.equal(controller.roleOf("Spaces-Hub"), "workspace");
});

test("existing valid manager id is preferred even when spaces-hub is free", async () => {
  const home = tempHome();
  const controller = new HomeController(home);
  mkdirSync(controller.controlDir);
  writeFileSync(
    join(controller.controlDir, HOME_CONTROL_MANAGER_FILE),
    `${JSON.stringify({ version: 1, profileId: "spaces-hub-2", createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
  );
  const identity = await controller.ensureManager();
  assert.deepEqual(identity, { profileId: "spaces-hub-2", needsBootstrap: true });
  assert.equal(existsSync(join(home, "profiles", "spaces-hub")), false);
});

test("ensureManager takes the home transaction lock; acquire does not", async () => {
  const home = tempHome();
  const lock = new HomeOperationLock(home);
  const controller = new HomeController(home);
  await lock.run("hold-transaction", async () => {
    await assert.rejects(new HomeController(home).ensureManager(), HomeLockBusyError);
    const handle = controller.acquire("desktop");
    assert.equal(lock.inspect().held, true);
    handle.release();
  });
  assert.equal(lock.inspect().held, false);
  const handle = controller.acquire("web");
  assert.equal(lock.inspect().held, false);
  assert.equal(await lock.run("mutation", async () => "ok"), "ok");
  handle.release();
});

test("acquire writes pid+nonce+timestamp owner and releases only that nonce", () => {
  const controller = new HomeController(tempHome());
  const handle = controller.acquire("desktop", "http://127.0.0.1:3100");
  const info = controller.inspect();
  assert.equal(info.held, true);
  assert.ok("owner" in info);
  assert.equal(info.owner.pid, process.pid);
  assert.equal(info.owner.kind, "desktop");
  assert.equal(info.owner.endpoint, "http://127.0.0.1:3100/");
  assert.equal(info.liveness, "alive");
  assert.match(info.owner.nonce, /^[0-9a-f]{32}$/);
  assert.ok(Date.parse(info.owner.startedAt));
  handle.release();
  assert.equal(controller.inspect().held, false);
  const next = controller.acquire("web");
  assert.throws(() => handle.release(), HomeControlReleaseError);
  const after = controller.inspect();
  assert.ok("owner" in after && after.held);
  assert.equal(after.owner.kind, "web");
  assert.equal(after.owner.nonce, next.owner.nonce);
  next.release();
});

test("independent instances contend for runtime ownership without stealing", () => {
  const home = tempHome();
  const a = new HomeController(home);
  const b = new HomeController(home);
  const held = a.acquire("desktop");
  assert.throws(() => b.acquire("web"), (error: unknown) => {
    assert.ok(error instanceof HomeControlBusyError);
    assert.match(error.message, /held by pid/);
    return true;
  });
  held.release();
  const web = b.acquire("web");
  assert.equal(web.owner.kind, "web");
  web.release();
});

test("real child process acquire stays exclusive until release", async () => {
  const home = tempHome();
  const holder = spawnHolder(home);
  await holder.waitFor("HELD");
  const parent = new HomeController(home);
  assert.throws(() => parent.acquire("web"), HomeControlBusyError);
  assert.deepEqual(parent.reclaimDead(), {
    reclaimed: false,
    reason: "owner-alive",
    pid: holder.child.pid,
  });
  process.kill(holder.child.pid!, 0);
  holder.child.stdin?.write("release\n");
  await holder.waitFor("RELEASED");
  const handle = parent.acquire("web");
  handle.release();
});

test("release nonce mismatch leaves the foreign owner in place", () => {
  const home = tempHome();
  const controller = new HomeController(home);
  const handle = controller.acquire("desktop");
  const foreign: HomeControlOwner = {
    pid: process.pid,
    nonce: "aa".repeat(16),
    startedAt: new Date().toISOString(),
    kind: "web",
  };
  writeFileSync(join(controller.runDir, HOME_CONTROL_OWNER_FILE), `${JSON.stringify(foreign)}\n`);
  assert.throws(() => handle.release(), HomeControlReleaseError);
  const info = controller.inspect();
  assert.ok("owner" in info && info.held);
  assert.equal(info.owner.kind, "web");
  assert.equal(info.owner.nonce, "aa".repeat(16));
});

test("reclaimDead recovers only a provably dead owner and does not auto-preempt", () => {
  const home = tempHome();
  const controller = new HomeController(home);
  mkdirSync(controller.controlDir);
  mkdirSync(controller.runDir);
  const owner: HomeControlOwner = {
    pid: 2_147_483_647,
    nonce: "deaddeaddeaddeaddeaddeaddeaddead",
    startedAt: new Date().toISOString(),
    kind: "desktop",
  };
  writeFileSync(join(controller.runDir, HOME_CONTROL_OWNER_FILE), `${JSON.stringify(owner)}\n`);
  const info = controller.inspect();
  assert.ok("owner" in info && info.held);
  assert.equal(info.liveness, "dead");
  assert.throws(() => controller.acquire("web"), (error: unknown) => {
    assert.ok(error instanceof HomeControlBusyError);
    assert.match(error.message, /reclaim required/);
    return true;
  });
  const recovered = controller.reclaimDead();
  assert.equal(recovered.reclaimed, true);
  if (recovered.reclaimed) assert.equal(recovered.owner.pid, owner.pid);
  const handle = controller.acquire("web");
  handle.release();
});

test("live owner is not treated as dead and is not killed", () => {
  const controller = new HomeController(tempHome());
  const handle = controller.acquire("desktop");
  assert.deepEqual(controller.reclaimDead(), {
    reclaimed: false,
    reason: "owner-alive",
    pid: process.pid,
  });
  process.kill(process.pid, 0);
  const info = controller.inspect();
  assert.ok("owner" in info);
  assert.equal(info.liveness, "alive");
  handle.release();
});

test("incomplete or reclaiming owner is recovery and is not stolen", () => {
  const home = tempHome();
  const controller = new HomeController(home);
  mkdirSync(controller.controlDir);
  mkdirSync(controller.runDir);
  const incomplete = controller.inspect();
  assert.equal(incomplete.held, true);
  assert.ok("incomplete" in incomplete && incomplete.incomplete);
  assert.deepEqual(controller.reclaimDead(), { reclaimed: false, reason: "incomplete" });
  assert.throws(() => controller.acquire("desktop"), /incomplete/);
  writeFileSync(
    join(controller.runDir, HOME_CONTROL_OWNER_FILE),
    `${JSON.stringify({
      pid: 2_147_483_647,
      nonce: "deaddeaddeaddeaddeaddeaddeaddead",
      startedAt: new Date().toISOString(),
      kind: "desktop",
    } satisfies HomeControlOwner)}\n`,
  );
  mkdirSync(controller.reclaimDir);
  const blocked = controller.inspect();
  assert.ok("reclaim" in blocked && blocked.reclaim);
  assert.deepEqual(controller.reclaimDead(), { reclaimed: false, reason: "reclaim-in-progress" });
  assert.throws(() => controller.acquire("desktop"), /reclaim/);
});

test("PID reuse is ambiguous and is not reclaimed or stolen", () => {
  const home = tempHome();
  const controller = new HomeController(home, {
    pidAlive: () => "ambiguous",
  });
  mkdirSync(controller.controlDir);
  mkdirSync(controller.runDir);
  writeFileSync(
    join(controller.runDir, HOME_CONTROL_OWNER_FILE),
    `${JSON.stringify({
      pid: process.pid,
      nonce: "cafecafecafecafecafecafecafecafe",
      startedAt: new Date().toISOString(),
      kind: "desktop",
    } satisfies HomeControlOwner)}\n`,
  );
  const info = controller.inspect();
  assert.ok("owner" in info && info.held);
  assert.equal(info.liveness, "ambiguous");
  assert.deepEqual(controller.reclaimDead(), {
    reclaimed: false,
    reason: "ambiguous",
    detail: "owner pid liveness is ambiguous",
  });
  assert.throws(() => controller.acquire("web"), /ambiguous/);
});

test("stale startedAt for the current pid is treated as PID reuse", () => {
  const home = tempHome();
  const controller = new HomeController(home);
  mkdirSync(controller.controlDir);
  mkdirSync(controller.runDir);
  writeFileSync(
    join(controller.runDir, HOME_CONTROL_OWNER_FILE),
    `${JSON.stringify({
      pid: process.pid,
      nonce: "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
      startedAt: "2000-01-01T00:00:00.000Z",
      kind: "web",
    } satisfies HomeControlOwner)}\n`,
  );
  const info = controller.inspect();
  assert.ok("owner" in info);
  assert.equal(info.liveness, "ambiguous");
  assert.equal(controller.reclaimDead().reclaimed, false);
});

test("symlink run path is ambiguous and is not stolen", (t) => {
  const home = tempHome();
  const controller = new HomeController(home);
  mkdirSync(controller.controlDir);
  const target = join(home, "elsewhere");
  mkdirSync(target);
  try {
    symlinkSync(target, controller.runDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${String(error)}`);
    return;
  }
  const info = controller.inspect();
  assert.equal(info.held, true);
  assert.ok("ambiguous" in info && info.ambiguous);
  assert.deepEqual(controller.reclaimDead(), {
    reclaimed: false,
    reason: "ambiguous",
    detail: "run directory is a symlink",
  });
  assert.throws(() => controller.acquire("desktop"), /ambiguous|symlink/);
});

test("symlink control directory is rejected instead of following an alias", async (t) => {
  const home = tempHome();
  const target = join(home, "escaped");
  mkdirSync(target);
  const controlDir = join(home, HOME_CONTROL_DIR_NAME);
  try {
    symlinkSync(target, controlDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${String(error)}`);
    return;
  }
  const controller = new HomeController(home);
  const info = controller.inspect();
  assert.ok("ambiguous" in info && info.held);
  await assert.rejects(controller.ensureManager(), HomeControlPathError);
  assert.throws(() => controller.acquire("desktop"), HomeControlBusyError);
});

test("concurrent child reclaimDead uses the reclaim guard so only one succeeds", async () => {
  const home = tempHome();
  const controller = new HomeController(home);
  mkdirSync(controller.controlDir);
  mkdirSync(controller.runDir);
  writeFileSync(
    join(controller.runDir, HOME_CONTROL_OWNER_FILE),
    `${JSON.stringify({
      pid: 2_147_483_647,
      nonce: "cafecafecafecafecafecafecafecafe",
      startedAt: new Date().toISOString(),
      kind: "desktop",
    } satisfies HomeControlOwner)}\n`,
  );
  const script = join(home, "reclaim-dead.mts");
  writeFileSync(
    script,
    `import { HomeController } from ${JSON.stringify(controlModuleHref())};
const result = new HomeController(process.argv[2]).reclaimDead();
process.stdout.write(JSON.stringify(result) + "\\n");
`,
  );
  const runChild = () =>
    new Promise<ReclaimDeadResult>((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, ["--import", "tsx", script, home], {
        cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env },
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("exit", (code) => {
        if (code !== 0) {
          rejectChild(new Error(`reclaim child exited ${code}: ${stderr || stdout}`));
          return;
        }
        try {
          resolveChild(JSON.parse(stdout.trim()) as ReclaimDeadResult);
        } catch (error) {
          rejectChild(new Error(`bad reclaim child output ${JSON.stringify(stdout)} ${stderr} ${String(error)}`));
        }
      });
    });
  const results = await Promise.all([runChild(), runChild()]);
  assert.equal(results.filter((row) => row.reclaimed).length, 1);
  assert.ok(
    results.some((row) => !row.reclaimed && (row.reason === "reclaim-in-progress" || row.reason === "not-held")),
  );
  assert.equal(controller.inspect().held, false);
});

test("same-process concurrent acquire has a single owner", async () => {
  const home = tempHome();
  const attempts = Array.from({ length: 8 }, () =>
    Promise.resolve().then(() => {
      try {
        return new HomeController(home).acquire("desktop");
      } catch (error) {
        if (error instanceof HomeControlBusyError) return null;
        throw error;
      }
    }),
  );
  const handles = await Promise.all(attempts);
  const winners = handles.filter((row) => row !== null);
  assert.equal(winners.length, 1);
  winners[0]!.release();
  await delay(0);
});

test("clean 127.0.0.1 endpoints are accepted and dirty URLs are rejected", () => {
  assert.equal(parseControlEndpoint("http://127.0.0.1:3100"), "http://127.0.0.1:3100/");
  assert.equal(parseControlEndpoint("http://127.0.0.1:3100/"), "http://127.0.0.1:3100/");
  assert.throws(() => parseControlEndpoint("http://localhost:3100/"), /127\.0\.0\.1/);
  assert.throws(() => parseControlEndpoint("https://127.0.0.1:3100/"), /clean http/);
  assert.throws(() => parseControlEndpoint("http://127.0.0.1:3100/secret"), /path/);
  assert.throws(() => parseControlEndpoint("http://127.0.0.1:3100/?token=x"), /query or fragment/);
  assert.throws(() => parseControlEndpoint("http://127.0.0.1:3100/#x"), /query or fragment/);
  const controller = new HomeController(tempHome());
  assert.throws(() => controller.acquire("desktop", "http://localhost:3100/"), /127\.0\.0\.1/);
  assert.equal(controller.inspect().held, false);
});
