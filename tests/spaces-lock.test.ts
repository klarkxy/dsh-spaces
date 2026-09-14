import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDesktopHomeControl } from "../src/adapters/desktop/index.ts";
import {
  HOME_LOCK_DIR_NAME,
  HOME_LOCK_OWNER_FILE,
  HOME_RECLAIM_DIR_NAME,
  HomeLockBusyError,
  HomeLockReleaseError,
  HomeOperationLock,
  canonicalHome,
  type HomeLockOwner,
  type UnlockDeadResult,
} from "../src/adapters/node/home-operation-lock.ts";
import { MaintenanceGate } from "../src/core/application/maintenance-gate.ts";
import { realDshHome } from "../src/main/home-guard.ts";

const temps: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-lock-"));
  temps.push(home);
  return home;
}

function lockModuleHref(): string {
  return pathToFileURL(
    fileURLToPath(new URL("../src/adapters/node/home-operation-lock.ts", import.meta.url)),
  ).href;
}

function spawnHolder(home: string): { child: ChildProcess; waitFor: (text: string) => Promise<void> } {
  const script = join(home, "hold-lock.mts");
  writeFileSync(
    script,
    `import { HomeOperationLock } from ${JSON.stringify(lockModuleHref())};
const lock = new HomeOperationLock(process.argv[2]);
await lock.run("child-hold", async () => {
  process.stdout.write("HELD\\n");
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", resolve);
  });
});
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
  const waiters: Array<{ text: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
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

test("canonical homes share a lock directory outside snapshot-replaced entries", () => {
  const home = tempHome();
  mkdirSync(join(home, "hub"), { recursive: true });
  mkdirSync(join(home, "profiles"), { recursive: true });
  const a = new HomeOperationLock(home);
  const b = new HomeOperationLock(join(home, ".", "profiles", ".."));
  assert.equal(a.home, b.home);
  assert.equal(a.lockDir, b.lockDir);
  assert.equal(a.lockDir, join(a.home, HOME_LOCK_DIR_NAME));
  assert.equal(a.reclaimDir, join(a.home, HOME_RECLAIM_DIR_NAME));
  assert.equal(a.lockDir.startsWith(join(home, "hub")), false);
  assert.equal(a.lockDir.startsWith(join(home, "profiles")), false);
  assert.equal(a.reclaimDir.startsWith(join(home, "hub")), false);
});

test("canonicalHome refuses a sandbox symlink that realpaths into the production home", (t) => {
  const realHome = realDshHome();
  if (!existsSync(realHome)) {
    t.skip("production DSH home is not present");
    return;
  }
  const home = tempHome();
  const alias = join(home, "alias-to-real");
  try {
    symlinkSync(realHome, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${String(error)}`);
    return;
  }
  assert.throws(() => canonicalHome(alias), /refusing to use the real DSH home/);
});

test("run writes pid+nonce+timestamp owner and releases only that nonce", async () => {
  const lock = new HomeOperationLock(tempHome());
  await lock.run("create-profile", async () => {
    const info = lock.inspect();
    assert.equal(info.held, true);
    assert.ok("owner" in info);
    assert.equal(info.owner.pid, process.pid);
    assert.equal(info.owner.label, "create-profile");
    assert.match(info.owner.nonce, /^[0-9a-f]{32}$/);
    assert.ok(Date.parse(info.owner.startedAt));
    return "ok";
  });
  assert.equal(lock.inspect().held, false);
});

test("nested run is reentrant while the same instance still owns the lock", async () => {
  const lock = new HomeOperationLock(tempHome());
  const result = await lock.run("outer", async () => {
    return lock.run("inner", async () => {
      const info = lock.inspect();
      assert.ok("owner" in info && info.held);
      assert.equal(info.owner.label, "outer");
      return "nested";
    });
  });
  assert.equal(result, "nested");
  assert.equal(lock.inspect().held, false);
});

test("same-instance concurrent runs serialize instead of sharing ownership", async () => {
  const lock = new HomeOperationLock(tempHome());
  const order: string[] = [];
  const first = lock.run("first", async () => {
    order.push("a0");
    await delay(40);
    order.push("a1");
    return 1;
  });
  const second = lock.run("second", async () => {
    order.push("b");
    return 2;
  });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["a0", "a1", "b"]);
});

test("independent instances of the same canonical home contend", async () => {
  const home = tempHome();
  const a = new HomeOperationLock(home);
  const b = new HomeOperationLock(home);
  let release!: () => void;
  let acquired = false;
  const held = a.run("desktop", async () => {
    acquired = true;
    await new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    return "held";
  });
  while (!acquired) await delay(5);
  await assert.rejects(b.run("host", async () => "no"), (error: unknown) => {
    assert.ok(error instanceof HomeLockBusyError);
    assert.match(error.message, /held by pid/);
    return true;
  });
  release();
  assert.equal(await held, "held");
});

test("failed run releases so a later operation can start", async () => {
  const lock = new HomeOperationLock(tempHome());
  await assert.rejects(
    lock.run("boom", async () => {
      throw new Error("write failed");
    }),
    /write failed/,
  );
  assert.equal(lock.inspect().held, false);
  assert.equal(await lock.run("retry", async () => "ok"), "ok");
});

test("crash before owner write stays incomplete and unlockDead refuses to guess", async () => {
  const home = tempHome();
  const lock = new HomeOperationLock(home);
  mkdirSync(lock.lockDir);
  const info = lock.inspect();
  assert.equal(info.held, true);
  assert.ok("incomplete" in info && info.incomplete);
  assert.deepEqual(lock.unlockDead(), { unlocked: false, reason: "incomplete" });
  await assert.rejects(lock.run("create", async () => "no"), /incomplete/);
  assert.equal(lock.inspect().held, true);
});

test("unlockDead recovers only a provably dead owner", async () => {
  const home = tempHome();
  const lock = new HomeOperationLock(home);
  mkdirSync(lock.lockDir);
  const owner: HomeLockOwner = {
    pid: 2_147_483_647,
    nonce: "deaddeaddeaddeaddeaddeaddeaddead",
    startedAt: new Date().toISOString(),
    label: "crashed-host",
  };
  writeFileSync(join(lock.lockDir, HOME_LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`);
  const recovered = lock.unlockDead();
  assert.equal(recovered.unlocked, true);
  if (recovered.unlocked) assert.equal(recovered.owner.pid, owner.pid);
  assert.equal(lock.inspect().held, false);
  assert.equal(await lock.run("after-stale", async () => "ok"), "ok");
});

test("unlockDead does not treat a live owner as dead and does not kill it", async () => {
  const home = tempHome();
  const holder = spawnHolder(home);
  await holder.waitFor("HELD");
  const lock = new HomeOperationLock(home);
  const info = lock.inspect();
  assert.ok("owner" in info && info.held);
  const childPid = info.owner.pid;
  assert.notEqual(childPid, process.pid);
  assert.deepEqual(lock.unlockDead(), { unlocked: false, reason: "owner-alive", pid: childPid });
  process.kill(childPid, 0);
  await assert.rejects(lock.run("desktop", async () => "no"), HomeLockBusyError);
  holder.child.stdin?.write("release\n");
  await holder.waitFor("RELEASED");
  assert.equal(lock.inspect().held, false);
});

test("real child process contention fails closed until the holder releases", async () => {
  const home = tempHome();
  const holder = spawnHolder(home);
  await holder.waitFor("HELD");
  const parent = new HomeOperationLock(home);
  await assert.rejects(parent.run("parent", async () => "no"), /held by pid/);
  holder.child.stdin?.write("release\n");
  await holder.waitFor("RELEASED");
  assert.equal(await parent.run("parent", async () => "ok"), "ok");
});

test("async child after release cannot inherit ownership past a new holder", async () => {
  const home = tempHome();
  const lock = new HomeOperationLock(home);
  let late!: Promise<string>;
  await lock.run("parent", async () => {
    late = delay(40).then(() => lock.run("inherited", async () => "stolen"));
  });
  assert.equal(lock.inspect().held, false);
  const other = new HomeOperationLock(home);
  const hold = other.run("other", async () => {
    await delay(80);
    return "held";
  });
  await assert.rejects(late, HomeLockBusyError);
  assert.equal(await hold, "held");
});

test("desktop adapter uses MaintenanceGate(lock) so mutate and startup-recovery hold the home lock", async () => {
  const home = tempHome();
  const desktop = createDesktopHomeControl(home);
  assert.ok(desktop.maintenance instanceof MaintenanceGate);
  assert.equal(desktop.maintenance.busy, false);

  let releaseMutate!: () => void;
  let mutateInside = false;
  const mutating = desktop.mutate(async () => {
    mutateInside = true;
    assert.equal(desktop.maintenance.mutations, 1);
    assert.equal(desktop.maintenance.busy, false);
    const info = desktop.lock.inspect();
    assert.ok("owner" in info && info.held);
    assert.equal(info.owner.label, "mutation");
    await new Promise<void>((resolveHold) => {
      releaseMutate = resolveHold;
    });
    return "mut";
  });
  assert.equal(desktop.maintenance.mutations, 1);
  while (!mutateInside) await delay(5);
  await assert.rejects(new HomeOperationLock(home).run("host-create", async () => "no"), HomeLockBusyError);
  await assert.rejects(createDesktopHomeControl(home).runMaintenance("startup-recovery", async () => "no"), /already running|held by pid|busy/);
  releaseMutate();
  assert.equal(await mutating, "mut");
  assert.equal(desktop.maintenance.mutations, 0);
  assert.equal(desktop.lock.inspect().held, false);

  let recoveryInside = false;
  const recovery = desktop.runMaintenance("startup-recovery", async () => {
    recoveryInside = true;
    assert.equal(desktop.maintenance.busy, true);
    assert.equal(desktop.maintenance.current, "startup-recovery");
    const info = desktop.lock.inspect();
    assert.ok("owner" in info && info.held);
    assert.equal(info.owner.label, "startup-recovery");
    await delay(30);
    return "recovered";
  });
  assert.equal(desktop.maintenance.current, "startup-recovery");
  while (!recoveryInside) await delay(5);
  await assert.rejects(createDesktopHomeControl(home).mutate(async () => "no"), (error: unknown) => {
    assert.match(String(error), /while maintenance is running|held by pid|busy/);
    return true;
  });
  assert.equal(await recovery, "recovered");
  assert.equal(desktop.maintenance.busy, false);
  assert.equal(desktop.lock.inspect().held, false);
});

test("failed desktop mutate releases both the gate and the home lock", async () => {
  const desktop = createDesktopHomeControl(tempHome());
  await assert.rejects(
    desktop.mutate(async () => {
      throw new Error("desktop write failed");
    }),
    /desktop write failed/,
  );
  assert.equal(desktop.maintenance.mutations, 0);
  assert.equal(desktop.lock.inspect().held, false);
  assert.equal(await desktop.mutate(async () => "ok"), "ok");
});

test("reclaim guard blocks acquire and unlockDead cannot steal an incomplete lock", async () => {
  const home = tempHome();
  const lock = new HomeOperationLock(home);
  mkdirSync(lock.lockDir);
  const owner: HomeLockOwner = {
    pid: 2_147_483_647,
    nonce: "deaddeaddeaddeaddeaddeaddeaddead",
    startedAt: new Date().toISOString(),
    label: "crashed-host",
  };
  writeFileSync(join(lock.lockDir, HOME_LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`);
  mkdirSync(lock.reclaimDir);

  const blocked = lock.inspect();
  assert.equal(blocked.held, true);
  assert.ok("reclaim" in blocked && blocked.reclaim);
  assert.deepEqual(lock.unlockDead(), { unlocked: false, reason: "reclaim-in-progress" });
  await assert.rejects(lock.run("create", async () => "no"), /reclaim/);
  assert.equal(existsSync(join(lock.lockDir, HOME_LOCK_OWNER_FILE)), true);

  rmSync(lock.reclaimDir, { recursive: true, force: true });
  const recovered = lock.unlockDead();
  assert.equal(recovered.unlocked, true);
});

test("unlockDead reports remove-failed and leaves ownership blocked when the lock dir cannot be removed", async () => {
  const home = tempHome();
  const lock = new HomeOperationLock(home);
  mkdirSync(lock.lockDir);
  writeFileSync(
    join(lock.lockDir, HOME_LOCK_OWNER_FILE),
    `${JSON.stringify({
      pid: 2_147_483_647,
      nonce: "deaddeaddeaddeaddeaddeaddeaddead",
      startedAt: new Date().toISOString(),
      label: "crashed-host",
    } satisfies HomeLockOwner)}\n`,
  );
  writeFileSync(join(lock.lockDir, "extra"), "still here\n");
  const result = lock.unlockDead();
  assert.equal(result.unlocked, false);
  assert.equal(result.reason, "remove-failed");
  assert.equal(lock.inspect().held, true);
  await assert.rejects(lock.run("after-failed-reclaim", async () => "no"), HomeLockBusyError);
});

test("release surfaces failure and leaves blocked ownership visible", async () => {
  const home = tempHome();
  const lock = new HomeOperationLock(home);
  await assert.rejects(
    lock.run("stuck", async () => {
      writeFileSync(join(lock.lockDir, "extra"), "blocked\n");
      return "ok";
    }),
    (error: unknown) => {
      assert.ok(error instanceof HomeLockReleaseError);
      return true;
    },
  );
  const info = lock.inspect();
  assert.equal(info.held, true);
  assert.ok("incomplete" in info && info.incomplete);
  await assert.rejects(new HomeOperationLock(home).run("next", async () => "no"), /incomplete/);
});

test("release nonce mismatch leaves the foreign owner in place", async () => {
  const home = tempHome();
  const lock = new HomeOperationLock(home);
  await assert.rejects(
    lock.run("mine", async () => {
      const foreign: HomeLockOwner = {
        pid: process.pid,
        nonce: "aa".repeat(16),
        startedAt: new Date().toISOString(),
        label: "foreign",
      };
      writeFileSync(join(lock.lockDir, HOME_LOCK_OWNER_FILE), `${JSON.stringify(foreign)}\n`);
      return "done";
    }),
    HomeLockReleaseError,
  );
  const info = lock.inspect();
  assert.ok("owner" in info && info.held);
  assert.equal(info.owner.label, "foreign");
  assert.equal(info.owner.nonce, "aa".repeat(16));
});

test("concurrent child unlockDead uses the reclaim guard so only one reclaim succeeds", async () => {
  const home = tempHome();
  const lock = new HomeOperationLock(home);
  mkdirSync(lock.lockDir);
  writeFileSync(
    join(lock.lockDir, HOME_LOCK_OWNER_FILE),
    `${JSON.stringify({
      pid: 2_147_483_647,
      nonce: "cafecafecafecafecafecafecafecafe",
      startedAt: new Date().toISOString(),
      label: "crashed-host",
    } satisfies HomeLockOwner)}\n`,
  );
  const script = join(home, "unlock-dead.mts");
  writeFileSync(
    script,
    `import { HomeOperationLock } from ${JSON.stringify(lockModuleHref())};
const result = new HomeOperationLock(process.argv[2]).unlockDead();
process.stdout.write(JSON.stringify(result) + "\\n");
`,
  );
  const runChild = () =>
    new Promise<UnlockDeadResult>((resolveChild, rejectChild) => {
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
          rejectChild(new Error(`unlock child exited ${code}: ${stderr || stdout}`));
          return;
        }
        try {
          resolveChild(JSON.parse(stdout.trim()) as UnlockDeadResult);
        } catch (error) {
          rejectChild(new Error(`bad unlock child output ${JSON.stringify(stdout)} ${stderr} ${String(error)}`));
        }
      });
    });
  const results = await Promise.all([runChild(), runChild()]);
  assert.equal(results.filter((row) => row.unlocked).length, 1);
  assert.ok(results.some((row) => !row.unlocked && (row.reason === "reclaim-in-progress" || row.reason === "not-held")));
  assert.equal(lock.inspect().held, false);
});

test("symlink lock path is ambiguous and is not stolen", async (t) => {
  const home = tempHome();
  const target = join(home, "elsewhere");
  mkdirSync(target);
  const lock = new HomeOperationLock(home);
  try {
    symlinkSync(target, lock.lockDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${String(error)}`);
    return;
  }
  const info = lock.inspect();
  assert.equal(info.held, true);
  assert.ok("ambiguous" in info && info.ambiguous);
  assert.deepEqual(lock.unlockDead(), {
    unlocked: false,
    reason: "ambiguous",
    detail: "lock directory is a symlink",
  });
  await assert.rejects(lock.run("create", async () => "no"), /ambiguous|symlink/);
});

test("desktop blocks an interrupted plugin mutation until a successful full restore", async () => {
  const home = tempHome();
  const control = createDesktopHomeControl(home);
  const journal = join(home, ".dsh-spaces-mutation.json");
  writeFileSync(journal, '{"op":"create","spaceId":"unfinished"}');
  let ran = false;
  await assert.rejects(control.mutate(async () => { ran = true; }), /needs recovery/);
  await assert.rejects(control.runMaintenance("startup-recovery", async () => { ran = true; }), /needs recovery/);
  assert.equal(ran, false);
  await control.runMaintenance("quit", async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(existsSync(journal), true);
  await assert.rejects(control.runMaintenance("snapshot-restore", async () => { throw new Error("restore failed"); }), /restore failed/);
  assert.equal(existsSync(journal), true);
  await control.runMaintenance("snapshot-restore", async () => {});
  assert.equal(existsSync(journal), false);
  await control.mutate(async () => {});
});
