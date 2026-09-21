import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
import { join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stringifyBlueprint } from "../src/adapters/node/blueprint-codec.ts";
import { HomeOperationLock } from "../src/adapters/node/home-operation-lock.ts";
import {
  INTERRUPTED_JOB_MESSAGE,
  WORKBENCH_CONTROL_DIR_NAME,
  WORKBENCH_JOBS_DIR_NAME,
  WorkbenchJobStore,
} from "../src/adapters/node/workbench-jobs.ts";
import { WorkbenchProductService, type WorkbenchProductPorts } from "../src/adapters/node/workbench-products.ts";
import { parseBlueprint } from "../src/core/domain/blueprint.ts";
import type { LlmApiResult } from "../src/shared/llm-api.ts";
import type { WorkbenchCommand, WorkbenchJob, WorkbenchSpace } from "../src/shared/workbench.ts";
import {
  BLUEPRINT_PLAN_MAX_COUNT,
  BLUEPRINT_PLAN_TTL_MS,
} from "../src/shared/workbench-blueprint.ts";
import type { WorkbenchProductObservation } from "../src/shared/workbench-product.ts";
import { parseWorkbenchProductResult } from "../src/shared/workbench-product-schemas.ts";
import { parse as parseYaml } from "yaml";

const temps: string[] = [];
const EPOCH = "ab".repeat(32);
const REV = "cd".repeat(32);
const STALE = "ef".repeat(32);
const T0 = Date.parse("2026-09-21T00:00:00.000Z");

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bp-life-"));
  temps.push(dir);
  mkdirSync(join(dir, "hub"), { recursive: true });
  mkdirSync(join(dir, "profiles"), { recursive: true });
  return dir;
}

function space(id: string): WorkbenchSpace {
  return {
    id,
    displayName: id,
    isHost: false,
    hasWebApp: true,
    isolation: "verified",
    icon: "box",
    status: "stopped",
    generation: 1,
    managed: true,
    needsIsolation: false,
  };
}

function writeMinimalProfile(dshHome: string, name: string): void {
  const dir = join(dshHome, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }),
  );
  mkdirSync(join(dshHome, "hub", name), { recursive: true });
}

function blueprintContent(): string {
  return stringifyBlueprint(
    parseBlueprint({
      kind: "dsh-blueprint",
      formatVersion: 1,
      metadata: { name: "test", version: "1.0.0" },
      packages: [],
      profile: { base: "web", bundles: [], patch: [], settings: { demo: { theme: "paper" } } },
    }),
  );
}

function fileIndex(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) {
        const rel = relative(root, abs).split("\\").join("/");
        out.set(rel, createHash("sha256").update(readFileSync(abs)).digest("hex"));
      }
    }
  };
  walk(root);
  return out;
}

function indexEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitStatus(jobs: WorkbenchJobStore, id: string, status: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (jobs.job(id).status === status) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${id} to become ${status} (have ${jobs.job(id).status})`);
}

async function waitRunningPhase(jobs: WorkbenchJobStore, id: string, phase: string): Promise<WorkbenchJob> {
  for (let i = 0; i < 100; i++) {
    const job = jobs.job(id);
    if (job.status === "running" && job.phase === phase) return job;
    await delay(10);
  }
  const job = jobs.job(id);
  throw new Error(`timed out waiting for ${id} phase ${phase} (status=${job.status} phase=${job.phase})`);
}

function emptyLlm(): LlmApiResult {
  return { revision: 0, connections: [], defaultModel: null } as LlmApiResult;
}

type Clock = { now: () => Date; set: (ms: number) => void };

function clockAt(ms: number): Clock {
  let current = ms;
  return {
    now: () => new Date(current),
    set: (next) => {
      current = next;
    },
  };
}

function openStack(
  dshHome: string,
  extra: {
    clock?: Clock;
    observation?: WorkbenchProductObservation;
    spaces?: WorkbenchSpace[];
    created?: string[];
    beforeCreate?: () => Promise<void>;
  } = {},
) {
  const clock = extra.clock ?? clockAt(T0);
  const observation = extra.observation ?? { serviceEpoch: EPOCH, expectedRevision: REV };
  const spaces = extra.spaces ?? [];
  const created = extra.created ?? [];
  const lock = new HomeOperationLock(dshHome);
  const forbidden = async () => {
    throw new Error("network, plugin execution, and model calls are not part of this fixture");
  };
  const ports: WorkbenchProductPorts = {
    home: dshHome,
    observation: () => observation,
    managerId: () => "manager",
    listSpaces: () => spaces,
    createSpace: async (input) => {
      await extra.beforeCreate?.();
      created.push(input.name);
      writeMinimalProfile(dshHome, input.name);
      spaces.push(space(input.name));
    },
    installPlugin: async () => {
      throw new Error("plugin execution is not part of this fixture");
    },
    llm: async () => emptyLlm(),
    diagnostics: (spaceId) => ({ spaceId, status: "stopped", logs: [], backups: [] }),
    withWrite: (label, action) => lock.run(label, action),
    now: () => clock.now(),
    fetchImpl: forbidden,
    prepareBlueprintPackage: forbidden,
    dshVersion: () => "0.1.5-rc.2",
    spacesVersion: () => "0.3.1",
    llmBridgeAvailable: () => true,
    runtimeBin: () => join(dshHome, "bin.js"),
    inspectRuntime: async () => ({
      versions: { dsh: "0.1.5-rc.2", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
      baseLayers: [],
      baseEntries: [],
      homePatches: [],
      fingerprint: "lifecycle-runtime",
    }),
  };
  return {
    clock,
    observation,
    spaces,
    created,
    lock,
    jobs: new WorkbenchJobStore({ home: dshHome, now: () => clock.now() }),
    service: new WorkbenchProductService(ports),
    ports,
  };
}

async function previewPlan(
  service: WorkbenchProductService,
  name: string,
): Promise<{ planId: string; expiresAt: string }> {
  const result = parseWorkbenchProductResult(
    await service.read({
      method: "blueprint.preview",
      content: blueprintContent(),
      name,
      values: {},
    }),
  );
  assert.equal(result.method, "blueprint.preview");
  if (result.method !== "blueprint.preview") {
    assert.fail("expected a blueprint.preview result");
  }
  assert.equal(typeof result.planId, "string");
  assert.ok(result.planId, "valid preview must stage a plan");
  assert.equal(typeof result.expiresAt, "string");
  assert.ok(result.expiresAt, "staged plan must expire");
  return { planId: result.planId, expiresAt: result.expiresAt };
}

async function submitApply(
  jobs: WorkbenchJobStore,
  service: WorkbenchProductService,
  planId: string,
  requestId: string,
) {
  const command: WorkbenchCommand = { kind: "blueprint.apply", planId };
  return jobs.submit(command, requestId, async (ctx) => {
    await service.execute(command, ctx);
  });
}

test("preview of a valid empty-package blueprint is readonly and an expired plan does not create", async () => {
  const dshHome = home();
  const stack = openStack(dshHome);
  const before = fileIndex(dshHome);
  const staged = await previewPlan(stack.service, "life-ro");
  assert.equal(staged.expiresAt, new Date(T0 + BLUEPRINT_PLAN_TTL_MS).toISOString());
  assert.equal(indexEqual(before, fileIndex(dshHome)), true);
  assert.deepEqual(stack.created, []);
  assert.equal(existsSync(join(dshHome, "profiles", "life-ro")), false);
  assert.equal(existsSync(join(dshHome, WORKBENCH_CONTROL_DIR_NAME)), false);

  stack.clock.set(T0 + BLUEPRINT_PLAN_TTL_MS);
  const requestId = randomUUID();
  const job = await submitApply(stack.jobs, stack.service, staged.planId, requestId);
  await stack.jobs.whenIdle();
  const done = stack.jobs.job(requestId);
  assert.equal(job.id, requestId);
  assert.equal(done.status, "failed");
  assert.equal(done.result?.spaceId, undefined);
  assert.deepEqual(stack.created, []);
  assert.equal(existsSync(join(dshHome, "profiles", "life-ro")), false);
});

test("epoch or revision change rejects an old plan before create", async () => {
  const dshHome = home();
  const observation: WorkbenchProductObservation = { serviceEpoch: EPOCH, expectedRevision: REV };
  const stack = openStack(dshHome, { observation });
  const staged = await previewPlan(stack.service, "life-cas");
  observation.expectedRevision = STALE;
  const requestId = randomUUID();
  await submitApply(stack.jobs, stack.service, staged.planId, requestId);
  await stack.jobs.whenIdle();
  const done = stack.jobs.job(requestId);
  assert.equal(done.status, "failed");
  assert.equal(done.result?.spaceId, undefined);
  assert.deepEqual(stack.created, []);
  assert.equal(existsSync(join(dshHome, "profiles", "life-cas")), false);

  observation.expectedRevision = REV;
  const restaged = await previewPlan(stack.service, "life-ep");
  observation.serviceEpoch = STALE;
  const again = randomUUID();
  await submitApply(stack.jobs, stack.service, restaged.planId, again);
  await stack.jobs.whenIdle();
  assert.equal(stack.jobs.job(again).status, "failed");
  assert.equal(stack.jobs.job(again).result?.spaceId, undefined);
  assert.deepEqual(stack.created, []);
  assert.equal(existsSync(join(dshHome, "profiles", "life-ep")), false);
});

test("one plan through JobStore, ProductService, and HomeOperationLock creates at most once", async () => {
  const dshHome = home();
  const hold = latch();
  const stack = openStack(dshHome, { beforeCreate: () => hold.promise });
  const staged = await previewPlan(stack.service, "life-once");
  const command: WorkbenchCommand = { kind: "blueprint.apply", planId: staged.planId };
  const requestId = randomUUID();
  let runs = 0;
  let extra = 0;
  const handler = async (ctx: Parameters<WorkbenchProductService["execute"]>[1]) => {
    runs += 1;
    await stack.service.execute(command, ctx);
  };
  const [first, replay] = await Promise.all([
    stack.jobs.submit(command, requestId, handler),
    stack.jobs.submit(command, requestId, async () => {
      extra += 1;
    }),
  ]);
  assert.equal(first.id, requestId);
  assert.equal(replay.id, requestId);
  await waitRunningPhase(stack.jobs, requestId, "space-create");
  const during = await stack.jobs.submit(command, requestId, async () => {
    extra += 1;
  });
  assert.equal(during.id, requestId);
  assert.equal(during.status, "running");
  assert.equal(runs, 1);
  assert.equal(extra, 0);
  assert.deepEqual(stack.created, []);

  const otherId = randomUUID();
  const other = await submitApply(stack.jobs, stack.service, staged.planId, otherId);
  assert.equal(other.id, otherId);
  assert.equal(other.status, "queued");
  assert.equal(stack.jobs.job(requestId).status, "running");

  hold.release();
  await stack.jobs.whenIdle();
  assert.equal(runs, 1);
  assert.equal(extra, 0);
  assert.deepEqual(stack.created, ["life-once"]);

  const original = stack.jobs.job(requestId);
  assert.equal(original.status, "succeeded");
  assert.equal(original.result?.spaceId, "life-once");
  const product = original.result?.product;
  assert.equal(product?.kind, "blueprint.apply");
  if (product?.kind !== "blueprint.apply") {
    assert.fail("expected a blueprint.apply product on the succeeded job");
  }
  assert.equal(product.stages["space-create"].status, "succeeded");
  assert.equal(product.stages.packages.status, "succeeded");
  assert.equal(product.stages.presets.status, "succeeded");
  assert.equal(product.stages.start.status, "not-run");
  assert.equal(product.writes.find((row) => row.kind === "settings")?.status, "succeeded");
  assert.equal(existsSync(join(dshHome, "profiles", "life-once", "package.json")), true);
  const settingsFile = join(dshHome, "hub", "life-once", "settings.yaml");
  assert.equal(existsSync(settingsFile), true);
  const settings = parseYaml(readFileSync(settingsFile, "utf8")) as { demo?: { theme?: unknown } };
  assert.equal(settings.demo?.theme, "paper");

  const second = stack.jobs.job(otherId);
  assert.equal(second.status, "failed");
  assert.equal(second.result?.spaceId, undefined);
  assert.deepEqual(stack.created, ["life-once"]);
});

test("a new product service cannot apply a transient plan and reopening JobStore does not replay a failed apply", async () => {
  const dshHome = home();
  const created: string[] = [];
  const spaces: WorkbenchSpace[] = [];
  const clock = clockAt(T0);
  const observation: WorkbenchProductObservation = { serviceEpoch: EPOCH, expectedRevision: REV };
  const first = openStack(dshHome, { clock, observation, spaces, created });
  const staged = await previewPlan(first.service, "life-mem");
  const secondService = new WorkbenchProductService(first.ports);
  const requestId = randomUUID();
  let secondRuns = 0;
  await first.jobs.submit({ kind: "blueprint.apply", planId: staged.planId }, requestId, async (ctx) => {
    secondRuns += 1;
    await secondService.execute({ kind: "blueprint.apply", planId: staged.planId }, ctx);
  });
  await first.jobs.whenIdle();
  assert.equal(secondRuns, 1);
  assert.equal(first.jobs.job(requestId).status, "failed");
  assert.deepEqual(created, []);

  let replayed = 0;
  const reopened = new WorkbenchJobStore({ home: dshHome, now: () => clock.now() });
  await reopened.whenIdle();
  assert.equal(reopened.job(requestId).status, "failed");
  const again = await reopened.submit({ kind: "blueprint.apply", planId: staged.planId }, requestId, async () => {
    replayed += 1;
  });
  await reopened.whenIdle();
  assert.equal(again.status, "failed");
  assert.equal(replayed, 0);
  assert.deepEqual(created, []);

  const leftoverId = randomUUID();
  const jobsDir = join(dshHome, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME);
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(
    join(jobsDir, `${leftoverId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      id: leftoverId,
      requestId: leftoverId,
      kind: "blueprint.apply",
      command: { kind: "blueprint.apply", planId: staged.planId },
      commandCanonical: JSON.stringify({ kind: "blueprint.apply", planId: staged.planId }),
      status: "queued",
      phase: "queued",
      message: "",
      affectedSpaceIds: [],
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
      canCancel: true,
    }, null, 2)}\n`,
  );
  const leftover = new WorkbenchJobStore({ home: dshHome, now: () => clock.now() });
  await leftover.whenIdle();
  assert.equal(leftover.job(leftoverId).status, "failed");
  assert.equal(leftover.job(leftoverId).message, INTERRUPTED_JOB_MESSAGE);
  assert.match(leftover.job(leftoverId).message, /not replayed/i);
  assert.deepEqual(created, []);
  assert.equal(existsSync(join(dshHome, "profiles", "life-mem")), false);
});

test("queued cancel and plan TTL reached while queued cannot create a space", async () => {
  const dshHome = home();
  const stack = openStack(dshHome);
  const blocker = latch();
  const blockerId = randomUUID();
  await stack.jobs.submit({ kind: "space.start", spaceId: "coding" }, blockerId, async () => {
    await blocker.promise;
  });
  await waitStatus(stack.jobs, blockerId, "running");

  const cancelPlan = await previewPlan(stack.service, "life-can");
  const ttlPlan = await previewPlan(stack.service, "life-ttl");
  const cancelId = randomUUID();
  const ttlId = randomUUID();
  let cancelRan = 0;
  let ttlRan = 0;
  const queuedCancel = await stack.jobs.submit(
    { kind: "blueprint.apply", planId: cancelPlan.planId },
    cancelId,
    async (ctx) => {
      cancelRan += 1;
      await stack.service.execute({ kind: "blueprint.apply", planId: cancelPlan.planId }, ctx);
    },
  );
  const queuedTtl = await stack.jobs.submit({ kind: "blueprint.apply", planId: ttlPlan.planId }, ttlId, async (ctx) => {
    ttlRan += 1;
    await stack.service.execute({ kind: "blueprint.apply", planId: ttlPlan.planId }, ctx);
  });
  assert.equal(queuedCancel.status, "queued");
  assert.equal(queuedTtl.status, "queued");

  const cancelled = await stack.jobs.cancel(cancelId);
  assert.equal(cancelled.status, "cancelled");
  stack.clock.set(T0 + BLUEPRINT_PLAN_TTL_MS);
  blocker.release();
  await stack.jobs.whenIdle();

  const cancelDone = stack.jobs.job(cancelId);
  const ttlDone = stack.jobs.job(ttlId);
  assert.equal(cancelRan, 0);
  assert.equal(cancelDone.status, "cancelled");
  assert.equal(cancelDone.result?.spaceId, undefined);
  assert.equal(ttlRan, 1);
  assert.equal(ttlDone.status, "failed");
  assert.equal(ttlDone.result?.spaceId, undefined);
  if (ttlDone.result?.product && ttlDone.result.product.kind === "blueprint.apply") {
    assert.notEqual(ttlDone.result.product.stages["space-create"].status, "succeeded");
    assert.equal(ttlDone.result.product.stages.start.status, "not-run");
  }
  assert.deepEqual(stack.created, []);
  assert.equal(existsSync(join(dshHome, "profiles", "life-can")), false);
  assert.equal(existsSync(join(dshHome, "profiles", "life-ttl")), false);
  assert.equal(stack.jobs.job(cancelId).status, "cancelled");
  assert.equal(stack.jobs.job(ttlId).status, "failed");
});

test("the sixteenth pending preview is accepted and expiration frees capacity without a disk restore", async () => {
  const dshHome = home();
  const stack = openStack(dshHome);
  const planIds: string[] = [];
  for (let i = 0; i < BLUEPRINT_PLAN_MAX_COUNT; i++) {
    const name = `cap${String(i).padStart(2, "0")}`;
    const staged = await previewPlan(stack.service, name);
    planIds.push(staged.planId);
  }
  assert.equal(planIds.length, BLUEPRINT_PLAN_MAX_COUNT);
  await assert.rejects(
    () =>
      stack.service.read({
        method: "blueprint.preview",
        content: blueprintContent(),
        name: "cap16",
        values: {},
      }),
    /too many pending blueprint previews/i,
  );
  for (const id of planIds) {
    assert.equal(existsSync(join(dshHome, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, `${id}.json`)), false);
  }
  assert.equal(existsSync(join(dshHome, "profiles", "cap16")), false);

  stack.clock.set(T0 + BLUEPRINT_PLAN_TTL_MS);
  const freed = await previewPlan(stack.service, "cap16");
  assert.ok(freed.planId);
  assert.equal(planIds.includes(freed.planId), false);
  assert.deepEqual(stack.created, []);
  assert.equal(existsSync(join(dshHome, WORKBENCH_CONTROL_DIR_NAME)), false);
});
