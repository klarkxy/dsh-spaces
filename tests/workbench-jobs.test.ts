import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  WORKBENCH_CONTROL_DIR_NAME,
  WORKBENCH_JOB_ERROR,
  WORKBENCH_JOBS_DIR_NAME,
  WorkbenchJobAbortError,
  WorkbenchJobError,
  WorkbenchJobStore,
  publicJobKeys,
  type WorkbenchJobHandler,
} from "../src/adapters/node/workbench-jobs.ts";
import type { WorkbenchCommand } from "../src/shared/workbench.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-jobs-"));
  temps.push(home);
  return home;
}

function jobsDir(home: string): string {
  return join(home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME);
}

function jobFile(home: string, id: string): string {
  return join(jobsDir(home), `${id}.json`);
}

function startCmd(spaceId = "alpha"): WorkbenchCommand {
  return { kind: "space.start", spaceId };
}

function noop(): WorkbenchJobHandler {
  return async () => undefined;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("same request id concurrent submit runs the handler once", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  const started: number[] = [];
  const gate = latch();
  const handler: WorkbenchJobHandler = async () => {
    started.push(started.length + 1);
    await gate.promise;
  };

  const [first, second] = await Promise.all([
    store.submit(startCmd(), "req-1", handler),
    store.submit({ spaceId: "alpha", kind: "space.start" }, "req-1", async () => {
      started.push(99);
    }),
  ]);

  assert.equal(first.id, "req-1");
  assert.equal(second.id, first.id);
  assert.equal(first.status, "queued");
  await waitUntil(() => store.job("req-1").status === "running", "running");
  gate.release();
  await store.whenIdle();
  assert.deepEqual(started, [1]);
  assert.equal(store.job("req-1").status, "succeeded");
});

test("uncertain maintenance keeps the interrupted job and blocks later side effects", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  await store.submit(startCmd(), "uncertain", async () => { throw new WorkbenchJobError("workbench/recovery-required"); });
  await store.whenIdle();
  assert.equal(store.job("uncertain").status, "recovery-required");
  let called = false;
  await assert.rejects(async () => store.submit(startCmd("beta"), "later", async () => { called = true; }),
    (error: unknown) => error instanceof WorkbenchJobError && error.code === "workbench/recovery-required");
  assert.equal(called, false);
});

test("same request id with a different payload is rejected", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  const gate = latch();
  const first = await store.submit(startCmd("alpha"), "req-2", async () => {
    await gate.promise;
  });
  await waitUntil(() => store.job("req-2").status === "running", "running");
  await assert.rejects(
    () => store.submit(startCmd("beta"), "req-2", noop()),
    (error: unknown) => {
      assert.ok(error instanceof WorkbenchJobError);
      assert.equal(error.code, "workbench/conflict");
      return true;
    },
  );
  gate.release();
  await store.whenIdle();
  assert.equal(first.kind, "space.start");
  assert.equal(store.job("req-2").status, "succeeded");
});

test("extra command fields are rejected instead of being ignored", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  await assert.rejects(
    () =>
      store.submit(
        { kind: "space.start", spaceId: "alpha", extra: true } as unknown as WorkbenchCommand,
        "req-extra",
        noop(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkbenchJobError);
      assert.equal(error.code, "workbench/invalid-input");
      return true;
    },
  );
  assert.deepEqual(store.list(), []);
});

test("a persist failure before enqueue does not run the handler", async () => {
  const home = tempHome();
  let ran = 0;
  const store = new WorkbenchJobStore({
    home,
    inject: (op) => {
      if (op === "write") throw new Error("EACCES D:\\secret\\jobs\\token=abc cookie=session");
    },
  });
  await assert.rejects(
    () =>
      store.submit(startCmd(), "req-3", async () => {
        ran += 1;
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkbenchJobError);
      assert.equal(error.code, "workbench/persist-failed");
      assert.equal(error.message.includes("D:"), false);
      assert.equal(error.message.includes("token=abc"), false);
      assert.equal(error.message.includes("cookie=session"), false);
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
  assert.equal(ran, 0);
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(jobFile(home, "req-3")), false);
});

test("cancelling a queued job becomes terminal without running it", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  const gate = latch();
  let ranQueued = false;
  await store.submit(startCmd("one"), "job-a", async (ctx) => {
    ctx.cancellable(true);
    await gate.promise;
  });
  const queued = await store.submit(startCmd("two"), "job-b", async () => {
    ranQueued = true;
  });
  assert.equal(queued.status, "queued");
  const cancelled = await store.cancel("job-b");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.canCancel, false);
  assert.equal(store.job("job-b").status, "cancelled");
  gate.release();
  await store.whenIdle();
  assert.equal(ranQueued, false);
  assert.equal(store.job("job-a").status, "succeeded");
  assert.equal(store.job("job-b").status, "cancelled");
});

test("an irreversible running phase rejects cancel and keeps the real result", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  const gate = latch();
  void store.submit(startCmd(), "job-irrev", async (ctx) => {
    ctx.cancellable(false);
    ctx.phase("commit");
    await gate.promise;
    return { spaceId: "alpha" };
  });
  await waitUntil(() => store.job("job-irrev").phase === "commit", "commit phase");
  await assert.rejects(
    () => store.cancel("job-irrev"),
    (error: unknown) => {
      assert.ok(error instanceof WorkbenchJobError);
      assert.equal(error.code, "workbench/not-cancellable");
      return true;
    },
  );
  assert.equal(store.job("job-irrev").status, "running");
  gate.release();
  await store.whenIdle();
  const done = store.job("job-irrev");
  assert.equal(done.status, "succeeded");
  assert.equal(done.result?.spaceId, "alpha");
});

test("a cancellable running job stays running until the handler confirms abort", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  const started = latch();
  void store.submit(startCmd(), "job-abort", async (ctx) => {
    ctx.cancellable(true);
    ctx.phase("copy");
    started.release();
    await new Promise<void>((_resolve, reject) => {
      ctx.signal.addEventListener("abort", () => reject(new WorkbenchJobAbortError()), { once: true });
    });
  });
  await started.promise;
  await waitUntil(() => store.job("job-abort").canCancel, "cancellable");
  const afterCancel = await store.cancel("job-abort");
  assert.equal(afterCancel.status, "running");
  await store.whenIdle();
  assert.equal(store.job("job-abort").status, "cancelled");
});

test("ignoring abort keeps the handler's real result", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  const gate = latch();
  void store.submit(startCmd(), "job-ignore", async (ctx) => {
    ctx.cancellable(true);
    await gate.promise;
    ctx.result({ spaceId: "alpha" });
  });
  await waitUntil(() => store.job("job-ignore").canCancel, "cancellable");
  const afterCancel = await store.cancel("job-ignore");
  assert.equal(afterCancel.status, "running");
  gate.release();
  await store.whenIdle();
  const done = store.job("job-ignore");
  assert.equal(done.status, "succeeded");
  assert.equal(done.result?.spaceId, "alpha");
});

test("startup leftover queued jobs are recovery-required and are not replayed", async () => {
  const home = tempHome();
  mkdirSync(jobsDir(home), { recursive: true });
  const createdAt = "2026-09-12T00:00:00.000Z";
  writeFileSync(
    jobFile(home, "legacy-1"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "legacy-1",
      requestId: "legacy-1",
      kind: "space.start",
      command: { kind: "space.start", spaceId: "alpha" },
      commandCanonical: '{"kind":"space.start","spaceId":"alpha"}',
      status: "queued",
      phase: "copy-files",
      message: "copying",
      affectedSpaceIds: ["alpha"],
      createdAt,
      updatedAt: createdAt,
      canCancel: true,
    }, null, 2)}\n`,
  );

  let writes = 0;
  let ran = 0;
  const store = new WorkbenchJobStore({
    home,
    inject: (op) => {
      if (op === "write") writes += 1;
    },
  });
  await store.whenIdle();
  assert.equal(ran, 0);
  const job = store.job("legacy-1");
  assert.equal(job.status, "recovery-required");
  assert.equal(job.phase, "copy-files");
  assert.equal(job.requestId, "legacy-1");
  assert.equal(job.canCancel, false);
  assert.equal("command" in job, false);
  assert.equal(writes, 1);

  const onDisk = JSON.parse(readFileSync(jobFile(home, "legacy-1"), "utf8")) as {
    status: string;
    phase: string;
    command: WorkbenchCommand;
  };
  assert.equal(onDisk.status, "recovery-required");
  assert.equal(onDisk.phase, "copy-files");
  assert.deepEqual(onDisk.command, { kind: "space.start", spaceId: "alpha" });

  const same = await store.submit(startCmd("alpha"), "legacy-1", async () => {
    ran += 1;
  });
  assert.equal(same.status, "recovery-required");
  await store.whenIdle();
  assert.equal(ran, 0);

  await assert.rejects(
    () => store.submit(startCmd("beta"), "new-start", async () => {
      ran += 1;
    }),
    (error: unknown) => error instanceof WorkbenchJobError && error.code === "workbench/recovery-required",
  );

  const resume = await store.submit({ kind: "recovery.resume" }, "resume-1", async () => {
    ran += 1;
  });
  await store.whenIdle();
  assert.equal(resume.kind, "recovery.resume");
  assert.equal(store.job("resume-1").status, "succeeded");
  assert.equal(ran, 1);
  assert.equal(store.job("legacy-1").status, "recovery-required");
});

test("public job views omit internal fields; unknown errors stay static", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  await store.submit(startCmd(), "job-leak", async (ctx) => {
    ctx.message("could not start; D:\\Users\\admin\\.dsh\\credentials.yaml token=private-launch-token cookie=dsh-auth-fixture=session");
    throw new Error("ENOENT D:\\Users\\admin\\.dsh\\credentials.yaml token=private-launch-token");
  });
  await store.whenIdle();
  const job = store.get("job-leak");
  assert.equal(job.status, "failed");
  for (const key of Object.keys(job)) {
    assert.ok(publicJobKeys().includes(key), key);
  }
  assert.equal("command" in job, false);
  assert.equal("commandCanonical" in job, false);
  assert.equal("schemaVersion" in job, false);
  assert.equal(job.error?.code, "workbench/failed");
  assert.equal(job.error?.message, WORKBENCH_JOB_ERROR["workbench/failed"]);
  assert.equal(job.message.includes("D:"), false);
  assert.equal(job.message.includes("private-launch-token"), false);
  assert.equal(job.message.includes("dsh-auth-fixture"), false);
  const encoded = JSON.stringify(job);
  assert.equal(encoded.includes("command"), false);
  assert.equal(encoded.includes("credentials.yaml"), false);
  assert.equal(encoded.includes("private-launch-token"), false);
});

test("a corrupt job file is recovery-required and the original bytes are kept", async () => {
  const home = tempHome();
  mkdirSync(jobsDir(home), { recursive: true });
  writeFileSync(jobFile(home, "broken-1"), "{not-json", "utf8");
  const store = new WorkbenchJobStore({ home });
  const jobs = store.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.id, "broken-1");
  assert.equal(jobs[0]?.status, "recovery-required");
  assert.equal("command" in jobs[0]!, false);
  assert.equal(readFileSync(jobFile(home, "broken-1"), "utf8"), "{not-json");
});

test("jobs run serially and survive returning the HTTP-facing promise", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  const order: string[] = [];
  const first = await store.submit(startCmd("one"), "serial-a", async () => {
    order.push("a-start");
    await delay(40);
    order.push("a-end");
  });
  const second = await store.submit(startCmd("two"), "serial-b", async () => {
    order.push("b-start");
    order.push("b-end");
  });
  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  await store.whenIdle();
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("unreadable history cannot be settled into a fabricated terminal job", async () => {
  const home = tempHome();
  mkdirSync(jobsDir(home), { recursive: true });
  writeFileSync(jobFile(home, "unknown"), "{broken", "utf8");
  const store = new WorkbenchJobStore({ home });
  await assert.rejects(() => store.settleRecovery("unknown", { status: "failed" }),
    (error: unknown) => error instanceof WorkbenchJobError && error.code === "workbench/recovery-required");
  assert.equal(readFileSync(jobFile(home, "unknown"), "utf8"), "{broken");
  assert.equal(new WorkbenchJobStore({ home }).job("unknown").status, "recovery-required");
});

test("unknown command kinds and controller.acquire parse as contract input", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  await assert.rejects(
    () => store.submit({ kind: "space.delete", spaceId: "alpha" } as unknown as WorkbenchCommand, "nope", noop()),
    (error: unknown) => error instanceof WorkbenchJobError && error.code === "workbench/invalid-input",
  );
  const acquired = await store.submit({ kind: "controller.acquire" }, "acq-1", async () => undefined);
  await store.whenIdle();
  assert.equal(acquired.kind, "controller.acquire");
  assert.equal(store.job("acq-1").status, "succeeded");
});

function validStoredJob(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    requestId: id,
    kind: "space.start",
    command: { kind: "space.start", spaceId: "alpha" },
    commandCanonical: '{"kind":"space.start","spaceId":"alpha"}',
    status: "succeeded",
    phase: "succeeded",
    message: "",
    affectedSpaceIds: ["alpha"],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    canCancel: false,
    ...overrides,
  };
}

test("unknown schemaVersion is recovery-required and does not look succeeded", async () => {
  const home = tempHome();
  mkdirSync(jobsDir(home), { recursive: true });
  const raw = `${JSON.stringify(validStoredJob("future-1", { schemaVersion: 999 }), null, 2)}\n`;
  writeFileSync(jobFile(home, "future-1"), raw, "utf8");
  const store = new WorkbenchJobStore({ home });
  const job = store.job("future-1");
  assert.equal(job.status, "recovery-required");
  assert.notEqual(job.status, "succeeded");
  assert.equal(readFileSync(jobFile(home, "future-1"), "utf8"), raw);
});

test("filename id mismatch does not overwrite another job file", async () => {
  const home = tempHome();
  mkdirSync(jobsDir(home), { recursive: true });
  const mismatched = `${JSON.stringify(validStoredJob("bar", { id: "bar", requestId: "bar" }), null, 2)}\n`;
  const legitimate = `${JSON.stringify(validStoredJob("bar", {
    command: { kind: "space.start", spaceId: "kept" },
    kind: "space.start",
    affectedSpaceIds: ["kept"],
    result: { spaceId: "kept" },
  }), null, 2)}\n`;
  writeFileSync(jobFile(home, "foo"), mismatched, "utf8");
  writeFileSync(jobFile(home, "bar"), legitimate, "utf8");
  const store = new WorkbenchJobStore({ home });
  assert.equal(store.job("foo").status, "recovery-required");
  assert.equal(store.job("bar").status, "succeeded");
  assert.equal(store.job("bar").result?.spaceId, "kept");
  assert.equal(readFileSync(jobFile(home, "foo"), "utf8"), mismatched);
  assert.equal(readFileSync(jobFile(home, "bar"), "utf8"), legitimate);
});

test("missing command or invalid terminal result is recovery-required and keeps the file", async () => {
  const home = tempHome();
  mkdirSync(jobsDir(home), { recursive: true });
  const missingCommand = validStoredJob("no-cmd");
  delete missingCommand.command;
  const missingRaw = `${JSON.stringify(missingCommand, null, 2)}\n`;
  const pathResult = `${JSON.stringify(validStoredJob("path-ver", {
    result: { runtimeVersion: "D:\\\\dsh\\\\versions\\\\0.1.5-rc.1" },
  }), null, 2)}\n`;
  writeFileSync(jobFile(home, "no-cmd"), missingRaw, "utf8");
  writeFileSync(jobFile(home, "path-ver"), pathResult, "utf8");
  const store = new WorkbenchJobStore({ home });
  assert.equal(store.job("no-cmd").status, "recovery-required");
  assert.equal(store.job("path-ver").status, "recovery-required");
  assert.equal(readFileSync(jobFile(home, "no-cmd"), "utf8"), missingRaw);
  assert.equal(readFileSync(jobFile(home, "path-ver"), "utf8"), pathResult);
});

test("a missing jobs directory is empty; only ENOENT counts as absent", async () => {
  const home = tempHome();
  const store = new WorkbenchJobStore({ home });
  assert.deepEqual(store.list(), []);

  const blocked = tempHome();
  mkdirSync(join(blocked, WORKBENCH_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(join(blocked, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME), "not-a-dir", "utf8");
  assert.throws(
    () => new WorkbenchJobStore({ home: blocked }),
    (error: unknown) => error instanceof WorkbenchJobError && error.code === "workbench/recovery-required",
  );
});

test("persist failure on a running job freezes later queued work until settleRecovery", async () => {
  const home = tempHome();
  const writes = new Map<string, number>();
  let secondSide = 0;
  const store = new WorkbenchJobStore({
    home,
    inject: (_op, id) => {
      if (!id) return;
      const n = (writes.get(id) ?? 0) + 1;
      writes.set(id, n);
      if (id === "job-first" && n === 3) throw new Error("EACCES D:\\secret\\jobs");
    },
  });

  const first = await store.submit(startCmd("one"), "job-first", async (ctx) => {
    ctx.phase("commit");
    return { spaceId: "one" };
  });
  const second = await store.submit(startCmd("two"), "job-second", async () => {
    secondSide += 1;
    return { spaceId: "two" };
  });
  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  await store.whenIdle();

  assert.equal(store.job("job-first").status, "recovery-required");
  assert.equal(store.job("job-first").phase, "running");
  assert.equal(store.job("job-second").status, "cancelled");
  assert.equal(secondSide, 0);

  await assert.rejects(
    () => store.submit(startCmd("three"), "job-third", async () => {
      secondSide += 1;
    }),
    (error: unknown) => error instanceof WorkbenchJobError && error.code === "workbench/recovery-required",
  );

  const resume = await store.submit({ kind: "recovery.resume" }, "job-resume", async () => {
    return { snapshotId: "snap-1" };
  });
  await store.whenIdle();
  assert.equal(store.job("job-resume").status, "succeeded");
  assert.equal(resume.kind, "recovery.resume");
  assert.equal(store.job("job-first").status, "recovery-required");

  const settled = await store.settleRecovery("job-first", {
    status: "failed",
    message: "Interrupted start was rolled back from the journal.",
  });
  assert.equal(settled.status, "failed");
  assert.equal(settled.error?.message, WORKBENCH_JOB_ERROR["workbench/failed"]);
  assert.match(settled.message, /rolled back/i);

  await assert.rejects(
    () => store.settleRecovery("job-second", { status: "cancelled" }),
    (error: unknown) => error instanceof WorkbenchJobError && error.code === "workbench/invalid-input",
  );

  const next = await store.submit(startCmd("three"), "job-third", async () => ({ spaceId: "three" }));
  await store.whenIdle();
  assert.equal(next.kind, "space.start");
  assert.equal(store.job("job-third").status, "succeeded");
  assert.equal(secondSide, 0);
});

test("result and view projection drop path, token, and non-loopback origins", async () => {
  const store = new WorkbenchJobStore({ home: tempHome() });
  const entryOrigin = "http://127.0.0.1:3100";
  await store.submit(startCmd(), "proj-1", async () => ({
    spaceId: "alpha",
    runtimeVersion: "D:\\dsh\\versions\\0.1.5-rc.1",
    view: {
      spaceId: "alpha",
      generation: 2,
      origin: "http://127.0.0.1:3210/?token=private-launch-token",
      entryOrigin,
      entryPath: "/workbench/view/alpha",
      channel: "ch-1",
    },
  }));
  await store.whenIdle();
  const leaked = store.job("proj-1");
  assert.equal(leaked.status, "succeeded");
  assert.equal(leaked.result?.spaceId, "alpha");
  assert.equal(leaked.result?.runtimeVersion, undefined);
  assert.equal(leaked.result?.view, undefined);
  const encoded = JSON.stringify(leaked);
  assert.equal(encoded.includes("D:"), false);
  assert.equal(encoded.includes("private-launch-token"), false);
  assert.equal(encoded.includes("versions"), false);

  await store.submit(startCmd("beta"), "proj-2", async () => ({
    spaceId: "beta",
    runtimeVersion: "0.1.5-rc.1",
    view: {
      spaceId: "beta",
      generation: 1,
      origin: "http://127.0.0.1:3210",
      entryOrigin,
      entryPath: "//127.0.0.1/workbench/view/beta",
      channel: "ch-2",
    },
  }));
  await store.whenIdle();
  assert.equal(store.job("proj-2").result?.runtimeVersion, "0.1.5-rc.1");
  assert.equal(store.job("proj-2").result?.view, undefined);

  await store.submit(startCmd("gamma"), "proj-3", async () => ({
    spaceId: "gamma",
    view: {
      spaceId: "gamma",
      generation: 1,
      origin: "http://user:pass@127.0.0.1:3210",
      entryOrigin,
      entryPath: "/workbench/view/gamma",
      channel: "ch-3",
    },
  }));
  await store.whenIdle();
  assert.equal(store.job("proj-3").result?.view, undefined);

  await store.submit(startCmd("delta"), "proj-4", async () => ({
    spaceId: "delta",
    runtimeVersion: "0.1.5-rc.1",
    view: {
      spaceId: "delta",
      generation: 3,
      origin: "http://127.0.0.1:3210",
      entryOrigin,
      entryPath: "/view/delta/3",
      channel: "ch-4",
    },
  }));
  await store.whenIdle();
  const clean = store.job("proj-4");
  assert.equal(clean.result?.runtimeVersion, "0.1.5-rc.1");
  assert.deepEqual(clean.result?.view, {
    spaceId: "delta",
    generation: 3,
    origin: "http://127.0.0.1:3210",
    entryOrigin,
    entryPath: "/view/delta/3",
    channel: "ch-4",
  });

  await store.submit(startCmd("epsilon"), "proj-5", async () => ({
    spaceId: "epsilon",
    runtimeVersion: "0.1.5-rc.1",
    view: {
      spaceId: "epsilon",
      generation: 1,
      origin: "http://127.0.0.1:3210",
      entryOrigin: "http://192.168.0.5:3100",
      entryPath: "/view/epsilon/1",
      channel: "ch-5",
    },
  }));
  await store.whenIdle();
  assert.equal(store.job("proj-5").result?.runtimeVersion, "0.1.5-rc.1");
  assert.equal(store.job("proj-5").result?.view, undefined);

  await store.submit(startCmd("zeta"), "proj-6", async () => ({
    spaceId: "zeta",
    view: {
      spaceId: "zeta",
      generation: 4,
      origin: "http://127.0.0.1:3210",
      entryOrigin: "http://127.0.0.1:3100/?token=private-entry-token",
      entryPath: "/view/zeta/4",
      channel: "ch-6",
    },
  }));
  await store.whenIdle();
  assert.equal(store.job("proj-6").result?.view, undefined);
  assert.equal(JSON.stringify(store.job("proj-6")).includes("private-entry-token"), false);
});

test("settleRecovery rejects a path runtimeVersion instead of storing it", async () => {
  const home = tempHome();
  mkdirSync(jobsDir(home), { recursive: true });
  writeFileSync(
    jobFile(home, "need-settle"),
    `${JSON.stringify(validStoredJob("need-settle", { status: "queued", phase: "copy", canCancel: true }), null, 2)}\n`,
    "utf8",
  );
  const store = new WorkbenchJobStore({ home });
  assert.equal(store.job("need-settle").status, "recovery-required");
  await assert.rejects(
    () =>
      store.settleRecovery("need-settle", {
        status: "succeeded",
        result: { runtimeVersion: "C:\\Users\\admin\\.dsh\\versions\\0.1.5-rc.1" },
      }),
    (error: unknown) => error instanceof WorkbenchJobError && error.code === "workbench/invalid-input",
  );
  assert.equal(store.job("need-settle").status, "recovery-required");
  const settled = await store.settleRecovery("need-settle", {
    status: "succeeded",
    result: { runtimeVersion: "0.1.5-rc.1", spaceId: "alpha" },
  });
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.result?.runtimeVersion, "0.1.5-rc.1");
});
