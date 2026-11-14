import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalHome } from "../../src/adapters/node/home/home-operation-lock.ts";
import { HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE, HomeLease, type HomeControlHandle } from "../../src/adapters/node/home/home-lease.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";
import { deriveServiceEpoch, digestHomeIdentity } from "../../src/adapters/node/server/workbench-protocol.ts";
import { SUPERVISOR_ENDPOINT_FILE, writeEndpointFile } from "../../packages/plugin/src/host/supervisor-bootstrap.ts";
import { WorkbenchHostRuntime, type WorkbenchHostRuntimeOptions } from "../../packages/plugin/src/host/runtime.ts";
import { STARTUP_READ_FAILED } from "../../packages/plugin/src/host/startup-observation.ts";
import type { DesktopLaunchState } from "../../packages/plugin/src/types.ts";

const root = mkdtempSync(join(tmpdir(), "desktop-autostart-phase2-"));

function freshHome(prefix: string): string {
  return mkdtempSync(join(root, prefix));
}

function writeCli(home: string): string {
  const cli = join(home, "cli");
  mkdirSync(join(cli, "lib"), { recursive: true });
  writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: COMPATIBLE_DSH_CLI_VERSION }));
  const bin = join(cli, "lib/bin.js");
  writeFileSync(bin, "export {};\n");
  return bin;
}

function desktopOptions(home: string, extra: Partial<WorkbenchHostRuntimeOptions> = {}): WorkbenchHostRuntimeOptions {
  const profile = join(home, "profiles/desktop");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "isolated-desktop-fixture" }));
  const bin = writeCli(home);
  return {
    home,
    allowRealHome: false,
    argv: [process.execPath, bin, "--profile", "desktop"],
    env: { DSH_HOME: home },
    execPath: process.execPath,
    baseUrl: pathToFileURL(profile).href + "/",
    supervisorTimeoutMs: 2000,
    ...extra,
  };
}

function managerState(epoch: string, status: "running" | "starting" = "running") {
  return {
    protocolVersion: 2 as const,
    serviceEpoch: epoch,
    revision: "b".repeat(64),
    availability: status === "running" ? "ready" as const : "limited" as const,
    role: "manager" as const,
    managerId: "spaces-hub",
    owner: { kind: "web" as const, since: "2026-11-01T00:00:00.000Z" },
    writable: true,
    mode: "verified-full" as const,
    dshVersion: COMPATIBLE_DSH_CLI_VERSION,
    maintenance: false,
    reasons: [] as string[],
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

async function untilPhase(runtime: WorkbenchHostRuntime, phase: DesktopLaunchState["phase"]): Promise<DesktopLaunchState> {
  let last: DesktopLaunchState | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    last = await runtime.desktopLaunchState();
    if (last.phase === phase) return last;
    if (last.phase === "failed" && phase !== "failed") throw new Error(JSON.stringify(last));
    await delay(20);
  }
  throw new Error(`launch stayed ${last?.phase}: ${JSON.stringify(last)}`);
}

test("begin returns before a held cold start and joins one process record", async () => {
  const home = freshHome("cold-");
  let bootstraps = 0;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requests: string[] = [];
  let endpoint: { origin: string; bearer: string; protocolVersion: 2; homeId: string; serviceEpoch: string } | undefined;
  let lease: HomeControlHandle | undefined;
  const options = desktopOptions(home, {
    connect: () => ({ state: async () => managerState(endpoint!.serviceEpoch) }) as never,
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      assert.equal(url.endsWith("/api/workbench/state"), true);
      return Response.json({ ok: true, value: managerState(endpoint!.serviceEpoch) });
    },
    bootstrap: async (request) => {
      bootstraps++;
      assert.equal(request.startDesktopSpaces, true);
      request.progress?.("prepare");
      await gate;
      request.progress?.("launch");
      lease = new HomeLease(home, { allowRealHome: false }).acquire("web", "http://127.0.0.1:18462/");
      writeFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), JSON.stringify({ version: 1, profileId: "spaces-hub", createdAt: "2026-11-01T00:00:00.000Z" }));
      endpoint = {
        origin: "http://127.0.0.1:18462",
        bearer: "c".repeat(64),
        protocolVersion: 2,
        homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
        serviceEpoch: deriveServiceEpoch(lease.owner.nonce),
      };
      writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), endpoint);
      return { connected: true, origin: endpoint.origin, endpoint, payloadDir: home, toolsDir: home };
    },
  });
  const first = new WorkbenchHostRuntime(options);
  const alias = process.platform === "win32" ? home.toUpperCase() : home;
  const second = new WorkbenchHostRuntime({ ...options, home: alias, env: { DSH_HOME: alias } });
  try {
    const idle = await first.desktopLaunchState();
    assert.deepEqual(idle, { operationId: null, phase: "idle", serviceEpoch: null, managerId: null, reasons: [], failure: null });
    assert.equal(bootstraps, 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = await Promise.race([
      first.beginDesktopLaunch(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("begin waited")), 400); }),
    ]);
    clearTimeout(timer);
    assert.ok(started.operationId);
    assert.equal(started.phase === "ready", false);
    assert.equal((await second.beginDesktopLaunch()).operationId, started.operationId);
    const preparing = await untilPhase(first, "preparing");
    assert.equal(preparing.operationId, started.operationId);
    assert.equal(bootstraps, 1);
    assert.equal((await first.desktopLaunchState()).phase, "preparing");
    release();
    const ready = await untilPhase(first, "ready");
    assert.equal(ready.operationId, started.operationId);
    assert.equal(ready.managerId, "spaces-hub");
    assert.equal(bootstraps, 1);
    assert.equal(requests.some((url) => url.includes("/internal/bootstrap")), false);
    ready.reasons.push("CLIENT_MUTATION");
    assert.equal((await first.desktopLaunchState()).reasons.includes("CLIENT_MUTATION"), false);
    const remounted = new WorkbenchHostRuntime(options);
    assert.equal((await remounted.beginDesktopLaunch()).operationId, started.operationId);
    assert.equal(bootstraps, 1);
  } finally {
    release();
    lease?.release(() => unlinkSync(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE)));
  }
});

test("bootstrap failure latches a redacted reason without a fabricated structured failure", async () => {
  const home = freshHome("boot-fail-");
  let bootstraps = 0;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new WorkbenchHostRuntime(desktopOptions(home, {
    bootstrap: async (request) => {
      bootstraps++;
      request.progress?.("prepare");
      await gate;
      throw new Error("CONTROLLED_BOOTSTRAP_FAILURE token=fixture-secret");
    },
  }));
  try {
    await runtime.beginDesktopLaunch();
    release();
    const failed = await untilPhase(runtime, "failed");
    assert.equal(failed.failure, null);
    assert.match(failed.reasons.join(" "), /CONTROLLED_BOOTSTRAP_FAILURE/);
    assert.equal(JSON.stringify(failed).includes("fixture-secret"), false);
    assert.equal((await runtime.beginDesktopLaunch()).operationId, failed.operationId);
    assert.equal(bootstraps, 1);
    assert.equal((await runtime.initialize()).ok, false);
    assert.equal(bootstraps, 1);
  } finally { release(); }
});

test("manager startup failure keeps the already-read structured failure from one status read", async () => {
  const home = freshHome("manager-fail-");
  let startupReads = 0;
  let endpoint: { serviceEpoch: string } | undefined;
  let lease: HomeControlHandle | undefined;
  const runtime = new WorkbenchHostRuntime(desktopOptions(home, {
    connect: () => ({
      state: async () => managerState(endpoint!.serviceEpoch, "starting"),
      startupStatus: async () => {
        startupReads++;
        return {
          serviceEpoch: endpoint!.serviceEpoch,
          managerId: "spaces-hub",
          phase: "failed",
          reasons: ["PRIMARY_MANAGER_FAILURE", "SECONDARY_STOP_FAILURE"],
          failure: { stage: "endpoint", primaryReason: "PRIMARY_MANAGER_FAILURE", cleanupReason: "SECONDARY_STOP_FAILURE", instanceRetained: true },
        };
      },
    }) as never,
    bootstrap: async () => {
      lease = new HomeLease(home, { allowRealHome: false }).acquire("web", "http://127.0.0.1:18463/");
      endpoint = { serviceEpoch: deriveServiceEpoch(lease.owner.nonce) };
      const recorded = {
        origin: "http://127.0.0.1:18463",
        bearer: "d".repeat(64),
        protocolVersion: 2 as const,
        homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
        serviceEpoch: endpoint.serviceEpoch,
      };
      writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), recorded);
      return { connected: true, origin: recorded.origin, endpoint: recorded, payloadDir: home, toolsDir: home };
    },
  }));
  try {
    await runtime.beginDesktopLaunch();
    const failed = await untilPhase(runtime, "failed");
    assert.equal(startupReads, 1);
    assert.deepEqual(failed.failure, {
      stage: "endpoint",
      primaryReason: "PRIMARY_MANAGER_FAILURE",
      cleanupReason: "SECONDARY_STOP_FAILURE",
      instanceRetained: true,
    });
    assert.match(failed.reasons.join(" "), /PRIMARY_MANAGER_FAILURE/);
    assert.match(failed.reasons.join(" "), /SECONDARY_STOP_FAILURE/);
    await runtime.beginDesktopLaunch();
    assert.equal(startupReads, 1);
  } finally { lease?.release(); }
});

test("a single failed startup read does not claim the launch was stopped or cleaned", async () => {
  const home = freshHome("observe-fail-");
  let stateReads = 0;
  let startupReads = 0;
  let endpoint: { serviceEpoch: string } | undefined;
  let lease: HomeControlHandle | undefined;
  const runtime = new WorkbenchHostRuntime(desktopOptions(home, {
    connect: () => ({
      state: async () => { stateReads++; throw new Error("token=fixture-secret disconnected"); },
      startupStatus: async () => { startupReads++; throw new Error("second read"); },
    }) as never,
    bootstrap: async () => {
      lease = new HomeLease(home, { allowRealHome: false }).acquire("web", "http://127.0.0.1:18465/");
      endpoint = { serviceEpoch: deriveServiceEpoch(lease.owner.nonce) };
      const recorded = {
        origin: "http://127.0.0.1:18465", bearer: "e".repeat(64), protocolVersion: 2 as const,
        homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })), serviceEpoch: endpoint.serviceEpoch,
      };
      writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), recorded);
      return { connected: true, origin: recorded.origin, endpoint: recorded, payloadDir: home, toolsDir: home };
    },
  }));
  try {
    const started = await runtime.beginDesktopLaunch();
    const failed = await untilPhase(runtime, "failed");
    assert.equal(failed.operationId, started.operationId);
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure, null);
    assert.deepEqual(failed.reasons, [STARTUP_READ_FAILED]);
    assert.equal(JSON.stringify(failed).includes("fixture-secret"), false);
    assert.equal(stateReads, 1);
    assert.equal(startupReads, 0);
    assert.equal((await runtime.beginDesktopLaunch()).phase, "failed");
    assert.equal(stateReads, 1);
  } finally { lease?.release(); }
});

test("a failed startupStatus read fails once from state and does not invent a cleanup", async () => {
  const home = freshHome("unsupported-");
  let stateReads = 0;
  let endpoint: { serviceEpoch: string } | undefined;
  let lease: HomeControlHandle | undefined;
  const runtime = new WorkbenchHostRuntime(desktopOptions(home, {
    connect: () => ({
      state: async () => { stateReads++; return managerState(endpoint!.serviceEpoch, "starting"); },
      startupStatus: async () => { throw new Error("startup read unavailable"); },
    }) as never,
    bootstrap: async () => {
      lease = new HomeLease(home, { allowRealHome: false }).acquire("web", "http://127.0.0.1:18466/");
      endpoint = { serviceEpoch: deriveServiceEpoch(lease.owner.nonce) };
      const recorded = {
        origin: "http://127.0.0.1:18466", bearer: "f".repeat(64), protocolVersion: 2 as const,
        homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })), serviceEpoch: endpoint.serviceEpoch,
      };
      writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), recorded);
      return { connected: true, origin: recorded.origin, endpoint: recorded, payloadDir: home, toolsDir: home };
    },
  }));
  try {
    await runtime.beginDesktopLaunch();
    const failed = await untilPhase(runtime, "failed");
    assert.equal(stateReads, 1);
    assert.equal(failed.failure, null);
    assert.deepEqual(failed.reasons, [STARTUP_READ_FAILED]);
  } finally { lease?.release(); }
});

test("a healthy existing service becomes ready from state without startupStatus or a page credential", async () => {
  const home = freshHome("healthy-");
  const origin = "http://127.0.0.1:18467";
  const lease = new HomeLease(home, { allowRealHome: false }).acquire("web", `${origin}/`);
  const endpoint = {
    origin, bearer: "a".repeat(64), protocolVersion: 2 as const,
    homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
    serviceEpoch: deriveServiceEpoch(lease.owner.nonce),
  };
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME), { recursive: true });
  writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), endpoint);
  let startupReads = 0;
  let bootstraps = 0;
  const requests: string[] = [];
  const runtime = new WorkbenchHostRuntime(desktopOptions(home, {
    connect: () => ({
      state: async () => managerState(endpoint.serviceEpoch),
      startupStatus: async () => { startupReads++; throw new Error("healthy state must not read startup"); },
    }) as never,
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/internal/bootstrap")) return Response.json({ url: `${origin}/bootstrap/${"p".repeat(24)}` });
      assert.equal(url.endsWith("/api/workbench/state"), true);
      return Response.json({ ok: true, value: managerState(endpoint.serviceEpoch) });
    },
    bootstrap: async () => { bootstraps++; throw new Error("existing service must not cold start"); },
  }));
  try {
    await runtime.beginDesktopLaunch();
    const ready = await untilPhase(runtime, "ready");
    assert.equal(ready.serviceEpoch, endpoint.serviceEpoch);
    assert.equal(startupReads, 0);
    assert.equal(bootstraps, 0);
    assert.equal(requests.some((url) => url.includes("/internal/bootstrap")), false);
    const opened = await runtime.initialize();
    assert.equal(opened.ok, true);
    assert.match(opened.path ?? "", /^\/bootstrap\//);
    assert.equal(requests.filter((url) => url.includes("/internal/bootstrap")).length, 1);
    assert.equal(bootstraps, 0);
  } finally { lease.release(() => unlinkSync(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE))); }
});

test("startup progress is visible once, then a running manager finishes without another status read", async () => {
  const home = freshHome("progress-");
  let startupReads = 0;
  let releaseRunning = (): void => undefined;
  const runningGate = new Promise<void>((resolve) => { releaseRunning = resolve; });
  let endpoint: { serviceEpoch: string } | undefined;
  let lease: HomeControlHandle | undefined;
  const runtime = new WorkbenchHostRuntime(desktopOptions(home, {
    connect: () => ({
      state: async () => {
        if (startupReads === 0) return managerState(endpoint!.serviceEpoch, "starting");
        await runningGate;
        return managerState(endpoint!.serviceEpoch);
      },
      startupStatus: async () => {
        startupReads++;
        return { serviceEpoch: endpoint!.serviceEpoch, managerId: "spaces-hub", phase: "starting", reasons: ["MANAGER_PROGRESS"], failure: null };
      },
    }) as never,
    bootstrap: async () => {
      lease = new HomeLease(home, { allowRealHome: false }).acquire("web", "http://127.0.0.1:18468/");
      endpoint = { serviceEpoch: deriveServiceEpoch(lease.owner.nonce) };
      const recorded = {
        origin: "http://127.0.0.1:18468", bearer: "b".repeat(64), protocolVersion: 2 as const,
        homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })), serviceEpoch: endpoint.serviceEpoch,
      };
      writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), recorded);
      return { connected: true, origin: recorded.origin, endpoint: recorded, payloadDir: home, toolsDir: home };
    },
  }));
  try {
    await runtime.beginDesktopLaunch();
    let starting: DesktopLaunchState | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      starting = await runtime.desktopLaunchState();
      if (starting.reasons.includes("MANAGER_PROGRESS")) break;
      if (starting.phase === "failed" || starting.phase === "ready") throw new Error(JSON.stringify(starting));
      await delay(20);
    }
    assert.equal(starting?.phase, "starting");
    assert.deepEqual(starting?.reasons, ["MANAGER_PROGRESS"]);
    releaseRunning();
    const ready = await untilPhase(runtime, "ready");
    assert.equal(ready.reasons.length, 0);
    assert.equal(startupReads, 1);
  } finally {
    releaseRunning();
    lease?.release();
  }
});

test("web and child identities are rejected before any launch write", async () => {
  for (const profile of ["web", "coding"]) {
    const home = freshHome(`${profile}-`);
    const dir = join(home, "profiles", profile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    const bin = writeCli(home);
    let bootstraps = 0;
    const runtime = new WorkbenchHostRuntime({
      home, allowRealHome: false, argv: [process.execPath, bin, "--profile", profile], env: { DSH_HOME: home },
      execPath: process.execPath, baseUrl: pathToFileURL(dir).href + "/",
      bootstrap: async () => { bootstraps++; throw new Error("must not start"); },
    });
    assert.equal(runtime.qualifiesForAutomaticDesktopLaunch(), false);
    await assert.rejects(runtime.beginDesktopLaunch(), /confirmed Desktop/);
    await assert.rejects(runtime.desktopLaunchState(), /confirmed Desktop/);
    assert.equal(bootstraps, 0);
  }
});

test("different homes keep independent launch records", async () => {
  const homes = [freshHome("home-a-"), freshHome("home-b-")];
  const leases: HomeControlHandle[] = [];
  const counts = new Map<string, number>();
  const runtimes = homes.map((home) => {
    let epoch = "";
    return new WorkbenchHostRuntime(desktopOptions(home, {
      connect: () => ({ state: async () => managerState(epoch) }) as never,
      bootstrap: async () => {
        counts.set(home, (counts.get(home) ?? 0) + 1);
        const lease = new HomeLease(home, { allowRealHome: false }).acquire("web", "http://127.0.0.1:18469/");
        leases.push(lease);
        epoch = deriveServiceEpoch(lease.owner.nonce);
        const endpoint = {
          origin: "http://127.0.0.1:18469", bearer: "c".repeat(64), protocolVersion: 2 as const,
          homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
          serviceEpoch: epoch,
        };
        writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), endpoint);
        return { connected: true, origin: endpoint.origin, endpoint, payloadDir: home, toolsDir: home };
      },
    }));
  });
  try {
    await Promise.all(runtimes.map((runtime) => runtime.beginDesktopLaunch()));
    const ready = await Promise.all(runtimes.map((runtime) => untilPhase(runtime, "ready")));
    assert.notEqual(ready[0]?.operationId, ready[1]?.operationId);
    assert.deepEqual([...counts.values()], [1, 1]);
  } finally {
    for (const lease of leases) lease.release();
  }
});

test("registration failure is terminal, and a later durable stop keeps that reason", async () => {
  const home = freshHome("attach-fail-");
  let bootstraps = 0;
  let attachments = 0;
  const requests: string[] = [];
  const submitted: string[] = [];
  let endpoint: { origin: string; bearer: string; protocolVersion: 2; homeId: string; serviceEpoch: string } | undefined;
  let lease: HomeControlHandle | null = null;
  const state = () => ({
    ...managerState(endpoint!.serviceEpoch),
    revision: "d".repeat(64),
    spaces: [
      ...managerState(endpoint!.serviceEpoch).spaces,
      { id: "child-one", displayName: "Child", isHost: false, hasWebApp: true, icon: "", status: "stopped", generation: 0, managed: true, dshVersion: null, startWithDesktop: false },
    ],
  });
  const runtime = new WorkbenchHostRuntime(desktopOptions(home, {
    connect: () => ({
      state: async () => state(),
      startupStatus: async () => ({ serviceEpoch: endpoint!.serviceEpoch, managerId: "spaces-hub", phase: "ready", reasons: [], failure: null }),
      preview: async () => ({
        id: "plan-1", kind: "service.shutdown", serviceEpoch: endpoint!.serviceEpoch, stateRevision: "d".repeat(64),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), affectedSpaceIds: ["spaces-hub", "child-one"], runningSpaceIds: ["spaces-hub"],
      }),
      submit: async (command: { kind: string }, requestId: string) => {
        submitted.push(command.kind);
        const id = "shutdown-1";
        const jobs = join(home, HOME_CONTROL_DIR_NAME, "jobs");
        mkdirSync(jobs, { recursive: true });
        writeFileSync(join(jobs, `${id}.json`), JSON.stringify({ schemaVersion: 1, id, requestId, command, status: "succeeded" }));
        lease?.release(() => unlinkSync(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE)));
        lease = null;
        return { schemaVersion: 1, id, requestId, command, status: "succeeded" };
      },
    }) as never,
    fetch: async (input) => {
      requests.push(String(input));
      assert.equal(String(input).endsWith("/api/workbench/state"), true);
      return Response.json({ ok: true, value: state() });
    },
    bootstrap: async (request) => {
      bootstraps++;
      request.progress?.("prepare");
      request.progress?.("launch");
      const handle = new HomeLease(home, { allowRealHome: false }).acquire("web", "http://127.0.0.1:18470/");
      lease = handle;
      endpoint = {
        origin: "http://127.0.0.1:18470", bearer: "c".repeat(64), protocolVersion: 2,
        homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
        serviceEpoch: deriveServiceEpoch(handle.owner.nonce),
      };
      writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), endpoint);
      return { connected: true, origin: endpoint.origin, endpoint, payloadDir: home, toolsDir: home };
    },
  }));
  runtime.onSupervisorAttached(async () => {
    attachments++;
    throw new Error("MAIN_REGISTRATION_FAILURE token=fixture-secret");
  });
  try {
    const started = await runtime.beginDesktopLaunch();
    const failed = await untilPhase(runtime, "failed");
    assert.equal(attachments, 1);
    assert.equal(bootstraps, 1);
    assert.match(failed.reasons.join(" "), /MAIN_REGISTRATION_FAILURE/);
    assert.equal(JSON.stringify(failed).includes("fixture-secret"), false);
    assert.equal(failed.failure, null);
    await runtime.beginDesktopLaunch();
    assert.equal(attachments, 1);
    const preview = await runtime.previewServiceStop();
    await runtime.stopService(preview.confirmationId);
    const stopped = await runtime.desktopLaunchState();
    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.operationId, started.operationId);
    assert.match(stopped.reasons.join(" "), /MAIN_REGISTRATION_FAILURE/);
    assert.equal((await new WorkbenchHostRuntime(desktopOptions(home)).beginDesktopLaunch()).phase, "stopped");
    assert.equal(bootstraps, 1);
    assert.deepEqual(submitted, ["plan.execute"]);
    assert.equal(requests.every((url) => url.endsWith("/api/workbench/state")), true);
  } finally {
    const current = lease as HomeControlHandle | null;
    current?.release();
  }
});

test("confirmed manual launch is the only path that replaces a stopped record", async () => {
  const home = freshHome("manual-");
  let bootstraps = 0;
  let attachments = 0;
  let lateAttachments = 0;
  const requests: string[] = [];
  const submitted: string[] = [];
  let endpoint: { origin: string; bearer: string; protocolVersion: 2; homeId: string; serviceEpoch: string } | undefined;
  let lease: HomeControlHandle | null = null;
  let plans = 0;
  const state = () => ({
    ...managerState(endpoint!.serviceEpoch),
    revision: "d".repeat(64),
    spaces: [
      ...managerState(endpoint!.serviceEpoch).spaces,
      { id: "child-one", displayName: "Child", isHost: false, hasWebApp: true, icon: "", status: "stopped", generation: 0, managed: true, dshVersion: null, startWithDesktop: false },
    ],
  });
  const options = desktopOptions(home, {
    connect: () => ({
      state: async () => state(),
      startupStatus: async () => ({ serviceEpoch: endpoint!.serviceEpoch, managerId: "spaces-hub", phase: "ready", reasons: [], failure: null }),
      preview: async (request: { kind: string }) => {
        assert.equal(request.kind, "service.shutdown");
        plans++;
        return {
          id: `plan-${plans}`, kind: "service.shutdown", serviceEpoch: endpoint!.serviceEpoch, stateRevision: "d".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString(), affectedSpaceIds: ["spaces-hub", "child-one"], runningSpaceIds: ["spaces-hub"],
        };
      },
      submit: async (command: { kind: string }, requestId: string) => {
        submitted.push(command.kind);
        const id = `shutdown-${submitted.length}`;
        const jobs = join(home, HOME_CONTROL_DIR_NAME, "jobs");
        mkdirSync(jobs, { recursive: true });
        writeFileSync(join(jobs, `${id}.json`), JSON.stringify({ schemaVersion: 1, id, requestId, command, status: "succeeded" }));
        lease?.release(() => unlinkSync(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE)));
        lease = null;
        return { schemaVersion: 1, id, requestId, command, status: "succeeded" };
      },
    }) as never,
    fetch: async (input) => {
      requests.push(String(input));
      assert.equal(String(input).endsWith("/api/workbench/state"), true);
      return Response.json({ ok: true, value: state() });
    },
    bootstrap: async (request) => {
      bootstraps++;
      request.progress?.("prepare");
      request.progress?.("launch");
      const handle = new HomeLease(home, { allowRealHome: false }).acquire("web", "http://127.0.0.1:18471/");
      assert.equal(request.startDesktopSpaces, bootstraps === 1, "only opening Desktop starts selected child spaces; manual service launches do not");
      lease = handle;
      endpoint = {
        origin: "http://127.0.0.1:18471", bearer: "c".repeat(64), protocolVersion: 2,
        homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
        serviceEpoch: deriveServiceEpoch(handle.owner.nonce),
      };
      writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), endpoint);
      return { connected: true, origin: endpoint.origin, endpoint, payloadDir: home, toolsDir: home };
    },
  });
  const first = new WorkbenchHostRuntime(options);
  first.onSupervisorAttached(async () => { attachments++; });
  try {
    const initial = await first.beginDesktopLaunch();
    await untilPhase(first, "ready");
    assert.equal(bootstraps, 1);
    assert.equal(attachments, 1);
    first.onSupervisorAttached(async () => { lateAttachments++; });
    for (let attempt = 0; attempt < 100 && lateAttachments === 0; attempt++) await delay(10);
    assert.equal(lateAttachments, 1);
    await first.beginDesktopLaunch();
    assert.equal(lateAttachments, 1);
    const stop = await first.previewServiceStop();
    await first.stopService(stop.confirmationId);
    const stopped = await first.desktopLaunchState();
    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.operationId, initial.operationId);
    const remounted = new WorkbenchHostRuntime(options);
    assert.equal((await remounted.beginDesktopLaunch()).phase, "stopped");
    assert.equal((await remounted.initialize()).ok, false);
    assert.equal(bootstraps, 1);
    await assert.rejects(first.restartService("f".repeat(64)), /invalid or expired/);
    assert.equal((await first.desktopLaunchState()).operationId, initial.operationId);
    const manual = await first.previewServiceRestart();
    assert.equal(manual.action, "start");
    assert.equal((await first.restartService(manual.confirmationId)).connected, true);
    const next = await untilPhase(first, "ready");
    assert.notEqual(next.operationId, initial.operationId);
    assert.equal(bootstraps, 2);
    assert.equal(attachments, 2);
    assert.equal(lateAttachments, 2);
    assert.equal((await remounted.beginDesktopLaunch()).operationId, next.operationId);
    assert.deepEqual(submitted, ["plan.execute"]);
    assert.equal(requests.every((url) => url.endsWith("/api/workbench/state")), true);
    assert.equal(requests.some((url) => url.includes("/internal/bootstrap")), false);
  } finally {
    const current = lease as HomeControlHandle | null;
    current?.release();
  }
});

test("manager host bootstrap does not wait for its own startup", async () => {
  const home = freshHome("manager-host-");
  const profile = join(home, "profiles", "spaces-hub");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "package.json"), "{}");
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), JSON.stringify({ version: 1, profileId: "spaces-hub", createdAt: "2026-11-01T00:00:00.000Z" }));
  const bin = writeCli(home);
  let reads = 0;
  const runtime = new WorkbenchHostRuntime({
    home, allowRealHome: false, argv: [process.execPath, bin, "--profile", "spaces-hub"], env: { DSH_HOME: home },
    execPath: process.execPath, baseUrl: pathToFileURL(profile).href + "/", supervisorTimeoutMs: 2000,
    connect: () => ({
      state: async () => { reads++; return new Promise(() => undefined); },
      startupStatus: async () => { reads++; return new Promise(() => undefined); },
    }) as never,
    bootstrap: async () => ({
      connected: true, origin: "http://127.0.0.1:9", payloadDir: home, toolsDir: home,
      endpoint: { origin: "http://127.0.0.1:9", bearer: "b".repeat(32), protocolVersion: 2, homeId: "h".repeat(64), serviceEpoch: "a".repeat(64) },
    }),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    runtime.bootstrap(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("manager bootstrap waited")), 500); }),
  ]);
  clearTimeout(timer);
  assert.equal(result.connected, true);
  assert.equal(reads, 0);
  assert.equal(runtime.qualifiesForAutomaticDesktopLaunch(), false);
});

test("desktop workspace identity passes exitWithHost to the cold-start bootstrap; other profiles do not", async () => {
  const home = freshHome("exit-host-");
  const seen: Array<boolean | undefined> = [];
  const bootstrap = async (request: { exitWithHost?: boolean }) => {
    seen.push(request.exitWithHost);
    return {
      connected: true, origin: "http://127.0.0.1:9", payloadDir: home, toolsDir: home,
      endpoint: { origin: "http://127.0.0.1:9", bearer: "b".repeat(32), protocolVersion: 2 as const, homeId: "h".repeat(64), serviceEpoch: "a".repeat(64) },
    };
  };
  const desktop = new WorkbenchHostRuntime(desktopOptions(home, { bootstrap: bootstrap as never }));
  assert.equal((await desktop.bootstrap()).connected, true);
  assert.equal(seen.at(-1), true);

  const coding = join(home, "profiles", "coding");
  mkdirSync(coding, { recursive: true });
  writeFileSync(join(coding, "package.json"), JSON.stringify({ name: "isolated-coding-fixture" }));
  const bin = join(home, "bin.js");
  const other = new WorkbenchHostRuntime(desktopOptions(home, {
    argv: [process.execPath, bin, "--profile", "coding"],
    baseUrl: pathToFileURL(coding).href + "/",
    bootstrap: bootstrap as never,
  }));
  assert.equal((await other.bootstrap()).connected, true);
  assert.equal(seen.at(-1), false);
});
