import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DesktopServiceClient,
  DesktopServiceClientError,
  type DesktopAttachResult,
  type DesktopServiceClientOptions,
  type DesktopSupervisorEndpoint,
} from "../src/adapters/desktop/service-client.ts";
import { createDesktopStartup } from "../src/main/desktop-startup.ts";
import type { SupervisorBootstrapOptions, SupervisorBootstrapResult } from "../packages/plugin/src/host/supervisor-bootstrap.ts";

const CLIENT_SOURCE = fileURLToPath(new URL("../src/adapters/desktop/service-client.ts", import.meta.url));
const ORIGIN = "http://127.0.0.1:9";
const BEARER = "B".repeat(32);
const TOKEN = "c".repeat(32);
const HOME = join(tmpdir(), "dsh-desktop-client-home");
const PAYLOAD = join(tmpdir(), "dsh-desktop-client-payload");
const NODE_EXE = join(tmpdir(), "verified-node.exe");
const CLI_BIN = join(tmpdir(), "verified-cli", "bin.js");

const STATE_VALUE = {
  protocolVersion: 2,
  serviceEpoch: "a".repeat(64),
  revision: "b".repeat(64),
  availability: "ready",
  role: "manager",
  managerId: "spaces-hub",
  owner: null,
  writable: true,
  mode: "verified-full",
  dshVersion: "0.1.5-rc.1",
  maintenance: false,
  reasons: [],
  spaces: [],
  jobs: [],
};

function endpoint(extra: Partial<DesktopSupervisorEndpoint> = {}): DesktopSupervisorEndpoint {
  return { origin: ORIGIN, bearer: BEARER, ...extra };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function connectedBoot(extra: Partial<DesktopSupervisorEndpoint> = {}): SupervisorBootstrapResult {
  const row = endpoint(extra);
  return {
    connected: true,
    origin: row.origin,
    endpoint: row,
    payloadDir: join(tmpdir(), "payload-copy"),
    toolsDir: join(tmpdir(), "tools-copy"),
  };
}

function client(
  overrides: Partial<DesktopServiceClientOptions> & {
    attachResult?: DesktopAttachResult;
    attach?: DesktopServiceClientOptions["attach"];
    bootstrap?: DesktopServiceClientOptions["bootstrap"];
    bootstraps?: SupervisorBootstrapOptions[];
    fetches?: string[];
  } = {},
): DesktopServiceClient {
  const bootstraps = overrides.bootstraps ?? [];
  const fetches = overrides.fetches ?? [];
  return new DesktopServiceClient({
    home: HOME,
    payloadRoot: PAYLOAD,
    allowRealHome: false,
    attach:
      overrides.attach ??
      (async () => overrides.attachResult ?? { missing: true as const }),
    bootstrap:
      overrides.bootstrap ??
      (async (options) => {
        bootstraps.push(options);
        return { connected: false, origin: null, reasons: ["bootstrap was not expected"] };
      }),
    fetch:
      overrides.fetch ??
      (async (input) => {
        fetches.push(String(input));
        return new Response("{}", { status: 500 });
      }),
    handoff: overrides.handoff,
    toolsRoot: overrides.toolsRoot,
    snapshotRoot: overrides.snapshotRoot,
  });
}

test("source stays Node-only and does not own supervisor lifecycle or product services", () => {
  const source = readFileSync(CLIENT_SOURCE, "utf8");
  assert.equal(/from ["']electron["']/.test(source), false);
  assert.equal(/require\(["']electron["']\)/.test(source), false);
  assert.equal(/ProfileRegistry|ProcessManager|RuntimeStore|DesktopLlmHost|CoordinatedUpgrade/.test(source), false);
  assert.equal(/reclaimDead|snapshot\.restore|service\.shutdown/.test(source), false);
});

test("constructor requires a home and controlled payload root", () => {
  assert.throws(
    () => new DesktopServiceClient({ home: "", payloadRoot: PAYLOAD }),
    DesktopServiceClientError,
  );
  assert.throws(
    () => new DesktopServiceClient({ home: HOME, payloadRoot: "  " }),
    DesktopServiceClientError,
  );
});

test("healthy attach connects without spawning", async () => {
  const bootstraps: SupervisorBootstrapOptions[] = [];
  const service = client({ attachResult: { endpoint: endpoint() }, bootstraps });
  assert.equal(service.publicState().status, "idle");
  const state = await service.connect();
  assert.equal(state.status, "connected");
  assert.deepEqual(state.reasons, []);
  assert.equal(bootstraps.length, 0);
  assert.equal(typeof service.getApi().state, "function");
  assert.equal(typeof service.getApi().submit, "function");
});

test("connect without a service does not spawn", async () => {
  const bootstraps: SupervisorBootstrapOptions[] = [];
  const service = client({ attachResult: { missing: true }, bootstraps });
  const state = await service.connect();
  assert.equal(state.status, "stopped");
  assert.deepEqual(state.reasons, []);
  assert.equal(bootstraps.length, 0);
  assert.throws(() => service.getApi(), DesktopServiceClientError);
});

test("explicit start bootstraps once with argv array and controlled payload", async () => {
  const bootstraps: SupervisorBootstrapOptions[] = [];
  const service = client({
    attachResult: { missing: true },
    toolsRoot: join(tmpdir(), "desk-tools"),
    snapshotRoot: join(tmpdir(), "desk-snapshots"),
    bootstrap: async (options) => {
      bootstraps.push(options);
      return connectedBoot();
    },
  });
  const state = await service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(state.status, "connected");
  assert.equal(bootstraps.length, 1);
  assert.deepEqual(bootstraps[0]?.argv, [NODE_EXE, CLI_BIN]);
  assert.equal(bootstraps[0]?.execPath, NODE_EXE);
  assert.equal(bootstraps[0]?.payloadRoot, PAYLOAD);
  assert.equal(bootstraps[0]?.allowColdStart, true);
  assert.equal(bootstraps[0]?.allowRealHome, false);
  assert.equal(bootstraps[0]?.home, HOME);
  assert.equal(bootstraps[0]?.spawn, undefined);
  await service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(bootstraps.length, 1);
});

test("two concurrent starts share one bootstrap", async () => {
  const boot = deferred<SupervisorBootstrapResult>();
  let boots = 0;
  const service = client({
    attachResult: { missing: true },
    bootstrap: async () => {
      boots += 1;
      return boot.promise;
    },
  });
  const first = service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  const second = service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(service.publicState().status, "connecting");
  boot.resolve(connectedBoot());
  const states = await Promise.all([first, second]);
  assert.equal(boots, 1);
  assert.deepEqual(states.map((row) => row.status), ["connected", "connected"]);
});

test("blocked helper results are rejected as-is and never bootstrap", async () => {
  const cases: Array<{ result: DesktopAttachResult; reasons: string[] }> = [
    {
      result: {
        blocked: true,
        reasons: ["A different controller already holds the workbench endpoint."],
      },
      reasons: ["A different controller already holds the workbench endpoint."],
    },
    {
      result: {
        blocked: true,
        reasons: ["The recorded controller is dead. The lease was not cleared."],
      },
      reasons: ["The recorded controller is dead. The lease was not cleared."],
    },
    {
      result: {
        stale: true,
        reasons: ["The recorded supervisor endpoint did not accept a private bearer state ping."],
      },
      reasons: ["The recorded supervisor endpoint did not accept a private bearer state ping."],
    },
    {
      result: {
        blocked: true,
        reasons: ["The supervisor protocol is not supported."],
      },
      reasons: ["The supervisor protocol is not supported."],
    }, // blocked-reason forwarding only; not a v2 endpoint helper
  ];
  for (const row of cases) {
    const bootstraps: SupervisorBootstrapOptions[] = [];
    const service = client({ attachResult: row.result, bootstraps });
    const state = await service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
    assert.equal(state.status, "unavailable");
    assert.deepEqual(state.reasons, row.reasons);
    assert.equal(bootstraps.length, 0);
  }
});

test("identity-unknown attach is not treated as absent", async () => {
  const bootstraps: SupervisorBootstrapOptions[] = [];
  const reasons = ["Controller ownership is incomplete or ambiguous. The lease was not cleared."];
  const service = client({
    attach: async () => ({ identity: "unknown" }) as unknown as DesktopAttachResult,
    bootstraps,
  });
  const unknown = await service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(unknown.status, "unavailable");
  assert.equal(bootstraps.length, 0);

  const blocked = client({
    attachResult: { blocked: true, reasons },
    bootstraps,
  });
  const state = await blocked.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(state.status, "unavailable");
  assert.deepEqual(state.reasons, reasons);
  assert.equal(bootstraps.length, 0);
});

test("attach exception does not fall back to bootstrap", async () => {
  const bootstraps: SupervisorBootstrapOptions[] = [];
  const service = client({
    attach: async () => {
      throw new Error(`attach failed Bearer ${BEARER} at ${HOME}`);
    },
    bootstraps,
  });
  const state = await service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(state.status, "unavailable");
  assert.equal(bootstraps.length, 0);
  assert.ok(state.reasons.length);
  const json = JSON.stringify(state);
  assert.equal(json.includes(BEARER), false);
  assert.equal(json.includes(HOME), false);
  assert.equal(json.toLowerCase().includes("bearer [redacted]"), true);
});

test("bootstrap exception does not retry attach or spawn again", async () => {
  let attaches = 0;
  let boots = 0;
  const service = client({
    attach: async () => {
      attaches += 1;
      return { missing: true };
    },
    bootstrap: async () => {
      boots += 1;
      throw new Error(`spawn failed token=${TOKEN} path=${PAYLOAD}`);
    },
  });
  const state = await service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(state.status, "unavailable");
  assert.equal(attaches, 1);
  assert.equal(boots, 1);
  const json = JSON.stringify(service.publicState());
  assert.equal(json.includes(TOKEN), false);
  assert.equal(json.includes(PAYLOAD), false);
});

test("dispose during inflight start ignores a late success and never shuts down", async () => {
  const entered = deferred<void>();
  const boot = deferred<SupervisorBootstrapResult>();
  const fetches: string[] = [];
  let boots = 0;
  const service = client({
    attachResult: { missing: true },
    fetches,
    bootstrap: async () => {
      boots += 1;
      entered.resolve();
      return boot.promise;
    },
  });
  const pending = service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  await entered.promise;
  service.dispose();
  boot.resolve(connectedBoot());
  const state = await pending;
  assert.equal(state.status, "idle");
  assert.deepEqual(state.reasons, []);
  assert.equal(boots, 1);
  assert.equal(fetches.length, 0);
  assert.throws(() => service.getApi(), DesktopServiceClientError);
  await assert.rejects(() => service.entryUrl(), DesktopServiceClientError);
  const again = await service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(again.status, "idle");
  assert.equal(boots, 1);
});

test("publicState JSON has no bearer, token, or raw path", async () => {
  const service = client({
    attach: async () => {
      throw new Error(`Authorization: Bearer ${BEARER} file=${HOME}\\secret.txt token=${TOKEN}`);
    },
  });
  const state = await service.connect();
  assert.equal(state.status, "unavailable");
  const json = JSON.stringify(service.publicState());
  assert.equal(Object.keys(service.publicState()).sort().join(","), "reasons,status");
  assert.equal(json.includes(BEARER), false);
  assert.equal(json.includes(TOKEN), false);
  assert.equal(json.includes(HOME), false);
  assert.equal(json.includes("secret.txt"), false);
  assert.equal(json.includes(PAYLOAD), false);
});

test("entryUrl accepts loopback handoff paths and rejects arbitrary navigation", async () => {
  const service = client({
    attachResult: { endpoint: endpoint() },
    handoff: async () => `/bootstrap/${TOKEN}`,
  });
  await service.connect();
  assert.equal(await service.entryUrl(), `${ORIGIN}/bootstrap/${TOKEN}`);

  const full = client({
    attachResult: { endpoint: endpoint() },
    handoff: async () => `${ORIGIN}/bootstrap/${TOKEN}`,
  });
  await full.connect();
  assert.equal(await full.entryUrl(), `${ORIGIN}/bootstrap/${TOKEN}`);

  const evil = client({
    attachResult: { endpoint: endpoint() },
    handoff: async () => `https://example.com/bootstrap/${TOKEN}`,
  });
  await evil.connect();
  await assert.rejects(() => evil.entryUrl(), DesktopServiceClientError);
  assert.equal(evil.publicState().status, "connected");

  const otherPath = client({
    attachResult: { endpoint: endpoint() },
    handoff: async () => `${ORIGIN}/internal/bootstrap`,
  });
  await otherPath.connect();
  await assert.rejects(() => otherPath.entryUrl(), DesktopServiceClientError);
});

test("dispose during deferred handoff rejects and does not return a token URL or shutdown", async () => {
  const entered = deferred<void>();
  const handoff = deferred<string>();
  const fetches: string[] = [];
  const bootstraps: SupervisorBootstrapOptions[] = [];
  const service = client({
    attachResult: { endpoint: endpoint() },
    fetches,
    bootstraps,
    handoff: async () => {
      entered.resolve();
      return handoff.promise;
    },
  });
  await service.connect();
  const pending = service.entryUrl();
  await entered.promise;
  service.dispose();
  handoff.resolve(`/bootstrap/${TOKEN}`);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DesktopServiceClientError);
    assert.equal(error.message, "The workbench entry is not available yet.");
    assert.equal(String(error).includes(TOKEN), false);
    assert.equal(JSON.stringify(error).includes("/bootstrap/"), false);
    return true;
  });
  assert.equal(service.publicState().status, "idle");
  assert.equal(bootstraps.length, 0);
  assert.equal(fetches.some((url) => /shutdown|stop/i.test(url)), false);
  assert.throws(() => service.getApi(), DesktopServiceClientError);
});

test("getApi uses the HTTP client after attach and does not treat extra endpoint fields as protocol proof", async () => {
  const seen: string[] = [];
  const service = new DesktopServiceClient({
    home: HOME,
    payloadRoot: PAYLOAD,
    attach: async () => ({
      endpoint: endpoint({ protocol: 2, serviceEpoch: "epoch-1", homeId: "home-digest" }),
    }),
    bootstrap: async () => {
      throw new Error("bootstrap must not run for getApi");
    },
    fetch: async (input, init) => {
      seen.push(String(input));
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.authorization, `Bearer ${BEARER}`);
      return new Response(JSON.stringify({ ok: true, value: STATE_VALUE }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await service.connect();
  const state = await service.getApi().state();
  assert.equal(state.role, "manager");
  assert.equal(seen.length, 1);
  assert.equal(seen[0], `${ORIGIN}/api/workbench/state`);
  assert.equal(JSON.stringify(service.publicState()).includes(BEARER), false);
  assert.equal(JSON.stringify(service.publicState()).includes("epoch-1"), false);
});

test("concurrent connect and start still spawn at most once", async () => {
  const attach = deferred<DesktopAttachResult>();
  let boots = 0;
  const service = client({
    attach: async () => attach.promise,
    bootstrap: async () => {
      boots += 1;
      return connectedBoot();
    },
  });
  const connecting = service.connect();
  const starting = service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  attach.resolve({ missing: true });
  const states = await Promise.all([connecting, starting]);
  assert.equal(boots, 1);
  assert.ok(states.every((row) => row.status === "connected"));
});

test("start does not bootstrap when attach already found a healthy service", async () => {
  const bootstraps: SupervisorBootstrapOptions[] = [];
  const service = client({ attachResult: { endpoint: endpoint() }, bootstraps });
  const state = await service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(state.status, "connected");
  assert.equal(bootstraps.length, 0);
});


test("desktop launch uses the real client's attach-then-start path without a manual click", async () => {
  const bootstraps: SupervisorBootstrapOptions[] = [];
  const service = client({ bootstrap: async (options) => {
    bootstraps.push(options);
    return connectedBoot();
  }});
  const startup = createDesktopStartup({
    connect: async () => { await service.connect(); },
    status: () => service.publicState().status,
    canStart: () => true,
    start: () => service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN }),
  });
  await startup.open();
  assert.equal(service.publicState().status, "connected");
  assert.equal(bootstraps.length, 1);
  assert.equal(bootstraps[0].allowColdStart, true);
  await startup.environmentPrepared();
  assert.equal(bootstraps.length, 1);
});

test("first installation continues from a normal stopped client into the workbench", async () => {
  let ready = false;
  let boots = 0;
  const service = client({ bootstrap: async () => { boots += 1; return connectedBoot(); } });
  const startup = createDesktopStartup({
    connect: async () => { await service.connect(); },
    status: () => service.publicState().status,
    canStart: () => ready,
    start: () => service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN }),
  });
  await startup.open();
  assert.deepEqual(service.publicState(), { status: "stopped", reasons: [] });
  assert.equal(boots, 0);
  ready = true;
  await startup.environmentPrepared();
  assert.equal(service.publicState().status, "connected");
  assert.equal(boots, 1);
});

test("automatic launch preserves real blocked and stale reasons without bootstrapping", async () => {
  for (const attached of [
    { blocked: true, reasons: ["A different controller already holds the workbench endpoint."] },
    { blocked: true, reasons: ["The supervisor protocol is not supported."] },
    { stale: true, reasons: ["The recorded supervisor endpoint did not accept a private bearer state ping."] },
  ] as DesktopAttachResult[]) {
    const bootstraps: SupervisorBootstrapOptions[] = [];
    const service = client({ attachResult: attached, bootstraps });
    const startup = createDesktopStartup({
      connect: async () => { await service.connect(); },
      status: () => service.publicState().status,
      canStart: () => true,
      start: () => service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN }),
    });
    await startup.open();
    await startup.environmentPrepared();
    assert.equal(service.publicState().status, "unavailable");
    assert.deepEqual(service.publicState().reasons, "reasons" in attached ? attached.reasons : []);
    assert.equal(bootstraps.length, 0);
  }
});

test("a returned bootstrap failure is retained, not converted to stopped or retried", async () => {
  let boots = 0;
  const failure = "Packaged supervisor payload is missing.";
  const service = client({ bootstrap: async () => {
    boots += 1;
    return { connected: false, origin: null, reasons: [failure] };
  }});
  const startup = createDesktopStartup({
    connect: async () => { await service.connect(); },
    status: () => service.publicState().status,
    canStart: () => true,
    start: () => service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN }),
  });
  await startup.open();
  await startup.environmentPrepared();
  await startup.open();
  assert.deepEqual(service.publicState(), { status: "unavailable", reasons: [failure] });
  assert.equal(boots, 1);
});

test("cold start reports startup stages in attach-prepare-launch-connect order", async () => {
  const stages: string[] = [];
  const missing = { missing: true as const };
  let seenPrior: SupervisorBootstrapOptions["priorDiscovery"];
  let seenProgress: SupervisorBootstrapOptions["progress"];
  const service = new DesktopServiceClient({
    home: HOME,
    payloadRoot: PAYLOAD,
    allowRealHome: false,
    attach: async () => missing,
    bootstrap: async (options) => {
      seenPrior = options.priorDiscovery;
      seenProgress = options.progress;
      options.progress?.("launch");
      return connectedBoot();
    },
    onStage: (stage) => stages.push(stage),
  });
  const state = await service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(state.status, "connected");
  assert.deepEqual(stages, ["attach", "prepare", "launch", "connect"]);
  assert.equal(seenPrior, missing);
  assert.equal(typeof seenProgress, "function");
});

test("attaching an existing service reports attach then connect only", async () => {
  const stages: string[] = [];
  const service = new DesktopServiceClient({
    home: HOME,
    payloadRoot: PAYLOAD,
    allowRealHome: false,
    attach: async () => ({ endpoint: endpoint() }),
    bootstrap: async () => {
      throw new Error("bootstrap must not run for a healthy attach");
    },
    onStage: (stage) => stages.push(stage),
  });
  const state = await service.connect();
  assert.equal(state.status, "connected");
  assert.deepEqual(stages, ["attach", "connect"]);
});

test("blocked attach and verified-absence connects report no bootstrap stages", async () => {
  const blockedStages: string[] = [];
  const blocked = new DesktopServiceClient({
    home: HOME,
    payloadRoot: PAYLOAD,
    allowRealHome: false,
    attach: async () => ({ blocked: true, reasons: ["A different controller already holds the workbench endpoint."] }),
    onStage: (stage) => blockedStages.push(stage),
  });
  const blockedState = await blocked.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  assert.equal(blockedState.status, "unavailable");
  assert.deepEqual(blockedStages, ["attach"]);

  const stoppedStages: string[] = [];
  const stopped = new DesktopServiceClient({
    home: HOME,
    payloadRoot: PAYLOAD,
    allowRealHome: false,
    attach: async () => ({ missing: true }),
    onStage: (stage) => stoppedStages.push(stage),
  });
  const stoppedState = await stopped.connect();
  assert.equal(stoppedState.status, "stopped");
  assert.deepEqual(stoppedStages, ["attach"]);
});

test("stages reported after dispose or a superseded generation are suppressed", async () => {
  const stages: string[] = [];
  const boot = deferred<SupervisorBootstrapResult>();
  const entered = deferred<void>();
  const service = new DesktopServiceClient({
    home: HOME,
    payloadRoot: PAYLOAD,
    allowRealHome: false,
    attach: async () => ({ missing: true }),
    bootstrap: async (options) => {
      entered.resolve();
      options.progress?.("launch");
      return boot.promise;
    },
    onStage: (stage) => stages.push(stage),
  });
  const pending = service.start({ nodeExe: NODE_EXE, cliBin: CLI_BIN });
  await entered.promise;
  service.dispose();
  boot.resolve(connectedBoot());
  const state = await pending;
  assert.equal(state.status, "idle");
  assert.deepEqual(stages, ["attach", "prepare", "launch"]);
  assert.equal(stages.includes("connect"), false);
});

