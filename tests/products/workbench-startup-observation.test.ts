import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE, HomeLease, type HomeControlHandle } from "../../src/adapters/node/home/home-lease.ts";
import { canonicalHome, HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock.ts";
import { coldStartLockLabel } from "../../src/adapters/node/payload/component-selection.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";
import { deriveServiceEpoch, digestHomeIdentity } from "../../src/adapters/node/server/workbench-protocol.ts";
import {
  STARTUP_EPOCH_MISMATCH,
  STARTUP_READ_FAILED,
  STARTUP_READY_INCONSISTENT,
  type StartupObservationReader,
} from "../../packages/plugin/src/host/startup-observation.ts";
import { WorkbenchHostRuntime } from "../../packages/plugin/src/host/runtime.ts";
import {
  bootstrapSupervisor,
  SUPERVISOR_ENDPOINT_FILE,
  writeEndpointFile,
  type SupervisorEndpoint,
} from "../../packages/plugin/src/host/supervisor-bootstrap.ts";
import { createWorkbenchHttpClient } from "../../packages/plugin/src/host/workbench-http.ts";
import type { WorkbenchInitializeResult } from "../../packages/plugin/src/types.ts";

const temps: string[] = [];
const handles: HomeControlHandle[] = [];
const epoch = "a".repeat(64);
const STARTUP_ABORT_ASSERTION_MS = 900;
const home = mkdtempSync(join(tmpdir(), "dsh-startup-obs-"));
temps.push(home);

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { handle.release(); } catch { /* isolation */ }
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (!temps.includes(home)) temps.push(home);
});

function runtime(timeoutMs: number): WorkbenchHostRuntime {
  return new WorkbenchHostRuntime({
    home,
    allowRealHome: false,
    argv: [process.execPath, "not-a-real-cli"],
    env: { DSH_HOME: home },
    supervisorTimeoutMs: timeoutMs,
  });
}

function watch(host: WorkbenchHostRuntime, api: StartupObservationReader, serviceEpoch = epoch) {
  const observed = host as unknown as {
    waitForManager(api: StartupObservationReader, endpoint: { serviceEpoch: string }): Promise<WorkbenchInitializeResult | null>;
  };
  return observed.waitForManager(api, { serviceEpoch });
}

function managerState(status: "running" | "starting"): StartupObservationReader["state"] {
  return async () => ({
    role: "manager",
    serviceEpoch: epoch,
    managerId: "hub",
    maintenance: false,
    availability: "limited",
    jobs: [],
    reasons: [],
    spaces: [{ id: "hub", status }],
  }) as unknown as Awaited<ReturnType<StartupObservationReader["state"]>>;
}

test("a healthy manager is ready without startupStatus", async () => {
  let stateCalls = 0;
  let startupCalls = 0;
  const api: StartupObservationReader = {
    state: async () => { stateCalls += 1; return managerState("running")(); },
    startupStatus: async () => { startupCalls += 1; throw new Error("startupStatus must not be called"); },
  };
  assert.equal(await watch(runtime(600), api), null);
  assert.equal(stateCalls, 1);
  assert.equal(startupCalls, 0);
});

test("same-epoch startup failure keeps primary and cleanup and does not poll", async () => {
  let stateCalls = 0;
  let startupCalls = 0;
  const api: StartupObservationReader = {
    state: async () => { stateCalls += 1; return managerState("starting")(); },
    startupStatus: async () => {
      startupCalls += 1;
      return {
        serviceEpoch: epoch,
        managerId: "hub",
        phase: "failed",
        reasons: [],
        failure: {
          stage: "endpoint",
          primaryReason: "ORIGINAL_STARTUP_FAILURE",
          cleanupReason: "CLEANUP_STOP_FAILURE",
          instanceRetained: true,
        },
      };
    },
  };
  const result = await watch(runtime(600), api);
  assert.equal(stateCalls, 1);
  assert.equal(startupCalls, 1);
  assert.ok(result && !result.ok);
  assert.ok(result.reasons.includes("ORIGINAL_STARTUP_FAILURE"));
  assert.ok(result.reasons.includes("CLEANUP_STOP_FAILURE"));
});

test("changed epoch and a single failed read both stop", async () => {
  let stateCalls = 0;
  let startupCalls = 0;
  const changed = await watch(runtime(600), {
    state: async () => { stateCalls += 1; return managerState("starting")(); },
    startupStatus: async () => {
      startupCalls += 1;
      return {
        serviceEpoch: "b".repeat(64),
        managerId: "hub",
        phase: "starting",
        reasons: [],
        failure: null,
      };
    },
  });
  assert.equal(stateCalls, 1);
  assert.equal(startupCalls, 1);
  assert.deepEqual(changed?.reasons, [STARTUP_EPOCH_MISMATCH]);

  stateCalls = 0;
  const failed = await watch(runtime(600), {
    state: async () => { stateCalls += 1; throw new Error("READ_TRANSPORT_FAILED token=fixture-secret"); },
    startupStatus: async () => { startupCalls += 1; throw new Error("second read"); },
  });
  assert.equal(stateCalls, 1);
  assert.equal(startupCalls, 1);
  assert.deepEqual(failed?.reasons, [STARTUP_READ_FAILED]);
  assert.equal(JSON.stringify(failed).includes("fixture-secret"), false);
});

test("an inconsistent ready status fails once", async () => {
  let startupCalls = 0;
  const inconsistent = await watch(runtime(600), {
    state: managerState("starting"),
    startupStatus: async () => {
      startupCalls += 1;
      return { serviceEpoch: epoch, managerId: "hub", phase: "ready", reasons: [], failure: null };
    },
  });
  assert.equal(startupCalls, 1);
  assert.deepEqual(inconsistent?.reasons, [STARTUP_READY_INCONSISTENT]);
});

test("manager becoming running between state and startupStatus is observed after ready", async () => {
  const calls: string[] = [];
  let running = false;
  const result = await watch(runtime(600), {
    state: async () => {
      calls.push("state");
      return managerState(running ? "running" : "starting")();
    },
    startupStatus: async () => {
      calls.push("startupStatus");
      running = true;
      return { serviceEpoch: epoch, managerId: "hub", phase: "ready", reasons: [], failure: null };
    },
  });
  assert.equal(result, null);
  assert.deepEqual(calls, ["state", "startupStatus", "state"]);
});

test("ready is confirmed once and an inconsistent manager stays failed", async () => {
  const calls: string[] = [];
  const result = await watch(runtime(600), {
    state: async () => { calls.push("state"); return managerState("starting")(); },
    startupStatus: async () => {
      calls.push("startupStatus");
      return { serviceEpoch: epoch, managerId: "hub", phase: "ready", reasons: [], failure: null };
    },
  });
  assert.deepEqual(result?.reasons, [STARTUP_READY_INCONSISTENT]);
  assert.deepEqual(calls, ["state", "startupStatus", "state"]);
});

test("post-ready observation keeps transport, epoch, crash and maintenance failures terminal", async () => {
  for (const fault of ["transport", "epoch", "crash", "maintenance"] as const) {
    const calls: string[] = [];
    const result = await watch(runtime(600), {
      state: async () => {
        calls.push("state");
        if (calls.length === 1) return managerState("starting")();
        if (fault === "transport") throw new Error("fixture-secret");
        const state = await managerState("running")();
        if (fault === "epoch") state.serviceEpoch = "b".repeat(64);
        if (fault === "crash") state.spaces[0]!.status = "crashed";
        if (fault === "maintenance") state.availability = "unavailable";
        return state;
      },
      startupStatus: async () => {
        calls.push("startupStatus");
        return { serviceEpoch: epoch, managerId: "hub", phase: "ready", reasons: [], failure: null };
      },
    });
    assert.ok(result && !result.ok, fault);
    assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
    assert.deepEqual(calls, ["state", "startupStatus", "state"], fault);
  }
});

test("post-ready state read shares the startup deadline and is not retried", { timeout: 2_000 }, async () => {
  const calls: string[] = [];
  let signal: AbortSignal | undefined;
  const started = Date.now();
  const result = await watch(runtime(120), {
    state: async (readSignal) => {
      calls.push("state");
      if (calls.length === 1) return managerState("starting")();
      signal = readSignal;
      return new Promise(() => {});
    },
    startupStatus: async () => {
      calls.push("startupStatus");
      return { serviceEpoch: epoch, managerId: "hub", phase: "ready", reasons: [], failure: null };
    },
  });
  assert.ok(result && !result.ok);
  assert.ok(Date.now() - started < 500);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(calls, ["state", "startupStatus", "state"]);
});

test("a successful pending observation stays inside the phase budget", { timeout: 2_000 }, async () => {
  let stateCalls = 0;
  const started = Date.now();
  const result = await watch(runtime(320), {
    state: async () => { stateCalls += 1; return managerState("starting")(); },
    startupStatus: async () => ({ serviceEpoch: epoch, managerId: "hub", phase: "preparing", reasons: ["still preparing"], failure: null }),
  });
  assert.ok(Date.now() - started < 700);
  assert.ok(stateCalls >= 2);
  assert.ok(result && !result.ok);
  assert.ok(result.reasons.includes("still preparing"));
});

const httpEndpoint = {
  origin: "http://127.0.0.1:18463",
  bearer: "b".repeat(64),
  serviceEpoch: epoch,
  protocolVersion: 2 as const,
  homeId: "c".repeat(64),
};

function httpState(status: "starting" | "running") {
  return {
    protocolVersion: 2,
    serviceEpoch: epoch,
    revision: "d".repeat(64),
    availability: "limited",
    role: "manager",
    managerId: "spaces-hub",
    owner: { kind: "web", since: "2026-11-01T00:00:00.000Z" },
    writable: true,
    mode: "verified-full",
    dshVersion: "0.2.1-rc.2",
    maintenance: false,
    reasons: [],
    jobs: [],
    spaces: [{
      id: "spaces-hub",
      displayName: "Manager",
      isHost: true,
      hasWebApp: true,
      icon: "",
      status,
      generation: 1,
      managed: true,
      dshVersion: null, startWithDesktop: false,
    }],
  };
}

test("http startup reads abort a hung fetch and a hung body whose cancel never settles", { timeout: 2_000 }, async () => {
  for (const mode of ["hung-fetch", "hung-body", "hung-status-body"] as const) {
    let calls: string[] = [];
    let cancelled = 0;
    let signals: Array<AbortSignal | undefined> = [];
    const fetchImpl = async (input: string, init: RequestInit) => {
      const method = String(input).split("/").at(-1) ?? "";
      calls.push(method);
      signals.push(init.signal ?? undefined);
      if (mode === "hung-fetch") return new Promise<Response>(() => {});
      if (mode === "hung-body" || (mode === "hung-status-body" && method === "startupStatus")) {
        return new Response(new ReadableStream({
          start() {},
          cancel() { cancelled += 1; return new Promise<void>(() => {}); },
        }), { status: 200 });
      }
      return Response.json({ ok: true, value: httpState("starting") });
    };
    const started = Date.now();
    const result = await watch(runtime(120), createWorkbenchHttpClient({ endpoint: httpEndpoint, fetch: fetchImpl }), epoch);
    assert.ok(result && !result.ok, mode);
    assert.ok(Date.now() - started < STARTUP_ABORT_ASSERTION_MS, mode);
    assert.deepEqual(calls.filter((method) => method === "state"), ["state"], mode);
    assert.equal(cancelled, mode === "hung-fetch" ? 0 : 1, mode);
    assert.ok(signals.some((signal) => signal?.aborted), mode);
    if (mode === "hung-status-body") assert.deepEqual(calls, ["state", "startupStatus"]);
    calls = [];
    cancelled = 0;
    signals = [];
  }
});

test("a failed startupStatus read reports its remote reason", async () => {
  const calls: string[] = [];
  const result = await watch(runtime(600), createWorkbenchHttpClient({
    endpoint: httpEndpoint,
    fetch: async (input) => {
      const method = String(input).split("/").at(-1) ?? "";
      calls.push(method);
      if (method === "state") return Response.json({ ok: true, value: httpState("starting") });
      return Response.json({ ok: false, error: { code: "workbench/not-found" } }, { status: 404 });
    },
  }));
  assert.deepEqual(calls, ["state", "startupStatus"]);
  assert.deepEqual(result?.reasons, ["That item was not found."]);
});

test("an already running http manager does not call startupStatus", async () => {
  const calls: string[] = [];
  const result = await watch(runtime(600), createWorkbenchHttpClient({
    endpoint: httpEndpoint,
    fetch: async (input) => {
      calls.push(String(input).split("/").at(-1) ?? "");
      return Response.json({ ok: true, value: httpState("running") });
    },
  }));
  assert.equal(result, null);
  assert.deepEqual(calls, ["state"]);
});

test("ordinary client reads are not given a startup deadline", async () => {
  let signal: AbortSignal | null | undefined;
  const pending = createWorkbenchHttpClient({
    endpoint: httpEndpoint,
    fetch: async (_input, init) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    },
  }).snapshots();
  const winner = await Promise.race([
    pending.then(() => "settled", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 40)),
  ]);
  assert.equal(winner, "pending");
  assert.equal(signal, undefined);
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function endpointPath(dir: string): string {
  return join(dir, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE);
}

function endpointRecord(dir: string, origin: string, nonce: string): SupervisorEndpoint {
  return {
    origin,
    bearer: "B".repeat(32),
    protocolVersion: 2,
    homeId: digestHomeIdentity(canonicalHome(dir, { allowRealHome: false })),
    serviceEpoch: deriveServiceEpoch(nonce),
  };
}

function writeCli(root: string): string {
  const pkg = join(root, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version: COMPATIBLE_DSH_CLI_VERSION })}\n`);
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "export {};\n");
  return bin;
}

async function holdColdStart(dir: string, toolsRoot: string): Promise<() => Promise<void>> {
  const lock = new HomeOperationLock(toolsRoot);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  const running = lock.run(coldStartLockLabel(dir, { allowRealHome: false }), async () => {
    opened();
    await released;
  });
  await ready;
  return async () => {
    release();
    await running;
  };
}

test("hung discovery fails stale and does not start another service", { timeout: 2_000 }, async () => {
  const dir = tempDir("dsh-startup-disc-");
  const origin = "http://127.0.0.1:9";
  const handle = new HomeLease(dir, { allowRealHome: false }).acquire("web", `${origin}/`);
  handles.push(handle);
  const record = endpointRecord(dir, origin, handle.owner.nonce);
  const path = endpointPath(dir);
  writeEndpointFile(path, record);
  const before = readFileSync(path);
  let calls = 0;
  let spawned = 0;
  const signals: Array<AbortSignal | undefined> = [];
  const started = Date.now();
  const result = await bootstrapSupervisor({
    home: dir,
    allowRealHome: false,
    allowColdStart: true,
    payloadRoot: tempDir("dsh-startup-disc-payload-"),
    toolsRoot: tempDir("dsh-startup-disc-tools-"),
    timeoutMs: 150,
    fetch: async (_input, init) => {
      calls += 1;
      signals.push(init.signal ?? undefined);
      return new Promise(() => {});
    },
    spawn: () => { spawned += 1; },
  });
  assert.equal(result.connected, false);
  assert.equal(calls, 1);
  assert.equal(spawned, 0);
  assert.ok(Date.now() - started < 500);
  assert.ok(signals.some((signal) => signal?.aborted));
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  assert.ok(result.reasons.some((reason) => /ping/i.test(reason)));
  assert.deepEqual(readFileSync(path), before);
  const inspected = new HomeLease(dir, { allowRealHome: false }).inspect();
  assert.equal(inspected.held && "owner" in inspected ? inspected.owner.nonce : undefined, handle.owner.nonce);
});

test("endpoint polling does not send another state read after one failed ping", { timeout: 2_000 }, async () => {
  const dir = tempDir("dsh-startup-poll-");
  const tools = tempDir("dsh-startup-poll-tools-");
  const bin = writeCli(tempDir("dsh-startup-poll-cli-"));
  const release = await holdColdStart(dir, tools);
  const origin = "http://127.0.0.1:9";
  let calls = 0;
  let spawned = 0;
  let written = "";
  try {
    const result = await bootstrapSupervisor({
      home: dir,
      allowRealHome: false,
      allowColdStart: true,
      argv: [process.execPath, bin],
      execPath: process.execPath,
      env: { DSH_HOME: dir },
      payloadRoot: tempDir("dsh-startup-poll-payload-"),
      toolsRoot: tools,
      timeoutMs: 500,
      pollMs: 20,
      fetch: async () => {
        calls += 1;
        throw new Error("CONTROLLED_TRANSPORT_FAILURE token=fixture-secret");
      },
      spawn: () => { spawned += 1; },
      sleep: async () => {
        if (written) return;
        const handle = new HomeLease(dir, { allowRealHome: false }).acquire("web", `${origin}/`);
        handles.push(handle);
        const record = endpointRecord(dir, origin, handle.owner.nonce);
        const path = endpointPath(dir);
        writeEndpointFile(path, record);
        written = readFileSync(path, "utf8");
      },
    });
    assert.equal(result.connected, false, JSON.stringify(result));
    assert.equal(calls, 1, JSON.stringify(result));
    assert.equal(spawned, 0);
    assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
    assert.ok(result.reasons.some((reason) => /ping/i.test(reason)));
    assert.equal(readFileSync(endpointPath(dir), "utf8"), written);
    assert.ok(written.length > 0);
  } finally {
    await release();
  }
});

test("attach cancels a hung state body without waiting for cancel", { timeout: 2_000 }, async () => {
  const { attachExistingSupervisor } = await import("../../packages/plugin/src/host/supervisor-attach.ts");
  const dir = tempDir("dsh-startup-body-");
  const origin = "http://127.0.0.1:9";
  const handle = new HomeLease(dir, { allowRealHome: false }).acquire("web", `${origin}/`);
  handles.push(handle);
  const path = endpointPath(dir);
  writeEndpointFile(path, endpointRecord(dir, origin, handle.owner.nonce));
  const before = readFileSync(path);
  let calls = 0;
  let cancelled = 0;
  const started = Date.now();
  const outcome = await attachExistingSupervisor({
    home: dir,
    allowRealHome: false,
    timeoutMs: 120,
    fetch: async (_input, init) => {
      calls += 1;
      assert.ok(init.signal);
      return new Response(new ReadableStream({
        start() {},
        cancel() { cancelled += 1; return new Promise<void>(() => {}); },
      }), { status: 200 });
    },
  });
  assert.equal("stale" in outcome, true);
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  assert.ok(Date.now() - started < STARTUP_ABORT_ASSERTION_MS);
  assert.deepEqual(readFileSync(path), before);
});

async function cachedEpochMismatch(method: "bootstrap" | "managerApi"): Promise<{ reads: number; launches: number; outcome: unknown }> {
  const dir = tempDir(`dsh-startup-cached-${method}-`);
  const profileId = method === "bootstrap" ? "desktop" : "spaces-hub";
  const profile = join(dir, "profiles", profileId);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "isolated-fixture" }));
  const bin = writeCli(tempDir(`dsh-startup-cached-cli-${method}-`));
  const origin = "http://127.0.0.1:18465";
  const handle = new HomeLease(dir, { allowRealHome: false }).acquire("web", `${origin}/`);
  handles.push(handle);
  writeFileSync(join(dir, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), JSON.stringify({
    version: 1,
    profileId: "spaces-hub",
    createdAt: new Date().toISOString(),
  }));
  const endpoint = endpointRecord(dir, origin, handle.owner.nonce);
  writeEndpointFile(endpointPath(dir), endpoint);
  let reads = 0;
  let launches = 0;
  const fetchState = async () => {
    reads += 1;
    return Response.json({
      ok: true,
      value: {
        protocolVersion: 2,
        serviceEpoch: "a".repeat(64),
        revision: "b".repeat(64),
        availability: "ready",
        role: "manager",
        managerId: "spaces-hub",
        owner: { kind: "web", since: new Date().toISOString() },
        writable: true,
        mode: "verified-full",
        dshVersion: COMPATIBLE_DSH_CLI_VERSION,
        maintenance: false,
        reasons: [],
        jobs: [],
        spaces: [],
      },
    });
  };
  const host = new WorkbenchHostRuntime({
    home: dir,
    allowRealHome: false,
    argv: [process.execPath, bin, "--profile", profileId],
    env: { DSH_HOME: dir },
    baseUrl: `${pathToFileURL(profile).href}/`,
    supervisorTimeoutMs: 500,
    fetch: fetchState,
    bootstrap: async () => {
      launches += 1;
      throw new Error("UNEXPECTED_NEW_LAUNCH");
    },
  });
  const cached = host as unknown as {
    endpoint: SupervisorEndpoint | null;
    api: ReturnType<typeof createWorkbenchHttpClient> | null;
  };
  cached.endpoint = endpoint;
  cached.api = createWorkbenchHttpClient({ endpoint, fetch: fetchState });
  let outcome: unknown;
  try {
    outcome = method === "bootstrap" ? await host.bootstrap() : await host.managerApi();
  } catch (error) {
    outcome = { rejected: true, message: error instanceof Error ? error.message : String(error) };
  }
  return { reads, launches, outcome };
}

test("bootstrap stops after one cached ping when the service epoch changed", async () => {
  const { reads, launches, outcome } = await cachedEpochMismatch("bootstrap");
  assert.equal(reads, 1, JSON.stringify(outcome));
  assert.equal(launches, 0);
  assert.deepEqual(outcome, {
    ok: false,
    connected: false,
    unavailable: false,
    origin: "http://127.0.0.1:18465",
    reasons: [STARTUP_EPOCH_MISMATCH],
  });
});

test("managerApi stops after one cached ping when the service epoch changed", async () => {
  const { reads, launches, outcome } = await cachedEpochMismatch("managerApi");
  assert.equal(reads, 1, JSON.stringify(outcome));
  assert.equal(launches, 0);
  assert.deepEqual(outcome, { rejected: true, message: STARTUP_EPOCH_MISMATCH });
});
