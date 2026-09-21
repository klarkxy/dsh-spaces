import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  consumeBootstrapIfNeeded,
  decideWindowOpen,
  decideWorkbenchNavigation,
  DESKTOP_SHELL_IPC,
  isDesktopShellInvokeChannel,
  isTrustedShellFrame,
  parseClientPreferencePatch,
  publishShellReasons,
  redactDesktopShellText,
  sameTrustedUrl,
} from "../src/shared/desktop-shell.ts";
import {
  assertPlanMatches,
  mutationContextFromState,
  ownedOrdinaryStopTargets,
  shutdownWorkbenchService,
  stopOwnedSpaces,
  waitForJob,
  type ShellWorkbenchPort,
} from "../src/main/desktop-shell-protocol.ts";
import {
  coalesceInflight,
  DESKTOP_SNAPSHOTS_DIRNAME,
  ensureDesktopSnapshotRoot,
  openWorkbenchSession,
  resolveSpacesPayloadRoot,
  SHELL_PRELOAD_FILE,
  shellPreloadPath,
  testRuntimeOverride,
  trustedShellUrl,
  verifiedToolFile,
  type InflightHolder,
} from "../src/main/desktop-shell-runtime.ts";
import { buildTrayMenuItems } from "../src/main/tray.ts";
import { applyAppLocale } from "../src/shared/i18n/index.ts";
import type {
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchSpace,
  WorkbenchState,
} from "../src/shared/workbench.ts";

const temps: string[] = [];
const INDEX_SOURCE = fileURLToPath(new URL("../src/main/index.ts", import.meta.url));
const PRELOAD_SOURCE = fileURLToPath(new URL("../src/preload/index.ts", import.meta.url));
const VIEW_SOURCE = fileURLToPath(new URL("../src/main/view-manager.ts", import.meta.url));
const PROTOCOL_SOURCE = fileURLToPath(new URL("../src/main/desktop-shell-protocol.ts", import.meta.url));
const SHELL_SOURCE = fileURLToPath(new URL("../src/shared/desktop-shell.ts", import.meta.url));
const ORIGIN = "http://127.0.0.1:9";
const BOOTSTRAP = `${ORIGIN}/bootstrap/${"a".repeat(24)}`;
const EPOCH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EPOCH2 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const REV1 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REV2 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";


afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(name: string, body = "ok"): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-shell-"));
  temps.push(dir);
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function space(partial: Partial<WorkbenchSpace> & Pick<WorkbenchSpace, "id">): WorkbenchSpace {
  return {
    displayName: partial.displayName ?? partial.id,
    isHost: false,
    hasWebApp: true,
    status: "running",
    isolation: "verified",
    icon: "",
    generation: 1,
    managed: true,
    needsIsolation: false,
    ...partial,
  };
}

function state(partial: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    protocolVersion: 2,
    serviceEpoch: EPOCH,
    revision: REV1,
    availability: "ready",
    role: "manager",
    managerId: "spaces-hub",
    owner: { kind: "desktop", since: "2026-09-20T00:00:00.000Z" },
    writable: true,
    mode: "verified-full",
    dshVersion: "0.1.5-rc.2",
    maintenance: false,
    reasons: [],
    spaces: [],
    jobs: [],
    ...partial,
  };
}

function plan(partial: Partial<WorkbenchPlan> = {}): WorkbenchPlan {
  return {
    id: "plan-stop",
    kind: "space.stop",
    title: "Stop space",
    scope: "space",
    affectedSpaceIds: [],
    runningSpaceIds: [],
    changes: ["stop"],
    destructive: false,
    expiresAt: "2026-09-20T00:05:00.000Z",
    serviceEpoch: EPOCH,
    stateRevision: REV1,
    ...partial,
  };
}

function job(partial: Partial<WorkbenchJob> = {}): WorkbenchJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    requestId: "22222222-2222-4222-8222-222222222222",
    kind: "plan.execute",
    status: "succeeded",
    phase: "done",
    message: "stopped",
    affectedSpaceIds: [],
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:01.000Z",
    canCancel: false,
    result: { spaceId: "coding" },
    ...partial,
  };
}

function context(revision = REV1): WorkbenchMutationContext {
  return { serviceEpoch: EPOCH, expectedRevision: revision };
}

test("desktop shell source no longer assembles the old Home writers", () => {
  const source = readFileSync(INDEX_SOURCE, "utf8");
  assert.equal(/ProfileRegistry|ProcessManager|RuntimeStore|CoordinatedUpgrade|DesktopLlmHost|createDesktopLlmHost|createDesktopController/.test(source), false);
  assert.equal(/stopAll\(|reclaimDead|snapshot\.restore|controller\.shutdown|controller\.acquire/.test(source), false);
  assert.equal(/DesktopServiceClient/.test(source), true);
  assert.equal(/client\.dispose\(\)/.test(source), true);
  assert.equal(/shutdownWorkbenchService/.test(source), true);
  assert.match(readFileSync(PROTOCOL_SOURCE, "utf8"), /service\.shutdown/);
});

test("local preload path is the CJS sandbox build", () => {
  const source = readFileSync(INDEX_SOURCE, "utf8");
  assert.equal(SHELL_PRELOAD_FILE, "index.cjs");
  assert.match(source, /shellPreloadPath\(__dirname\)/);
  assert.equal(/preload\/index\.mjs/.test(source), false);
  assert.match(source, /sandbox:\s*true/);
  assert.match(readFileSync(VIEW_SOURCE, "utf8"), /sandbox:\s*true/);
  const moduleDir = join("C:", "app", "out", "main");
  assert.equal(shellPreloadPath(moduleDir).replaceAll("\\", "/").endsWith("preload/index.cjs"), true);
});

test("preload exposes only the closed DesktopShellApi", () => {
  const source = readFileSync(PRELOAD_SOURCE, "utf8");
  assert.match(source, /DESKTOP_SHELL_IPC/);
  assert.equal(/getDshHome|listProfiles|startProfile|bearer|bootstrapURL|llmCredential|restoreSnapshot/.test(source), false);
  assert.equal(/ipcRenderer\.invoke\((?!DESKTOP_SHELL_IPC)/.test(source), false);
  for (const channel of [
    DESKTOP_SHELL_IPC.getState,
    DESKTOP_SHELL_IPC.prepareEnvironment,
    DESKTOP_SHELL_IPC.startService,
    DESKTOP_SHELL_IPC.setPreference,
  ]) {
    assert.equal(isDesktopShellInvokeChannel(channel), true);
  }
});

test("workbench view stays sandboxed and does not inject a bearer", () => {
  const source = readFileSync(VIEW_SOURCE, "utf8");
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.equal(/extraHeaders|Authorization/.test(source), false);
  assert.equal(/preload:/.test(source), false);
  assert.equal(/fromPartition/.test(source), false);
});

test("shell DTOs do not invent a parallel workbench contract", () => {
  const shared = readFileSync(SHELL_SOURCE, "utf8");
  assert.equal(/interface DesktopWorkbenchApi|type DesktopWorkbenchApi/.test(shared), false);
  assert.equal(/readMutationContext|readWorkbenchSpaces|readPlan|readJob/.test(shared), false);
  const main = readFileSync(INDEX_SOURCE, "utf8");
  assert.equal(/as unknown as/.test(main.replace(/as unknown as TrayElectron/, "")), false);
  assert.match(main, /function protocolApi\(\): ShellWorkbenchPort/);
  assert.match(main, /return client\.getApi\(\)/);
  assert.match(readFileSync(PROTOCOL_SOURCE, "utf8"), /workbenchMutationContextSchema/);
});

test("preference patches are closed and reject unknown keys", () => {
  assert.deepEqual(parseClientPreferencePatch({ locale: "zh" }), { locale: "zh" });
  assert.equal(parseClientPreferencePatch({ locale: "fr" }), null);
  assert.equal(parseClientPreferencePatch({ path: "C:\\\\secret" }), null);
  assert.equal(parseClientPreferencePatch({ locale: "en", extra: true }), null);
});

test("trusted shell URLs compare exactly and ignore credentials", () => {
  const file = "file:///C:/app/out/renderer/index.html";
  assert.equal(sameTrustedUrl(file, "file:///C:/app/out/renderer/index.html"), true);
  assert.equal(sameTrustedUrl("http://localhost:5173/", "http://localhost:5173"), true);
  assert.equal(sameTrustedUrl("http://localhost:5173/", "http://127.0.0.1:5173/"), false);
  assert.equal(
    isTrustedShellFrame({
      senderIsShell: true,
      isMainFrame: true,
      frameUrl: "http://localhost:5173/",
      trustedUrl: "http://localhost:5173",
    }),
    true,
  );
  assert.equal(
    isTrustedShellFrame({
      senderIsShell: true,
      isMainFrame: false,
      frameUrl: "http://localhost:5173/",
      trustedUrl: "http://localhost:5173",
    }),
    false,
  );
});

test("top-level navigation allows one bootstrap jump then the manager origin", () => {
  const first = decideWorkbenchNavigation({
    url: BOOTSTRAP,
    managerOrigin: ORIGIN,
    bootstrapUrl: BOOTSTRAP,
    bootstrapConsumed: false,
    isTopLevel: true,
  });
  assert.deepEqual(first, { allow: true });
  const manager = decideWorkbenchNavigation({
    url: `${ORIGIN}/`,
    managerOrigin: ORIGIN,
    bootstrapUrl: BOOTSTRAP,
    bootstrapConsumed: false,
    isTopLevel: true,
  });
  assert.deepEqual(manager, { allow: true });
  assert.equal(
    consumeBootstrapIfNeeded({
      url: `${ORIGIN}/`,
      managerOrigin: ORIGIN,
      bootstrapUrl: BOOTSTRAP,
      bootstrapConsumed: false,
    }),
    true,
  );
  const replay = decideWorkbenchNavigation({
    url: BOOTSTRAP,
    managerOrigin: ORIGIN,
    bootstrapUrl: BOOTSTRAP,
    bootstrapConsumed: true,
    isTopLevel: true,
  });
  assert.equal(replay.allow, false);
  const file = decideWorkbenchNavigation({
    url: "file:///C:/secret",
    managerOrigin: ORIGIN,
    bootstrapUrl: BOOTSTRAP,
    bootstrapConsumed: true,
    isTopLevel: true,
  });
  assert.equal(file.allow, false);
  const js = decideWorkbenchNavigation({
    url: "javascript:alert(1)",
    managerOrigin: ORIGIN,
    bootstrapUrl: BOOTSTRAP,
    bootstrapConsumed: true,
    isTopLevel: true,
  });
  assert.equal(js.allow, false);
});

test("nested loopback frames are allowed; file iframes are not", () => {
  const nested = decideWorkbenchNavigation({
    url: "http://127.0.0.1:3101/",
    managerOrigin: ORIGIN,
    bootstrapUrl: BOOTSTRAP,
    bootstrapConsumed: true,
    isTopLevel: false,
  });
  assert.deepEqual(nested, { allow: true });
  const nestedFile = decideWorkbenchNavigation({
    url: "file:///C:/hub/index.html",
    managerOrigin: ORIGIN,
    bootstrapUrl: BOOTSTRAP,
    bootstrapConsumed: true,
    isTopLevel: false,
  });
  assert.equal(nestedFile.allow, false);
});

test("window.open only follows explicit user http(s) off-loopback navigation", () => {
  assert.deepEqual(decideWindowOpen({ url: "https://example.com", userInitiated: true }), { openExternal: true });
  assert.equal(decideWindowOpen({ url: "https://example.com", userInitiated: false }).deny, true);
  assert.equal(decideWindowOpen({ url: "file:///C:/x", userInitiated: true }).deny, true);
  assert.equal(decideWindowOpen({ url: `${ORIGIN}/`, userInitiated: true }).deny, true);
  assert.equal(decideWindowOpen({ url: "javascript:alert(1)", userInitiated: true }).deny, true);
});

test("public reasons redact paths and bearers", () => {
  const text = redactDesktopShellText(`Bearer abcdefghijklmnop at C:\\Users\\ada\\.dsh\\home`, [
    "abcdefghijklmnop",
  ]);
  assert.equal(text.includes("abcdefghijklmnop"), false);
  assert.equal(text.includes("C:\\Users"), false);
  assert.deepEqual(publishShellReasons(["", "  ok  "]), ["ok"]);
});

test("mutation context uses strict 64-hex fields and rejects string protocol 2", () => {
  assert.throws(() => mutationContextFromState(state({ protocolVersion: "2" as unknown as 2 })));
  assert.throws(() => mutationContextFromState(state({ serviceEpoch: "e1", revision: "r1" })));
  assert.throws(() => mutationContextFromState(state({ availability: "unavailable" })));
  assert.deepEqual(mutationContextFromState(state()), context(REV1));
});

test("a preview missing plan epoch is rejected", () => {
  const ctx = context(REV1);
  assert.throws(
    () => assertPlanMatches(plan({ serviceEpoch: "" }), ctx),
    /missing a service identity/,
  );
  assert.throws(() =>
    assertPlanMatches(plan({ serviceEpoch: undefined as unknown as string }), ctx),
  );
});

test("unknown workbench state is refused instead of treated as an empty stop", () => {
  assert.throws(() => ownedOrdinaryStopTargets(state({ managerId: null })));
  assert.throws(() => ownedOrdinaryStopTargets(state({ availability: "unavailable" })));
});

test("stop-all freezes owned ordinary spaces and ignores manager, external, and spaces created later", async () => {
  const previews: WorkbenchPlanRequest[] = [];
  const stoppedIds: string[] = [];
  let revision = REV1;
  let includeFresh = false;
  const api: ShellWorkbenchPort = {
    async state() {
      const spaces = [
        space({ id: "spaces-hub", displayName: "Manager", isHost: true, managed: true }),
        space({ id: "web", displayName: "Home", managed: true }),
        space({ id: "external", displayName: "External", managed: false }),
        space({ id: "coding", displayName: "Coding", managed: true, status: stoppedIds.includes("coding") ? "stopped" : "running" }),
        space({ id: "notes", displayName: "Notes", managed: true }),
      ];
      if (includeFresh) spaces.push(space({ id: "fresh", displayName: "Fresh", managed: true }));
      return state({ revision, spaces });
    },
    async preview(request, ctx) {
      previews.push(request);
      assert.equal(ctx.serviceEpoch, EPOCH);
      if (request.kind !== "space.stop") throw new Error("expected space.stop preview");
      return plan({
        id: `plan-${request.spaceId}`,
        affectedSpaceIds: [request.spaceId],
        runningSpaceIds: [request.spaceId],
        serviceEpoch: ctx.serviceEpoch,
        stateRevision: ctx.expectedRevision,
      });
    },
    async submit(command, requestId, ctx) {
      const target = previews.at(-1);
      if (!target || target.kind !== "space.stop") throw new Error("missing stop preview");
      if (command.kind !== "plan.execute") throw new Error("expected plan.execute");
      if (target.spaceId === "coding") {
        stoppedIds.push("coding");
        includeFresh = true;
        revision = REV2;
        return job({
          requestId,
          affectedSpaceIds: ["coding"],
          result: { spaceId: "coding" },
        });
      }
      assert.equal(ctx.expectedRevision, REV2);
      return job({
        id: "33333333-3333-4333-8333-333333333333",
        requestId,
        status: "failed",
        phase: "failed",
        message: "notes failed",
        affectedSpaceIds: ["notes"],
        error: { code: "workbench/failed", message: "notes failed", spaceId: "notes" },
        result: undefined,
      });
    },
    async job() {
      throw new Error("job poll was not needed");
    },
  };
  const result = await stopOwnedSpaces(api, {
    requestId: () => "22222222-2222-4222-8222-222222222222",
    sleep: async () => undefined,
  });
  assert.deepEqual(
    previews.map((row) => (row.kind === "space.stop" ? row.spaceId : row.kind)),
    ["coding", "notes"],
  );
  assert.deepEqual(result.stopped, ["coding"]);
  assert.equal(result.failed, "notes");
  assert.deepEqual(result.remaining, ["notes"]);
  assert.equal(result.job?.error?.code, "workbench/failed");
  assert.equal(result.job?.result, undefined);
  assert.equal(previews.some((row) => row.kind === "space.stop" && row.spaceId === "fresh"), false);
  assert.equal(previews.some((row) => row.kind === "space.stop" && row.spaceId === "spaces-hub"), false);
  assert.equal(previews.some((row) => row.kind === "space.stop" && row.spaceId === "external"), false);
});

test("stop-all does not stop targets after the service epoch changes and keeps the earlier job", async () => {
  const previews: WorkbenchPlanRequest[] = [];
  let epoch = EPOCH;
  let revision = REV1;
  const api: ShellWorkbenchPort = {
    async state() {
      return state({
        serviceEpoch: epoch,
        revision,
        spaces: [
          space({ id: "spaces-hub", isHost: true }),
          space({ id: "coding", status: epoch === EPOCH ? "running" : "stopped" }),
          space({ id: "notes" }),
        ],
      });
    },
    async preview(request, ctx) {
      previews.push(request);
      if (request.kind !== "space.stop") throw new Error("expected space.stop");
      return plan({
        id: `plan-${request.spaceId}`,
        serviceEpoch: ctx.serviceEpoch,
        stateRevision: ctx.expectedRevision,
        affectedSpaceIds: [request.spaceId],
        runningSpaceIds: [request.spaceId],
      });
    },
    async submit(_command, requestId) {
      epoch = EPOCH2;
      revision = REV2;
      return job({
        requestId,
        affectedSpaceIds: ["coding"],
        result: { spaceId: "coding" },
      });
    },
    async job() {
      throw new Error("job poll was not needed");
    },
  };
  const result = await stopOwnedSpaces(api, {
    requestId: () => "22222222-2222-4222-8222-222222222222",
    sleep: async () => undefined,
  });
  assert.deepEqual(
    previews.map((row) => (row.kind === "space.stop" ? row.spaceId : row.kind)),
    ["coding"],
  );
  assert.deepEqual(result.stopped, ["coding"]);
  assert.equal(result.failed, "notes");
  assert.deepEqual(result.remaining, ["notes"]);
  assert.equal(result.job?.result?.spaceId, "coding");
  assert.match(result.message ?? "", /service identity changed/);
});

test("stop-all does not count a changed-ownership space as stopped", async () => {
  let reads = 0;
  const api: ShellWorkbenchPort = {
    async state() {
      reads += 1;
      return state({
        spaces: [
          space({ id: "spaces-hub", isHost: true }),
          space({ id: "coding", managed: reads === 1 }),
          space({ id: "notes" }),
        ],
      });
    },
    async preview() {
      throw new Error("preview should not run for an ownership change");
    },
    async submit() {
      throw new Error("submit should not run for an ownership change");
    },
    async job() {
      throw new Error("job should not run");
    },
  };
  assert.deepEqual(
    ownedOrdinaryStopTargets(
      state({
        spaces: [space({ id: "spaces-hub", isHost: true }), space({ id: "coding" }), space({ id: "notes" })],
      }),
    ),
    ["coding", "notes"],
  );
  const result = await stopOwnedSpaces(api);
  assert.deepEqual(result.stopped, []);
  assert.equal(result.failed, "coding");
  assert.deepEqual(result.remaining, ["coding", "notes"]);
  assert.equal(result.job, null);
  assert.match(result.message ?? "", /no longer an owned ordinary workspace/);
});

test("coalesceInflight overlaps once, then runs again after success or failure", async () => {
  const holder: InflightHolder<number> = { current: null };
  let started = 0;
  let release!: (value: number) => void;
  const first = coalesceInflight(holder, () => {
    started += 1;
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  });
  const overlapping = coalesceInflight(holder, () => {
    started += 1;
    return Promise.resolve(99);
  });
  assert.equal(started, 1);
  assert.equal(first, overlapping);
  release(1);
  assert.equal(await first, 1);
  assert.equal(await overlapping, 1);
  const sequential = coalesceInflight(holder, async () => {
    started += 1;
    return 2;
  });
  assert.equal(await sequential, 2);
  assert.equal(started, 2);

  const failed = coalesceInflight(holder, async () => {
    started += 1;
    throw new Error("first failed");
  });
  await assert.rejects(failed, /first failed/);
  const afterFail = coalesceInflight(holder, async () => {
    started += 1;
    return 3;
  });
  assert.equal(await afterFail, 3);
  assert.equal(started, 4);
});

test("workbench session opens only after ready", () => {
  let opened = 0;
  assert.throws(() => openWorkbenchSession(false, () => {
    opened += 1;
    return "session";
  }), /before the app is ready/);
  assert.equal(opened, 0);
  assert.equal(openWorkbenchSession(true, () => {
    opened += 1;
    return "session";
  }), "session");
  assert.equal(opened, 1);
});

test("shutdown keeps the received job when the service disappears", async () => {
  const api: ShellWorkbenchPort = {
    async state() {
      return state();
    },
    async preview() {
      return plan({ kind: "service.shutdown", id: "plan-down", scope: "controller" });
    },
    async submit(_command, requestId) {
      return job({
        id: "44444444-4444-4444-8444-444444444444",
        requestId,
        status: "running",
        phase: "stopping",
        message: "stopping",
        canCancel: true,
        result: undefined,
      });
    },
    async job() {
      throw new Error("workbench/unavailable");
    },
  };
  const result = await shutdownWorkbenchService(api, {
    requestId: () => "55555555-5555-4555-8555-555555555555",
    sleep: async () => undefined,
  });
  assert.equal(result.succeeded, false);
  assert.equal(result.disconnected, true);
  assert.equal(result.job?.id, "44444444-4444-4444-8444-444444444444");
  assert.equal(result.job?.status, "running");
  assert.match(result.message, /not confirmed|disconnected/i);
});

test("waitForJob keeps the last received structured job when the service disappears", async () => {
  const queued = job({
    status: "queued",
    phase: "queued",
    message: "",
    result: { spaceId: "coding" },
  });
  const result = await waitForJob(
    {
      async job() {
        throw new Error("fetch failed");
      },
    },
    queued,
    { sleep: async () => undefined },
  );
  assert.equal(result.disconnected, true);
  assert.equal(result.job.status, "queued");
  assert.deepEqual(result.job.result, { spaceId: "coding" });
});

test("payload root is packages/plugin/lib in development and spaces-payload/lib when packaged", () => {
  const moduleDir = join("C:", "repo", "out", "main");
  assert.equal(
    resolveSpacesPayloadRoot({ packaged: false, resourcesPath: "C:\\ignored", moduleDir })
      .toLowerCase()
      .endsWith(join("packages", "plugin", "lib").toLowerCase()),
    true,
  );
  assert.equal(
    resolveSpacesPayloadRoot({ packaged: true, resourcesPath: "C:\\app\\resources", moduleDir }),
    join("C:\\app\\resources", "spaces-payload", "lib"),
  );
  assert.match(trustedShellUrl({ devRendererUrl: "http://localhost:5173/", moduleDir }), /localhost:5173/);
});

test("test runtime overrides must be real files and are not taken from the renderer", () => {
  const previousCli = process.env.DSH_TEST_CLI_BIN;
  const previousNode = process.env.DSH_TEST_NODE;
  try {
    process.env.DSH_TEST_CLI_BIN = join(tmpdir(), "missing-cli-bin.js");
    process.env.DSH_TEST_NODE = join(tmpdir(), "missing-node.exe");
    assert.equal(testRuntimeOverride(), null);
    const cli = tempFile("bin.js");
    const node = tempFile("node.exe");
    process.env.DSH_TEST_CLI_BIN = cli;
    process.env.DSH_TEST_NODE = node;
    assert.deepEqual(testRuntimeOverride(), { nodeExe: node, cliBin: cli });
    assert.equal(verifiedToolFile(join(tmpdir(), "nope")), null);
  } finally {
    if (previousCli === undefined) delete process.env.DSH_TEST_CLI_BIN;
    else process.env.DSH_TEST_CLI_BIN = previousCli;
    if (previousNode === undefined) delete process.env.DSH_TEST_NODE;
    else process.env.DSH_TEST_NODE = previousNode;
  }
});

test("tray menu keeps stop-all and quit, and adds a scoped stop-service item", () => {
  applyAppLocale("en");
  const ids = buildTrayMenuItems([{ name: "coding", displayName: "Coding", status: "running" }]).map((item) =>
    "id" in item ? item.id : item.type,
  );
  assert.ok(ids.includes("stop-all"));
  assert.ok(ids.includes("stop-service"));
  assert.ok(ids.includes("quit"));
  assert.equal(ids.includes("acquire"), false);
});

test("normal stopped cards offer start; error cards copy logs and do not retry", () => {
  const rendererDir = fileURLToPath(new URL("../src/renderer/src/", import.meta.url));
  assert.equal(existsSync(join(rendererDir, "recovery.ts")), false);
  const app = readFileSync(join(rendererDir, "App.tsx"), "utf8");
  const cli = readFileSync(join(rendererDir, "components/CliSetup.tsx"), "utf8");
  const status = readFileSync(join(rendererDir, "components/ShellStatus.tsx"), "utf8");
  const title = readFileSync(join(rendererDir, "components/TitleBar.tsx"), "utf8");
  assert.equal(/restoreSnapshot|controller\.acquire|recovery\.resume/.test(app), false);
  assert.match(title, /shell\.prepare/);
  assert.match(title, /shell\.startService/);
  assert.equal(/common\.retry/.test(cli), false);
  assert.match(cli, /shell\.copyLogs/);
  assert.match(status, /state\.phase === "tools-ready" && state\.canStart && onStart/);
  assert.equal(/shell\.prepareHint/.test(status), false);
  assert.match(status, /shell\.copyLogs/);
  assert.match(app, /aliveRef/);
  assert.match(app, /seqRef/);
  assert.match(readFileSync(INDEX_SOURCE, "utf8"), /coalesceInflight/);
  assert.match(readFileSync(INDEX_SOURCE, "utf8"), /openWorkbenchSession/);
  assert.match(readFileSync(INDEX_SOURCE, "utf8"), /viewGeneration/);
  assert.match(readFileSync(INDEX_SOURCE, "utf8"), /snapshotAndEmit/);
  const start = readFileSync(INDEX_SOURCE, "utf8");
  assert.equal(/snapshotRoot && realDirectory\(toolchain\.snapshotRoot\)/.test(start), false);
  assert.match(start, /createIfMissing:\s*!recordedSnapshotRoot/);
  assert.ok(start.indexOf("ensureDesktopSnapshotRoot(dshHome, snapshotRoot") < start.indexOf("client.start(runtime)"));
});

test("explicit start creates the default app-owned snapshots directory when it is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-shell-snap-"));
  temps.push(root);
  const home = join(root, "home");
  const userData = join(root, "app");
  mkdirSync(home);
  mkdirSync(userData);
  const snapshotRoot = join(userData, DESKTOP_SNAPSHOTS_DIRNAME);
  assert.equal(existsSync(snapshotRoot), false);
  const created = ensureDesktopSnapshotRoot(home, snapshotRoot, { createIfMissing: true });
  assert.equal(created, realpathSync(snapshotRoot));
  assert.equal(lstatSync(snapshotRoot).isDirectory(), true);
  assert.equal(lstatSync(snapshotRoot).isSymbolicLink(), false);
  writeFileSync(join(snapshotRoot, "keep.txt"), "keep");
  assert.equal(ensureDesktopSnapshotRoot(home, snapshotRoot, { createIfMissing: true }), created);
  assert.equal(readFileSync(join(snapshotRoot, "keep.txt"), "utf8"), "keep");
});

test("missing recorded snapshotRoot is not replaced by the default snapshots directory", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-shell-snap-recorded-"));
  temps.push(root);
  const home = join(root, "home");
  const userData = join(root, "app");
  mkdirSync(home);
  mkdirSync(userData);
  const recordedParent = join(root, "store");
  mkdirSync(recordedParent);
  const recorded = join(recordedParent, DESKTOP_SNAPSHOTS_DIRNAME);
  const reason = /snapshotRoot must be a real directory outside snapshot-replaced Home entries/;
  assert.equal(existsSync(recorded), false);
  assert.throws(() => ensureDesktopSnapshotRoot(home, recorded, { createIfMissing: false }), reason);
  assert.equal(existsSync(recorded), false);
  assert.equal(existsSync(join(userData, DESKTOP_SNAPSHOTS_DIRNAME)), false);
});

test("existing recorded snapshotRoot with another directory name is reused", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-shell-snap-named-"));
  temps.push(root);
  const home = join(root, "home");
  const userData = join(root, "app");
  mkdirSync(home);
  mkdirSync(userData);
  const recorded = join(root, "archive-root");
  mkdirSync(recorded);
  writeFileSync(join(recorded, "keep.txt"), "keep");
  const got = ensureDesktopSnapshotRoot(home, recorded, { createIfMissing: false });
  assert.equal(got, realpathSync(recorded));
  assert.equal(ensureDesktopSnapshotRoot(home, recorded, { createIfMissing: false }), got);
  assert.equal(readFileSync(join(recorded, "keep.txt"), "utf8"), "keep");
  assert.equal(existsSync(join(userData, DESKTOP_SNAPSHOTS_DIRNAME)), false);
});

test("explicit start refuses a file, junction, or Home profile snapshotRoot without mutation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dsh-shell-snap-bad-"));
  temps.push(root);
  const home = join(root, "home");
  const userData = join(root, "app");
  mkdirSync(home);
  mkdirSync(userData);
  const reason = /snapshotRoot must be a real directory outside snapshot-replaced Home entries/;

  const asFile = join(userData, DESKTOP_SNAPSHOTS_DIRNAME);
  writeFileSync(asFile, "not-a-directory");
  assert.throws(() => ensureDesktopSnapshotRoot(home, asFile), reason);
  assert.equal(readFileSync(asFile, "utf8"), "not-a-directory");

  const profiles = join(home, "profiles", "notes");
  mkdirSync(profiles, { recursive: true });
  assert.throws(() => ensureDesktopSnapshotRoot(home, profiles), reason);
  assert.equal(lstatSync(profiles).isDirectory(), true);
  const forbiddenLeaf = join(home, "profiles", "web", DESKTOP_SNAPSHOTS_DIRNAME);
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  assert.throws(() => ensureDesktopSnapshotRoot(home, forbiddenLeaf, { createIfMissing: true }), reason);
  assert.equal(existsSync(forbiddenLeaf), false);
  assert.equal(existsSync(join(userData, "other-snapshots")), false);

  const linked = join(userData, "linked-snapshots");
  try {
    symlinkSync(profiles, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.diagnostic(`directory junction is not testable: ${String(error)}`);
  }
  if (existsSync(linked)) {
    assert.throws(() => ensureDesktopSnapshotRoot(home, linked), reason);
    const after = lstatSync(linked);
    assert.equal(after.isSymbolicLink() || after.isDirectory(), true);
    assert.equal(readFileSync(asFile, "utf8"), "not-a-directory");
  }
});
