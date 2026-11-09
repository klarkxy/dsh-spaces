/**
 * space.llm-policy.set — the supervisor-local plan kind behind the control
 * channel's llm-policy.set op (D5). Only stopped/crashed spaces may be
 * planned or executed; the write is a single atomic writeSpaceLlmPolicy call
 * inside the serialized job tail + home operation lock. No stop or restart
 * is ever performed by this plan.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SupervisorPlans } from "../../src/adapters/node/supervisor/plans.ts";
import type { SupervisorPlansHost } from "../../src/adapters/node/supervisor/plans.ts";
import { SupervisorLifecycle } from "../../src/adapters/node/supervisor/lifecycle.ts";
import { SpaceRunRegistry } from "../../src/adapters/node/supervisor/space-runs.ts";
import { HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock.ts";
import { ProfileRegistry } from "../../src/adapters/node/profile/profile-registry.ts";
import { WorkbenchJobStore, type WorkbenchJobContext } from "../../src/adapters/node/maintenance/workbench-jobs.ts";
import { WorkbenchPublicError } from "../../src/adapters/node/supervisor/errors.ts";
import { SpaceMessageRouter } from "../../src/adapters/node/message-bus/router.ts";
import { readSpaceLlmPolicy, writeSpaceLlmPolicy } from "../../src/adapters/node/llm/llm-policy-store.ts";
import type { ProfileStatus } from "../../src/shared/types.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-llm-policy-"));
  temps.push(home);
  return home;
}

interface Fixture {
  home: string;
  plans: SupervisorPlans;
  jobs: WorkbenchJobStore;
  status: Map<string, ProfileStatus>;
  stopped: string[];
  started: string[];
}

function makeFixture(home: string, status: Record<string, ProfileStatus> = {}): Fixture {
  const fixture = {
    home,
    status: new Map(Object.entries(status) as [string, ProfileStatus][]),
    stopped: [] as string[],
    started: [] as string[],
  } as Fixture;
  const lifecycle = new SupervisorLifecycle(() => {});
  lifecycle.handle = {
    owner: {
      kind: "web",
      pid: process.pid,
      nonce: "n".repeat(32),
      startedAt: new Date().toISOString(),
      endpoint: "http://127.0.0.1:1",
    },
    release: async () => undefined,
  } as never;
  const jobs = new WorkbenchJobStore({ home });
  const epoch = "e".repeat(64);
  const revision = "f".repeat(64);
  const host: SupervisorPlansHost = {
    home,
    lifecycle,
    runs: new SpaceRunRegistry(),
    instances: () => ({ writeLifecyclePlan() {}, consumeLifecyclePlan() {}, readLifecyclePlan: () => undefined }) as never,
    lock: new HomeOperationLock(home),
    registry: new ProfileRegistry(home),
    now: () => new Date(),
    messageBus: new SpaceMessageRouter(),
    options: { home, bin: "" },
    jobs: () => jobs,
    maintenance: () => null,
    closeHttp: async () => undefined,
    dropWritable: () => undefined,
    requireSpace: (id) => id,
    requireManaged: (id) => id,
    protectSpecial: (id) => {
      if (["web", "desktop", "spaces-hub"].includes(id)) throw new WorkbenchPublicError("workbench/protected");
    },
    statusOf: (id) => fixture.status.get(id) ?? "stopped",
    ownedSpaceIds: () => [...fixture.status.keys()],
    stopOwned: async (id) => { fixture.stopped.push(id); fixture.status.set(id, "stopped"); },
    stopOwnedAll: async () => undefined,
    startSpace: async (id) => { fixture.started.push(id); return { spaceId: id }; },
    readLlmPolicy: (id) => readSpaceLlmPolicy(home, id),
    writeLlmPolicy: (id, inheritMain) => writeSpaceLlmPolicy(home, id, inheritMain),
    currentServiceEpoch: () => epoch,
    stateRevision: () => revision,
    productObservation: () => ({ serviceEpoch: epoch, expectedRevision: revision }),
    assertLiveContext: () => undefined,
  };
  fixture.plans = new SupervisorPlans(host);
  fixture.jobs = jobs;
  return fixture;
}

function jobCtx(): WorkbenchJobContext {
  return {
    signal: new AbortController().signal,
    phase: () => undefined,
    message: () => undefined,
    cancellable: () => undefined,
    result: () => undefined,
  };
}

test("preview refuses a running space before freezing anything", async () => {
  const home = tempHome();
  const fx = makeFixture(home, { "space-alpha": "running" });
  assert.throws(
    () => fx.plans.previewLocal({ kind: "space.llm-policy.set", spaceId: "space-alpha", inheritMain: true }),
    (error: unknown) => {
      assert.ok(error instanceof WorkbenchPublicError);
      assert.equal(error.code, "workbench/conflict");
      assert.match(error.message, /stopped before its model policy/);
      return true;
    },
  );
  assert.equal(existsSync(join(home, "hub", "space-alpha", "llm-policy.json")), false);
});

test("preview on a stopped space reports the real from/to values", async () => {
  const home = tempHome();
  mkdirSync(join(home, "hub", "space-alpha"), { recursive: true });
  writeFileSync(
    join(home, "hub", "space-alpha", "llm-policy.json"),
    `${JSON.stringify({ schemaVersion: 1, inheritMain: false })}\n`,
  );
  const fx = makeFixture(home, { "space-alpha": "stopped" });
  const plan = fx.plans.previewLocal({ kind: "space.llm-policy.set", spaceId: "space-alpha", inheritMain: true });
  assert.equal(plan.kind, "space.llm-policy.set");
  assert.deepEqual(plan.affectedSpaceIds, ["space-alpha"]);
  assert.deepEqual(plan.runningSpaceIds, []);
  assert.equal(plan.destructive, false);
  assert.ok(plan.changes.some((line) => /inheritMain from false to true/.test(line)), JSON.stringify(plan.changes));
  assert.ok(plan.changes.some((line) => /stays stopped/.test(line)));
});

test("execute writes the policy atomically and never stops or starts the space", async () => {
  const home = tempHome();
  const fx = makeFixture(home, { "space-alpha": "stopped" });
  const plan = fx.plans.previewLocal({ kind: "space.llm-policy.set", spaceId: "space-alpha", inheritMain: true });
  const job = await fx.jobs.submit({ kind: "plan.execute", planId: plan.id }, "req-policy", (ctx) =>
    fx.plans.executePlan(plan.id, ctx),
  );
  await fx.jobs.whenIdle();
  assert.equal(fx.jobs.job(job.id).status, "succeeded");
  const policy = readSpaceLlmPolicy(home, "space-alpha");
  assert.equal(policy.inheritMain, true);
  assert.deepEqual(fx.stopped, []);
  assert.deepEqual(fx.started, []);
  // The persisted file is exactly the strict schema the spawn path parses.
  const raw = JSON.parse(readFileSync(join(home, "hub", "space-alpha", "llm-policy.json"), "utf8"));
  assert.deepEqual(raw, { schemaVersion: 1, inheritMain: true });
});

test("execute refuses when the space started running after the preview", async () => {
  const home = tempHome();
  const fx = makeFixture(home, { "space-alpha": "stopped" });
  const plan = fx.plans.previewLocal({ kind: "space.llm-policy.set", spaceId: "space-alpha", inheritMain: true });
  fx.status.set("space-alpha", "running");
  const job = await fx.jobs.submit({ kind: "plan.execute", planId: plan.id }, "req-policy-stale", (ctx) =>
    fx.plans.executePlan(plan.id, ctx),
  );
  await fx.jobs.whenIdle();
  const settled = fx.jobs.job(job.id);
  assert.equal(settled.status, "failed");
  assert.equal(existsSync(join(home, "hub", "space-alpha", "llm-policy.json")), false);
});

test("protected ids are refused for llm-policy plans", async () => {
  const home = tempHome();
  const fx = makeFixture(home, { web: "stopped" });
  assert.throws(
    () => fx.plans.previewLocal({ kind: "space.llm-policy.set", spaceId: "web", inheritMain: true }),
    (error: unknown) => {
      assert.ok(error instanceof WorkbenchPublicError);
      assert.equal(error.code, "workbench/protected");
      return true;
    },
  );
});
