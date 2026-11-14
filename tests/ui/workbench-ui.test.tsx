import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpaceDetail, SpaceModelConfig } from "../../src/shared/spaces-control.ts";
import type { SpaceSharePreview } from "../../src/shared/space-share.ts";
import type {
  WorkbenchApi,
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchSnapshot,
  WorkbenchSpace,
  WorkbenchState,
  WorkbenchView as WorkbenchViewInfo,
} from "../../src/shared/workbench.ts";
import type { WorkbenchProductRequest, WorkbenchProductResult } from "../../src/shared/workbench-product.ts";
import type { PackageSource } from "../../src/shared/types.ts";
import { WorkbenchApp } from "../../packages/plugin/src/workbench/app.tsx";
import { JobsList, WorkbenchView } from "../../packages/plugin/src/workbench/components.tsx";
import { INTERRUPTED_JOB_MESSAGE } from "../../src/adapters/node/maintenance/workbench-jobs.ts";
import {
  WorkbenchController,
  pollDelayMs,
  type WorkbenchEnv,
} from "../../packages/plugin/src/workbench/store.ts";
import {
  ViewSession,
  acceptViewMessage,
  authorizedViewSrc,
  isCleanLoopbackOrigin,
  isTrustedOrigin,
} from "../../packages/plugin/src/workbench/view-session.ts";
import { validateWorkbenchIcon } from "../../packages/plugin/src/workbench/icons.ts";
import {
  persistLooksSafe,
  readPersist,
  WORKBENCH_STORAGE_KEY,
  writePersist,
} from "../../packages/plugin/src/workbench/persistence.ts";
import { localizeError, t } from "../../packages/plugin/src/workbench/i18n.ts";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

function memoryStorage(): WorkbenchEnv["storage"] {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function space(partial: Partial<WorkbenchSpace> & Pick<WorkbenchSpace, "id">): WorkbenchSpace {
  return {
    displayName: partial.displayName ?? partial.id,
    isHost: false,
    hasWebApp: true,
    icon: "",
    status: "running",
    generation: 1,
    managed: true,
    dshVersion: null, startWithDesktop: false,
    ...partial,
  };
}

const manager = space({ id: "hub", displayName: "Hub", isHost: true, status: "running" });
const alpha = space({ id: "alpha", displayName: "Alpha" });
const beta = space({ id: "beta", displayName: "Beta", status: "stopped" });

function job(partial: Partial<WorkbenchJob> = {}): WorkbenchJob {
  return {
    id: "job-1",
    requestId: "req-1",
    kind: "space.start",
    status: "running",
    phase: "start",
    message: "starting",
    affectedSpaceIds: ["alpha"],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    canCancel: true,
    ...partial,
  };
}

const EPOCH = "aa".repeat(32);
const REVISION = "bb".repeat(32);
const REVISION_NEXT = "cc".repeat(32);
const OBSERVATION = { serviceEpoch: EPOCH, expectedRevision: REVISION };

function state(partial: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    protocolVersion: 2,
    serviceEpoch: EPOCH,
    revision: REVISION,
    availability: "ready",
    role: "manager",
    managerId: "hub",
    owner: { kind: "web", since: "2026-09-12T00:00:00.000Z" },
    writable: true,
    mode: "verified-full",
    dshVersion: "0.1.5-rc.1",
    maintenance: false,
    reasons: [],
    spaces: [manager, alpha, beta],
    jobs: [],
    ...partial,
  };
}

const CHILD_ORIGIN = "http://127.0.0.1:3101";
const SUPERVISOR_ORIGIN = "http://127.0.0.1:3100";

function viewOf(spaceId: string, generation = 1): WorkbenchViewInfo {
  return {
    serviceEpoch: EPOCH,
    spaceId,
    generation,
    origin: CHILD_ORIGIN,
    entryOrigin: SUPERVISOR_ORIGIN,
    entryPath: `/view/${spaceId}`,
    channel: `ch-${spaceId}-${generation}`,
  };
}

function viewSrc(spaceId: string): string {
  return `${SUPERVISOR_ORIGIN}/view/${spaceId}?epoch=${EPOCH}`;
}

function readyMessage(spaceId: string, generation = 1, state: "ready" | "failed" = "ready") {
  return {
    source: "dsh-spaces-view" as const,
    serviceEpoch: EPOCH,
    spaceId,
    generation,
    channel: `ch-${spaceId}-${generation}`,
    state,
  };
}

function sharePreview(): SpaceSharePreview {
  return {
    manifest: {
      formatVersion: 1,
      kind: "dsh-space",
      exportedAt: "2026-09-12T00:00:00.000Z",
      source: { dshVersion: "0.1.5-rc.1" },
      space: { displayName: "Alpha" },
    },
    plugins: [{ packageName: "demo", resolvedVersion: "1.2.3", source: "npm" }],
    hasConfig: false,
    unknownSources: [],
  };
}

function productResult(request: WorkbenchProductRequest): WorkbenchProductResult {
  if (request.method === "settings") {
    return {
      method: "settings",
      settings: { portStart: 3100, portEnd: 3199, packageSource: "official", catalogUrl: "" },
      clientDefaults: { locale: "zh", theme: "dark" },
      observation: OBSERVATION,
    };
  }
  if (request.method === "catalog") {
    return {
      method: "catalog",
      catalog: {
        meta: {
          schemaVersion: 1,
          generatedAt: "2026-09-12T00:00:00.000Z",
          count: 1,
          contentHash: "ab".repeat(8),
        },
        entries: [
          {
            id: "catalog.demo",
            repo: "demo",
            owner: "demo",
            url: "https://example.com/demo",
            tier: "verified-npm",
            packageName: "demo",
            installMethod: "npm",
            runsBuildScript: false,
            description: "A plugin",
            tags: [],
            stars: 0,
            hasClient: false,
          },
        ],
        source: "cache",
        url: "https://example.com/catalog.json",
      },
      observation: OBSERVATION,
    };
  }
  if (request.method === "library") {
    return {
      method: "library",
      items: [
        {
          id: "lib-demo-1.2.3",
          packageName: "demo",
          title: "Demo",
          version: "1.2.3",
          source: "catalog",
          downloadedAt: "2026-09-12T00:00:00.000Z",
          installedIn: [],
        },
      ],
      observation: OBSERVATION,
    };
  }
  if (request.method === 'base.versions') {
    const versions = request.base === 'browser' ? ['0.4.0'] : ['0.2.1-rc.2', '0.2.0-rc.2'];
    return { method: 'base.versions', base: request.base, versions, preferred: versions[0]!, observation: OBSERVATION };
  }
  if (request.method === "plugin.versions") {
    return {
      method: "plugin.versions",
      versions: ["2.0.0", "1.2.3"],
      latest: "2.0.0",
      packageName: "demo",
      observation: OBSERVATION,
    };
  }
  if (request.method === "diagnostics") {
    return {
      method: "diagnostics",
      diagnostics: {
        spaceId: request.spaceId,
        status: "running",
        lastError: "plugin failed",
        logs: [{ at: "2026-09-12T00:00:00.000Z", channel: "stderr", text: "redacted" }],
        backups: [{ id: "bak-1", createdAt: "2026-09-12T00:00:00.000Z", size: 12, tooLarge: false }],
      },
      observation: OBSERVATION,
    };
  }
  if (request.method === "logs" || request.method === "log.record") {
    return { method: "logs", entries: [], logError: null, observation: OBSERVATION };
  }
  if (request.method === "templates") {
    return {
      method: "templates",
      templates: [
        {
          id: "dev",
          name: "dev",
          displayName: "Development",
          plugins: [],
          createdAt: "2026-09-12T00:00:00.000Z",
        },
      ],
      observation: OBSERVATION,
    };
  }
  if (request.method === "share.export") {
    return {
      method: "share.export",
      fileName: "alpha.dshspace",
      archiveBase64: "YQ==",
      preview: sharePreview(),
      observation: OBSERVATION,
    };
  }
  return {
    method: "share.previewImport",
    importId: "imp-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    preview: sharePreview(),
    observation: OBSERVATION,
  };
}

test("temporary disconnection preserves the visited frame and recovers without switching focus", () => {
  const views = new ViewSession();
  const request = views.requestSpace(alpha);
  views.applyView("alpha", request.token, viewOf("alpha"));
  views.onAcceptedMessage("alpha", readyMessage("alpha"));
  const original = views.get("alpha");
  views.onAcceptedMessage("alpha", { ...readyMessage("alpha"), state: "disconnected" });
  assert.equal(views.get("alpha"), original);
  assert.equal(views.isVisible("alpha"), true);
  views.commitHome();
  views.onAcceptedMessage("alpha", readyMessage("alpha"));
  assert.equal(views.committedSpaceId, null);
  assert.equal(views.get("alpha"), original);
  assert.equal(views.requestSpace(alpha).reuseReady, true);
});

test("a view failure keeps the public reason, and a late failure does not replace the newer selection", async () => {
  const gates = new Map<string, ReturnType<typeof deferred<WorkbenchViewInfo>>>();
  const ctrl = controller(fakeApi({
    state: async () => state({ spaces: [manager, space({ id: "alpha" }), space({ id: "beta" })] }),
    view: spaceId => {
      const gate = deferred<WorkbenchViewInfo>();
      gates.set(spaceId, gate);
      return gate.promise;
    },
  }));
  await ctrl.poll();
  ctrl.selectSpace("alpha");
  ctrl.selectSpace("beta");
  gates.get("beta")!.reject(Object.assign(new Error("plugin example is missing\nC:\\secret\\home"), { code: "workbench/incompatible" }));
  await flush();
  assert.match(ctrl.getSnapshot().viewError?.message ?? "", /plugin example is missing/);
  assert.doesNotMatch(ctrl.getSnapshot().viewError?.message ?? "", /C:\\secret/);
  assert.equal(ctrl.getSnapshot().frames.find(frame => frame.spaceId === "beta")?.status, "failed");
  gates.get("alpha")!.reject(Object.assign(new Error("stale alpha failure"), { code: "workbench/unavailable" }));
  await flush();
  assert.equal(ctrl.getSnapshot().viewError?.spaceId, "beta");
  assert.match(ctrl.getSnapshot().viewError?.message ?? "", /plugin example is missing/);
  assert.equal(ctrl.getSnapshot().frames.find(frame => frame.spaceId === "alpha")?.status, "failed");
  assert.equal(ctrl.getSnapshot().selected, "home");
});

test("the first state failure stays terminal for this controller", async () => {
  let reads = 0;
  let fail = true;
  const timers: Array<() => void> = [];
  let onVisible: (() => void) | undefined;
  const ctrl = controller(fakeApi({
    state: async () => {
      reads += 1;
      if (fail) throw Object.assign(new Error("workbench overview timed out"), { code: "workbench/unavailable" });
      return state();
    },
  }), {
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: () => undefined,
    onVisibilityChange: listener => { onVisible = listener; return () => undefined; },
  });
  ctrl.start();
  await flush();
  assert.equal(reads, 1);
  assert.match(ctrl.getSnapshot().error ?? "", /workbench overview timed out/);
  assert.equal(ctrl.canMutate(), false);
  assert.equal(ready(ctrl).includes("workbench overview timed out"), true);
  const frozen = reads;
  for (const fire of [...timers]) fire();
  onVisible?.();
  await ctrl.poll();
  fail = false;
  await ctrl.selectRunningSpace("alpha");
  await flush();
  assert.equal(reads, frozen);
  assert.match(ctrl.getSnapshot().error ?? "", /workbench overview timed out/);
  assert.equal(ctrl.getSnapshot().pendingId, null);
});

test("a late state failure cannot freeze a newer successful read", async () => {
  const first = deferred<WorkbenchState>();
  let calls = 0;
  const ctrl = controller(fakeApi({
    state: async () => {
      calls += 1;
      if (calls === 1) return first.promise;
      return state({ spaces: [manager, space({ id: "alpha" })] });
    },
  }));
  const early = ctrl.poll();
  await ctrl.poll();
  first.reject(Object.assign(new Error("old overview"), { code: "workbench/unavailable" }));
  await early;
  await flush();
  assert.equal(ctrl.getSnapshot().error, null);
  assert.equal(ctrl.getSnapshot().state?.spaces.some(item => item.id === "alpha"), true);
  assert.equal(ctrl.canMutate(), true);
});

test("a state failure after a healthy frame stays visible without unloading that frame", async () => {
  let fail = false;
  const ctrl = controller(fakeApi({
    state: async () => {
      if (fail) throw Object.assign(new Error("later overview stopped"), { code: "workbench/unavailable" });
      return state({ spaces: [manager, space({ id: "alpha" })] });
    },
  }));
  await ctrl.poll();
  await becomeReady(ctrl, "alpha");
  fail = true;
  await ctrl.poll();
  const html = ready(ctrl);
  assert.match(ctrl.getSnapshot().error ?? "", /later overview stopped/);
  assert.equal(html.includes("later overview stopped"), true);
  assert.equal(html.includes('data-space-id="alpha"'), true);
  assert.equal(ctrl.getSnapshot().selected, "alpha");
});

test("polling does not duplicate a hanging view request or postpone its timeout", async () => {
  const pending = deferred<WorkbenchViewInfo>();
  const timers: Array<() => void> = [];
  let calls = 0;
  const ctrl = controller(fakeApi({ view: () => { calls++; return pending.promise; } }), {
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: () => undefined,
  });
  await ctrl.poll();
  ctrl.selectSpace("alpha");
  const initialTimers = timers.length;
  await ctrl.poll();
  await ctrl.poll();
  assert.equal(calls, 1);
  assert.equal(timers.length, initialTimers);
  timers.at(-1)!();
  pending.resolve(viewOf("alpha"));
  await flush();
  assert.equal(ctrl.getSnapshot().selected, "home");
  assert.equal(ctrl.getSnapshot().pendingId, null);
});

async function becomeReady(ctrl: WorkbenchController, spaceId: string, win: { id: string } = { id: spaceId }) {
  ctrl.selectSpace(spaceId);
  await flush();
  const frame = ctrl.getSnapshot().frames.find((item) => item.spaceId === spaceId);
  const generation = frame?.generation ?? 1;
  ctrl.registerIframeWindow(spaceId, generation, win);
  ctrl.handleMessage({
    origin: CHILD_ORIGIN,
    source: win,
    data: readyMessage(spaceId, generation),
  });
}

function planOf(request: WorkbenchPlanRequest, partial: Partial<WorkbenchPlan> = {}): WorkbenchPlan {
  return {
    id: "plan-1",
    kind: request.kind,
    title: request.kind,
    scope: "space",
    affectedSpaceIds: "spaceId" in request ? [request.spaceId] : [],
    runningSpaceIds: [],
    changes: ["change-1"],
    destructive: request.kind.includes("delete") || request.kind.includes("restore"),
    expiresAt: "2026-09-12T00:05:00.000Z",
    serviceEpoch: EPOCH,
    stateRevision: REVISION,
    ...partial,
  };
}

interface SpyApi extends WorkbenchApi {
  calls: Array<{ method: string; arg: unknown; context?: unknown }>;
}

function fakeApi(overrides: Partial<WorkbenchApi> = {}): SpyApi {
  const calls: SpyApi["calls"] = [];
  const api: SpyApi = {
    calls,
    state: async () => {
      calls.push({ method: "state", arg: undefined });
      return state();
    },
    startupStatus: async () => {
      calls.push({ method: "startupStatus", arg: undefined });
      return { serviceEpoch: "a".repeat(64), managerId: "hub", phase: "ready", reasons: [], failure: null };
    },
    detail: async (spaceId) => {
      calls.push({ method: "detail", arg: spaceId });
      return {
        space: { id: spaceId, displayName: spaceId, isHost: spaceId === "hub", hasWebApp: true, status: "running" },
        models: { status: "configured", routeNames: ["gw"], defaultModel: "gw/gw-large", missingCredentials: [] },
        plugins: [{ name: "demo", version: "1.0.0" }],
        snapshots: [],
        diagnostics: [{ level: "warning", code: "NEED_CHECK", message: "check" }],
      } satisfies SpaceDetail;
    },
    submit: async (command, requestId, context) => {
      calls.push({ method: "submit", arg: { command, requestId, context } });
      return job({
        id: `job-${requestId}`,
        requestId,
        kind: command.kind,
        status: "succeeded",
        canCancel: false,
        result: command.kind === "space.create" ? { spaceId: "created" } : undefined,
      });
    },
    job: async (id) => {
      calls.push({ method: "job", arg: id });
      return job({ id, status: "succeeded", canCancel: false });
    },
    cancel: async (id) => {
      calls.push({ method: "cancel", arg: id });
      return job({ id, status: "cancelled", canCancel: false });
    },
    view: async (spaceId) => {
      calls.push({ method: "view", arg: spaceId });
      return viewOf(spaceId);
    },
    preview: async (request, context) => {
      calls.push({ method: "preview", arg: request, context });
      return planOf(request, { taskActivity: "idle" });
    },
    product: async (request) => {
      calls.push({ method: "product", arg: request });
      return productResult(request);
    },
    plugins: async (query) => {
      calls.push({ method: "plugins", arg: query });
      return [
        {
          id: "catalog.demo",
          title: "Demo",
          packageName: "demo",
          description: "A plugin",
          version: "1.2.3",
          installedIn: ["alpha"],
          protected: false,
        } satisfies WorkbenchPlugin,
      ];
    },
    snapshots: async () => {
      calls.push({ method: "snapshots", arg: undefined });
      return [
        {
          id: "snap-1",
          createdAt: "2026-09-12T00:00:00.000Z",
          runtimeVersion: "0.1.5-rc.1",
          spaceIds: ["alpha"],
          bytes: 1048576,
          restorable: true,
        } satisfies WorkbenchSnapshot,
      ];
    },
    snapshot: async (id) => {
      calls.push({ method: "snapshot", arg: id });
      return {
        id,
        createdAt: "2026-09-12T00:00:00.000Z",
        runtimeVersion: "0.1.5-rc.1",
        spaceIds: ["alpha"],
        bytes: 1048576,
        restorable: true,
      };
    },
    runtimes: async () => {
      calls.push({ method: "runtimes", arg: undefined });
      return [{ version: "0.1.5-rc.1", installed: true, host: true, pinnedBy: [], removable: false, compatible: true } satisfies WorkbenchRuntime];
    },
    backups: async (spaceId) => {
      calls.push({ method: "backups", arg: spaceId });
      return [{ id: "bak-1", createdAt: "2026-09-12T00:00:00.000Z", reason: "auto" } satisfies WorkbenchBackup];
    },
    ...overrides,
  };
  return api;
}

function env(overrides: Partial<WorkbenchEnv> = {}): Partial<WorkbenchEnv> {
  return {
    uuid: () => "uuid-1",
    storage: memoryStorage(),
    hidden: () => false,
    onVisibilityChange: () => () => undefined,
    addMessageListener: () => () => undefined,
    openUrl: () => undefined,
    downloadFile: () => undefined,
    ...overrides,
  };
}

const controllers: WorkbenchController[] = [];
afterEach(() => { for (const instance of controllers.splice(0)) instance.stop(); });
function controller(api: WorkbenchApi = fakeApi(), extra?: Partial<WorkbenchEnv>): WorkbenchController {
  const instance = new WorkbenchController(api, env(extra));
  controllers.push(instance);
  return instance;
}

function ready(ctrl: WorkbenchController): string {
  return renderToStaticMarkup(React.createElement(WorkbenchView, { ui: ctrl.getSnapshot(), controller: ctrl }));
}

test("native settings stays a page while creating a space and after cancelling the dialog", async () => {
  const ctrl = controller(); ctrl.start(); await flush(); ctrl.openSettings();
  const renderPage = () => renderToStaticMarkup(React.createElement(WorkbenchView, {
    ui: ctrl.getSnapshot(), controller: ctrl, contained: true, nativeSurface: true, systemPage: "settings", homeUrl: "http://127.0.0.1:3101/home",
  }));
  assert.match(renderPage(), /class="dsh-wb-settings-page"/);
  ctrl.openCreate(); assert.match(renderPage(), /class="dsh-wb-settings-page"/);
  ctrl.closeOverlay(); assert.match(renderPage(), /class="dsh-wb-settings-page"/);
  assert.doesNotMatch(renderPage(), /data-settings-close/);
  assert.doesNotMatch(renderPage(), /data-home-view/, "Desktop owns its original home; the native manager must not load another one");
});

test("native settings owns its creation notice and stops covering a selected space", async () => {
  const ctrl = controller(); await ctrl.poll();
  const ui = { ...ctrl.getSnapshot(), createdNotice: { spaceId: "alpha" } };
  const render = (selected: string) => renderToStaticMarkup(React.createElement(WorkbenchView, {
    ui: { ...ui, selected }, controller: ctrl, contained: true, nativeSurface: true, systemPage: "settings",
  }));
  const settings = render("home");
  assert.equal(settings.match(/data-created="alpha"/g)?.length, 1);
  assert.match(settings, /class="dsh-wb-notice dsh-wb-row" role="status" data-created="alpha"/);
  assert.doesNotMatch(render("alpha"), /class="dsh-wb-settings-page"/);
});

test("authorized view src is origin+entryPath and rejects remote or token-like paths", () => {
  const view = viewOf("alpha");
  assert.equal(authorizedViewSrc(view), viewSrc("alpha"));
  assert.equal(isCleanLoopbackOrigin(SUPERVISOR_ORIGIN), true);
  assert.equal(isCleanLoopbackOrigin("http://127.0.0.1:3100/"), false);
  assert.equal(isCleanLoopbackOrigin("http://user@127.0.0.1:3100"), false);
  assert.equal(isCleanLoopbackOrigin("http://127.0.0.1:3100/view"), false);
  assert.equal(isCleanLoopbackOrigin("http://127.0.0.1:3100?x=1"), false);
  assert.equal(isTrustedOrigin(CHILD_ORIGIN), true);
  assert.equal(isTrustedOrigin("https://example.com"), false);
  assert.throws(() => authorizedViewSrc({ ...view, origin: "https://evil.example" }));
  assert.throws(() => authorizedViewSrc({ ...view, entryOrigin: CHILD_ORIGIN }));
  assert.throws(() => authorizedViewSrc({ ...view, entryPath: "https://evil.example/x" }));
  assert.throws(() => authorizedViewSrc({ ...view, entryPath: "//evil.example/x" }));
  assert.throws(() => authorizedViewSrc({ ...view, entryPath: "view/alpha" }));
  assert.throws(() => authorizedViewSrc({ ...view, entryPath: "/view/alpha?token=secret" }));
  assert.throws(() => authorizedViewSrc({ ...view, entryPath: "/view/alpha?epoch=" + EPOCH }));
  assert.throws(() => authorizedViewSrc({ ...view, entryPath: "/view\\alpha" }));
  assert.throws(() => authorizedViewSrc({ ...view, serviceEpoch: "" }));
  assert.throws(() => authorizedViewSrc({ ...view, serviceEpoch: "nope" }));
  assert.throws(() => authorizedViewSrc({ ...view, serviceEpoch: "AA".repeat(32) }));
  assert.notEqual(authorizedViewSrc(view), `${CHILD_ORIGIN}/view/alpha`);
  assert.equal(authorizedViewSrc(view).includes("?epoch="), true);
  assert.equal(authorizedViewSrc(view).includes("&"), false);
});

test("view handshake requires origin, event.source, epoch, spaceId, generation and channel", () => {
  const session = new ViewSession();
  const spaceRow = space({ id: "alpha" });
  const { token } = session.requestSpace(spaceRow);
  session.applyView("alpha", token, viewOf("alpha"));
  const frame = session.get("alpha")!;
  const iframe = { id: "iframe-alpha" };
  const good = {
    origin: CHILD_ORIGIN,
    source: iframe,
    data: {
      source: "dsh-spaces-view",
      serviceEpoch: EPOCH,
      spaceId: "alpha",
      generation: 1,
      channel: "ch-alpha-1",
      state: "ready",
    },
  };
  assert.ok(acceptViewMessage(good, frame, iframe));
  assert.equal(acceptViewMessage({ ...good, origin: "http://127.0.0.1:9999" }, frame, iframe), null);
  assert.equal(acceptViewMessage({ ...good, source: { other: true } }, frame, iframe), null);
  assert.equal(
    acceptViewMessage({ ...good, data: { ...good.data, spaceId: "beta" } }, frame, iframe),
    null,
  );
  assert.equal(
    acceptViewMessage({ ...good, data: { ...good.data, generation: 2 } }, frame, iframe),
    null,
  );
  assert.equal(
    acceptViewMessage({ ...good, data: { ...good.data, channel: "nope" } }, frame, iframe),
    null,
  );
  assert.equal(
    acceptViewMessage({ ...good, data: { ...good.data, source: "other" } }, frame, iframe),
    null,
  );
  assert.equal(
    acceptViewMessage({ ...good, data: { ...good.data, serviceEpoch: "nope" } }, frame, iframe),
    null,
  );
  const withoutEpoch = { ...good.data } as { serviceEpoch?: string };
  delete withoutEpoch.serviceEpoch;
  assert.equal(acceptViewMessage({ ...good, data: withoutEpoch }, frame, iframe), null);
});

test("last selection wins; stale ready does not steal visibility", () => {
  const session = new ViewSession();
  const a = session.requestSpace(space({ id: "alpha" }));
  session.applyView("alpha", a.token, viewOf("alpha"));
  const b = session.requestSpace(space({ id: "beta", status: "running" }));
  session.applyView("beta", b.token, viewOf("beta"));
  session.onAcceptedMessage("alpha", readyMessage("alpha"));
  assert.equal(session.visibleSpaceId, null);
  assert.equal(session.committedSpaceId, null);
  assert.equal(session.get("alpha")?.status, "ready");
  session.onAcceptedMessage("beta", readyMessage("beta"));
  assert.equal(session.visibleSpaceId, "beta");
  assert.equal(session.committedSpaceId, "beta");
  assert.equal(session.get("alpha")?.src, viewSrc("alpha"));
});

test("failed pending view keeps the previous ready frame mounted", () => {
  const session = new ViewSession();
  const a = session.requestSpace(space({ id: "alpha" }));
  session.applyView("alpha", a.token, viewOf("alpha"));
  session.onAcceptedMessage("alpha", readyMessage("alpha"));
  const b = session.requestSpace(space({ id: "beta", status: "running" }));
  session.applyView("beta", b.token, viewOf("beta"));
  session.onAcceptedMessage("beta", { ...readyMessage("beta"), state: "failed", message: "boom" });
  assert.equal(session.visibleSpaceId, "alpha");
  assert.equal(session.committedSpaceId, "alpha");
  assert.equal(session.get("alpha")?.status, "ready");
  assert.equal(session.get("beta")?.status, "failed");
  assert.equal(session.viewError?.spaceId, "beta");
  session.onAcceptedMessage("beta", readyMessage("beta"));
  assert.equal(session.visibleSpaceId, "alpha");
  assert.equal(session.committedSpaceId, "alpha");
  assert.equal(session.get("beta")?.status, "failed");
});

test("same space reuses iframe; generation change destroys it", () => {
  const session = new ViewSession();
  const first = session.requestSpace(space({ id: "alpha", generation: 1 }));
  session.applyView("alpha", first.token, viewOf("alpha", 1));
  session.onAcceptedMessage("alpha", readyMessage("alpha"));
  const reuse = session.requestSpace(space({ id: "alpha", generation: 1 }));
  assert.equal(reuse.load, false);
  assert.equal(reuse.reuseReady, true);
  const destroyed = session.syncGenerations([space({ id: "alpha", generation: 2 })]);
  assert.deepEqual(destroyed, ["alpha"]);
  assert.equal(session.get("alpha"), undefined);
  assert.equal(session.visibleSpaceId, null);
});

test("controller last view() wins and does not unload the previous ready iframe", async () => {
  const pending = new Map<string, ReturnType<typeof deferred<WorkbenchViewInfo>>>();
  const api = fakeApi({
    state: async () => state({ spaces: [manager, space({ id: "alpha" }), space({ id: "beta" })] }),
    view: (spaceId) => {
      const item = deferred<WorkbenchViewInfo>();
      pending.set(spaceId, item);
      return item.promise;
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.selectSpace("alpha");
  ctrl.selectSpace("beta");
  assert.equal(pending.size, 2);
  pending.get("alpha")!.resolve(viewOf("alpha"));
  await flush();
  let ui = ctrl.getSnapshot();
  const alphaFrame = ui.frames.find((frame) => frame.spaceId === "alpha");
  assert.equal(alphaFrame?.status, "pending");
  assert.equal(ui.visibleSpaceId, null);
  assert.equal(ui.selected, "home");
  pending.get("beta")!.resolve(viewOf("beta"));
  await flush();
  const iframeBeta = { id: "beta-win" };
  ctrl.registerIframeWindow("beta", 1, iframeBeta);
  ctrl.handleMessage({
    origin: CHILD_ORIGIN,
    source: iframeBeta,
    data: readyMessage("beta"),
  });
  ui = ctrl.getSnapshot();
  assert.equal(ui.visibleSpaceId, "beta");
  assert.equal(ui.selected, "beta");
  assert.ok(ui.frames.some((frame) => frame.spaceId === "alpha" && frame.src));
  assert.equal(ui.frames.find((frame) => frame.spaceId === "alpha")?.status, "pending");
});

test("stale failed handshake does not hide the still-selected ready space", async () => {
  const api = fakeApi({
    state: async () => state({ spaces: [manager, space({ id: "alpha" }), space({ id: "beta" })] }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  await becomeReady(ctrl, "alpha", { id: "a" });
  ctrl.selectSpace("beta");
  await flush();
  const winB = { id: "b" };
  ctrl.registerIframeWindow("beta", 1, winB);
  ctrl.handleMessage({
    origin: "http://127.0.0.1:9999",
    source: winB,
    data: readyMessage("beta"),
  });
  assert.equal(ctrl.getSnapshot().visibleSpaceId, "alpha");
  assert.equal(ctrl.getSnapshot().selected, "alpha");
  ctrl.handleMessage({
    origin: CHILD_ORIGIN,
    source: winB,
    data: { ...readyMessage("beta"), state: "failed" },
  });
  const ui = ctrl.getSnapshot();
  assert.equal(ui.visibleSpaceId, "alpha");
  assert.equal(ui.viewError?.spaceId, "beta");
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "app.errorDetails")));
  assert.ok(html.includes(t("zh", "app.copyError")));
  assert.ok(html.includes(t("zh", "app.openIndependent")));
  assert.ok(html.includes('data-space-id="alpha"'));
  assert.ok(html.includes('data-visible="true"'));
});

test("readonly rejects mutations but still allows queries", async () => {
  const api = fakeApi({
    state: async () =>
      state({
        writable: false,
        reasons: ["owner held by desktop"],
        jobs: [job({ canCancel: false, status: "failed" })],
      }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openCreate();
  assert.equal(api.calls.some((item) => item.method === "submit"), false);
  ctrl.startSpace("alpha");
  ctrl.preview({ kind: "space.stop", spaceId: "alpha" });
  assert.equal(api.calls.filter((item) => item.method === "preview").length, 0);
  assert.equal(api.calls.filter((item) => item.method === "submit").length, 0);
  await ctrl.searchPlugins("demo");
  assert.equal(api.calls.some((item) => item.method === "plugins"), true);
  const html = ready(ctrl);
  assert.ok(html.includes("disabled"));
  assert.ok(html.includes(t("zh", "app.readonly")));
  assert.ok(!html.includes('data-plan-id="plan-1"'));
});

test("preview confirmation is required; preview errors do not look like success", async () => {
  const api = fakeApi({
    preview: async () => {
      throw Object.assign(new Error("nope"), { code: "workbench/invalid-input" });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.preview({ kind: "space.stop", spaceId: "alpha" });
  await flush();
  let ui = ctrl.getSnapshot();
  assert.equal(ui.pendingPlan, null);
  assert.equal(ui.planError, `${t("zh", "app.invalidInput")}\n${t("zh", "app.errorReason", { reason: "nope" })}`);
  let html = ready(ctrl);
  assert.ok(html.includes(t("zh", "app.invalidInput")));
  assert.ok(!html.includes(t("zh", "plan.title")));
  assert.equal(api.calls.some((item) => item.method === "submit"), false);

  const ok = fakeApi();
  const ctrl2 = controller(ok);
  await ctrl2.poll();
  ctrl2.preview({ kind: "space.delete", spaceId: "alpha", removeData: false });
  await flush();
  html = renderToStaticMarkup(
    React.createElement(WorkbenchView, { ui: ctrl2.getSnapshot(), controller: ctrl2 }),
  );
  assert.ok(html.includes(t("zh", "plan.title.spaceDelete", { name: "Alpha (alpha)" })));
  assert.ok(html.includes(t("zh", "plan.scope")));
  assert.ok(html.includes(t("zh", "plan.targets")));
  assert.ok(html.includes(t("zh", "plan.running")));
  assert.ok(html.includes(t("zh", "plan.changes")));
  assert.ok(html.includes(t("zh", "plan.destructive")));
  assert.ok(html.includes('data-plan-id="plan-1"'));
  ctrl2.confirmPlan();
  await flush();
  const executed = ok.calls.find((item) => item.method === "submit");
  assert.deepEqual((executed?.arg as { command: WorkbenchCommand }).command, {
    kind: "plan.execute",
    planId: "plan-1",
  });

  const api3 = fakeApi();
  const ctrl3 = controller(api3);
  await ctrl3.poll();
  ctrl3.confirmPlan();
  assert.equal(ctrl3.getSnapshot().planError, t("zh", "app.noPlan"));
  assert.equal(api3.calls.filter((item) => item.method === "submit").length, 0);
});

test("D1: an idle stop or restart runs from its preview, a destructive plan of the same kind still asks", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.preview({ kind: "space.stop", spaceId: "alpha" });
  await flush();
  assert.equal(ctrl.getSnapshot().pendingPlan, null, "a plain stop does not open the confirmation dialog");
  const executed = api.calls.find((item) => item.method === "submit");
  assert.deepEqual((executed?.arg as { command: WorkbenchCommand }).command, { kind: "plan.execute", planId: "plan-1" });
  assert.ok(!ready(ctrl).includes(t("zh", "plan.title")));

  const restart = fakeApi();
  const ctrl2 = controller(restart);
  await ctrl2.poll();
  ctrl2.preview({ kind: "space.restart", spaceId: "alpha" });
  await flush();
  assert.equal(ctrl2.getSnapshot().pendingPlan, null, "a plain restart does not open the confirmation dialog");
  assert.equal(restart.calls.filter((item) => item.method === "submit").length, 1);

  const destructive = fakeApi({
    preview: async (request: WorkbenchPlanRequest) => planOf(request, { id: "plan-destructive", destructive: true }),
  });
  const ctrl3 = controller(destructive);
  await ctrl3.poll();
  ctrl3.preview({ kind: "space.stop", spaceId: "alpha" });
  await flush();
  assert.ok(ctrl3.getSnapshot().pendingPlan, "a destructive stop still asks for a confirmation");
  assert.equal(destructive.calls.filter((item) => item.method === "submit").length, 0);
  assert.ok(ready(ctrl3).includes(t("zh", "plan.destructive")));
});

test("a busy or unknown task requires explicit interruption consent", async () => {
  for (const taskActivity of ["busy", "unknown"] as const) {
    const api = fakeApi({ preview: async (request: WorkbenchPlanRequest) => planOf(request, { taskActivity }) });
    const ctrl = controller(api); await ctrl.poll();
    ctrl.preview({ kind: "space.stop", spaceId: "alpha" }); await flush();
    assert.equal(ctrl.getSnapshot().pendingPlan?.plan.taskActivity, taskActivity);
    assert.equal(api.calls.filter(item => item.method === "submit").length, 0);
    ctrl.confirmPlan(); await flush();
    assert.equal(api.calls.filter(item => item.method === "submit").length, 1);
  }
});

test("D1: a delete, a version switch and a service shutdown still ask for a confirmation", async () => {
  for (const request of [
    { kind: "space.delete", spaceId: "alpha", removeData: false },
    { kind: "space.runtime.set", spaceId: "alpha", version: "0.2.0" },
    { kind: "service.shutdown" },
    { kind: "snapshot.create" },
    { kind: "runtime.remove", version: "0.2.0" },
  ] as WorkbenchPlanRequest[]) {
    const api = fakeApi();
    const ctrl = controller(api);
    await ctrl.poll();
    ctrl.preview(request);
    await flush();
    assert.ok(ctrl.getSnapshot().pendingPlan, `${request.kind} keeps its confirmation`);
    assert.equal(api.calls.filter((item) => item.method === "submit").length, 0);
  }
});

test("the settings navigation exposes four flat destinations and keeps plugins and blueprints out of the top level", async () => {
  const ctrl = controller();
  await ctrl.poll();
  ctrl.openSettings();
  const ids = (segment: string): string[] => [...segment.matchAll(/role="tab" id="settings-tab-([^"]+)"/g)].map((match) => match[1]);
  const html = ready(ctrl);
  assert.deepEqual(ids(html), ["spaces", "templates", "general", "overview"]);
  assert.ok(!html.includes('id="dsh-wb-settings-maintenance"'), "collapsible maintenance group is gone");
  assert.ok(!html.includes('id="settings-tab-plugins"'));
  assert.ok(!html.includes('id="settings-tab-blueprints"'));
  assert.ok(!html.includes('id="settings-tab-snapshots"'));
  assert.ok(!html.includes('id="settings-tab-runtime"'));
  assert.ok(!html.includes('id="settings-tab-advanced"'));
});

test("the maintenance page splits status, backups, runtime versions and service into sub-tabs while keeping the left nav on maintenance", async () => {
  const ctrl = controller();
  await ctrl.poll();
  ctrl.openSettings();
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "settings.nav.maintenance")), "the maintenance group is always visible");
  for (const alias of ["runtime", "snapshots", "advanced", "overview"] as const) {
    ctrl.setSettingsTab(alias);
    await flush();
    const page = ready(ctrl);
    assert.match(page, /id="settings-tab-overview"[^>]*aria-selected="true"/);
    assert.match(page, new RegExp(`id="maintenance-tab-${alias}"[^>]*aria-selected="true"`));
  }
  const active = ready(ctrl);
  assert.ok(active.includes('data-maintenance-tablist="true"'));
  assert.ok(active.includes('data-maintenance-section="backups"'));
  assert.ok(active.includes('data-maintenance-section="runtime"'));
  assert.ok(active.includes('data-settings-service="true"'));
});

test("manager cannot be deleted and cannot take ordinary plugin installs", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.preview({ kind: "space.delete", spaceId: "hub", removeData: false });
  await flush();
  assert.equal(api.calls.filter((item) => item.method === "preview").length, 0);
  assert.equal(ctrl.getSnapshot().planError, t("zh", "app.managerProtected"));
  ctrl.setPluginSpace("hub");
  ctrl.setPluginCatalog("catalog.demo", "1.2.3");
  ctrl.previewInstallSelected();
  await flush();
  assert.equal(api.calls.filter((item) => item.method === "preview").length, 0);
});

test("delete preview defaults removeData to false", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.preview({ kind: "space.delete", spaceId: "alpha", removeData: false });
  await flush();
  assert.deepEqual(api.calls.find((item) => item.method === "preview")?.arg, {
    kind: "space.delete",
    spaceId: "alpha",
    removeData: false,
  });
});

test("cancel is only offered when canCancel is true", async () => {
  const api = fakeApi({
    state: async () =>
      state({
        jobs: [
          job({ id: "c1", canCancel: true, status: "running" }),
          job({ id: "c2", canCancel: false, status: "running", kind: "space.create" }),
        ],
      }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.setHomeTab("overview");
  const html = ready(ctrl);
  assert.ok(html.includes('data-job-id="c1"'));
  assert.ok(html.includes(t("zh", "jobs.cancel")));
  const cancelCount = html.split(t("zh", "jobs.cancel")).length - 1;
  assert.equal(cancelCount, 1);
  ctrl.cancelJob("c2");
  await flush();
  assert.equal(api.calls.filter((item) => item.method === "cancel").length, 0);
  ctrl.cancelJob("c1");
  await flush();
  assert.equal(api.calls.filter((item) => item.method === "cancel").length, 1);
});

test("localStorage only keeps selectedId, locale and theme", async () => {
  const storage = memoryStorage();
  const ctrl = controller(fakeApi(), { storage });
  await ctrl.poll();
  ctrl.setLocale("en");
  ctrl.setTheme("light");
  ctrl.selectHome();
  const raw = storage.getItem(WORKBENCH_STORAGE_KEY);
  assert.equal(persistLooksSafe(raw), true);
  assert.ok(raw && !raw.includes("http"));
  assert.ok(raw && !raw.includes("token"));
  assert.ok(raw && !raw.includes("entryPath"));
  assert.ok(raw && !raw.includes("channel"));
  assert.ok(raw && !raw.includes("YQ=="));
  const parsed = readPersist(storage);
  assert.equal(parsed.locale, "en");
  assert.equal(parsed.theme, "light");
  assert.equal(parsed.selectedId, "__home__");
  writePersist(storage, { selectedId: "alpha", locale: "zh", theme: "dark" });
  assert.deepEqual(JSON.parse(storage.getItem(WORKBENCH_STORAGE_KEY) ?? "{}"), {
    selectedId: "alpha",
    locale: "zh",
    theme: "dark",
  });
});

test("poll delay is 500ms when jobs are active, 1s otherwise, slower when hidden", () => {
  assert.equal(pollDelayMs(true, false), 500);
  assert.equal(pollDelayMs(false, false), 1000);
  assert.equal(pollDelayMs(true, true), 2000);
  assert.equal(pollDelayMs(false, true), 4000);
});

test("icons accept known glyphs and local data images, reject remote URLs", () => {
  assert.equal(validateWorkbenchIcon("").ok, true);
  assert.equal(validateWorkbenchIcon("whale").ok, true);
  assert.equal(validateWorkbenchIcon("code").ok, true);
  assert.equal(validateWorkbenchIcon("https://example.com/x.png").ok, false);
  assert.equal(validateWorkbenchIcon("http://127.0.0.1/x.png").ok, false);
  const png = `data:image/png;base64,${Buffer.from("abc").toString("base64")}`;
  assert.equal(validateWorkbenchIcon(png).ok, true);
  const svg = `data:image/svg+xml;base64,${Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64")}`;
  assert.equal(validateWorkbenchIcon(svg).ok, false);
});

test("SSR WorkbenchApp defaults to Chinese loading chrome with a 72px rail", () => {
  const html = renderToStaticMarkup(React.createElement(WorkbenchApp, { api: fakeApi() }));
  assert.ok(html.includes('data-locale="zh"'));
  assert.ok(html.includes("dsh-wb-rail"));
  assert.ok(html.includes("width: 72px"));
  assert.ok(html.includes(t("zh", "app.loading")));
  assert.ok(html.includes("中文"));
  assert.ok(html.includes("<style>"));
});

test("plugin read failures keep their own reasons", async () => {
  const api = fakeApi({
    plugins: async () => {
      throw Object.assign(new Error("plugin index unreadable"), { code: "workbench/failed" });
    },
    product: async (request) => {
      if (request.method === "catalog") {
        throw Object.assign(new Error("Plugin catalog cache could not be read."), { code: "workbench/failed" });
      }
      return productResult(request);
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.setHomeTab("plugins");
  await flush();
  const html = ready(ctrl);
  const snapshot = ctrl.getSnapshot();
  assert.equal(snapshot.commandError, null);
  assert.match(snapshot.readError.catalog ?? "", /Plugin catalog cache could not be read/);
  assert.match(snapshot.readError.plugins ?? "", /plugin index unreadable/);
  assert.equal(snapshot.readError.library, undefined);
  assert.ok(html.includes("Plugin catalog cache could not be read."));
  assert.ok(html.includes("plugin index unreadable"));
  assert.equal(
    localizeError("zh", { code: "workbench/unavailable", message: "The supervisor is releasing run rights." }).includes("releasing run rights"),
    true,
  );
  assert.equal(
    localizeError("zh", { code: "workbench/unavailable", message: "The workbench service could not complete this request." }),
    t("zh", "app.unavailable"),
  );
});

test("community catalog cards show authors, sources and exact tested versions beside the npm entry", async () => {
  const ctrl = controller(fakeApi({
    product: async request => {
      const result = await productResult(request);
      if (result.method === "catalog") {
        result.catalog.entries[0] = {
          ...result.catalog.entries[0], title: "社区工具", titleEn: "Community tool", owner: "Community Author",
          dshRange: ">=0.2.0-rc.2",
          tested: { pluginVersion: "1.0.0", dshVersion: "0.2.2-rc.1", platform: "Windows", evidence: "https://example.com/report" },
        };
      }
      return result;
    },
  }));
  await ctrl.poll();
  ctrl.openDetail("alpha");
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes("社区工具"));
  assert.ok(html.includes("Community Author"));
  assert.ok(html.includes("已实测：1.0.0"));
  assert.ok(html.includes('href="https://example.com/report"'));
  assert.ok(html.includes('data-plugin-direct-install="true"'));
  assert.ok(html.includes("按 npm 包名安装"));
});

test("status tab shows workbench log lines", async () => {
  const api = fakeApi({
    product: async (request) => {
      if (request.method === "logs") {
        return {
          method: "logs" as const,
          entries: [
            {
              at: "2026-09-22T00:00:00.000Z",
              level: "error" as const,
              area: "http",
              event: "product.catalog",
              code: "workbench/failed",
              message: "Plugin catalog cache could not be read.",
            },
          ],
          logError: null,
          observation: OBSERVATION,
        };
      }
      return productResult(request);
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.setHomeTab("overview");
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "logs.title")));
  assert.ok(html.includes("product.catalog"));
  assert.ok(html.includes("Plugin catalog cache could not be read."));
  assert.equal(ctrl.copyWorkbenchLog().includes("Plugin catalog cache could not be read."), true);
});

test("SSR ready home shows management actions and plugin install wording", async () => {
  const ctrl = controller();
  await ctrl.poll();
  ctrl.setHomeTab("plugins");
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "app.home")));
  // The plugin tab is the plugin section of the space detail page now.
  assert.ok(html.includes('data-space-detail="true"'));
  assert.ok(html.includes(t("zh", "plugins.installLatest")) || html.includes(t("zh", "plugins.chooseVersion")));
  assert.ok(html.includes(t("zh", "plugins.toggleHint")));
  assert.ok(!html.includes(t("zh", "plugins.cleanup")), "cleanup is hidden unless dsh-spaces is misinstalled");
  ctrl.setHomeTab("snapshots");
  await flush();
  const snap = ready(ctrl);
  assert.ok(snap.includes(t("zh", "snapshots.create")));
  assert.ok(snap.includes('data-snapshots-offline-hint="true"'));
  assert.ok(!snap.includes("snapshot.restore"));
  ctrl.setHomeTab("runtime");
  await flush();
  const runtime = ready(ctrl);
  assert.ok(runtime.includes(t("zh", "runtime.installed")));
  assert.ok(!runtime.includes("预览安装"), "the runtime inventory has no global installation action");
});

function runtimeEntry(partial: Partial<WorkbenchRuntime> & Pick<WorkbenchRuntime, "version">): WorkbenchRuntime {
  return { installed: false, host: false, pinnedBy: [], removable: false, compatible: true, ...partial };
}

test("detail dialog shows the pinned DSH version and offers only compatible upgrades", async () => {
  const api = fakeApi({
    state: async () => state({ spaces: [manager, space({ id: "alpha", dshVersion: "0.9.9" })] }),
    runtimes: async () => {
      calls.push({ method: "runtimes", arg: undefined });
      return [
        runtimeEntry({ version: "0.9.8", installed: true }),
        runtimeEntry({ version: "0.9.9", installed: true, pinnedBy: ["alpha"] }),
        runtimeEntry({ version: "0.9.10" }),
        runtimeEntry({ version: "1.0.0", compatible: false }),
      ];
    },
  });
  const calls = api.calls;
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openDetail("alpha");
  await flush();
  await flush();
  assert.ok(api.calls.some((item) => item.method === "runtimes"), "opening details loads runtimes");
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "detail.dshVersion")));
  assert.ok(html.includes('value="0.9.9"'));
  assert.ok(html.includes('value="0.9.10"'));
  assert.ok(!html.includes('value="0.9.8"'), "lower versions are filtered out");
  assert.ok(!html.includes('value="1.0.0"'), "incompatible versions are filtered out");
  assert.ok(html.includes(t("zh", "detail.dshHint")));
  assert.ok(html.includes(`<button type="button" class="dsh-wb-btn">${t("zh", "detail.dshPreview")}</button>`));
});

test("detail dialog offers nothing below the supported minimum when the pin is older", async () => {
  const ctrl = controller(fakeApi({
    state: async () => state({ dshVersion: "0.1.5-rc.1", spaces: [manager, space({ id: "alpha", dshVersion: "0.1.5-rc.1" })] }),
    runtimes: async () => [
      runtimeEntry({ version: "0.1.5-rc.1", installed: true, host: true }),
      runtimeEntry({ version: "0.2.0-rc.1" }),
      runtimeEntry({ version: "0.2.0-rc.2", installed: true }),
      runtimeEntry({ version: "0.3.0" }),
    ],
  }));
  await ctrl.poll();
  ctrl.openDetail("alpha");
  await flush();
  await flush();
  const html = ready(ctrl);
  // The plugin section has its own version list; the DSH section owns this one.
  const select = html.match(/<select[^>]*data-dsh-target="true"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? "";
  assert.notEqual(select, "", "the DSH version select is rendered");
  assert.ok(!select.includes('value="0.1.5-rc.1"'), "a pin below the minimum is not offered");
  assert.ok(!select.includes('value="0.2.0-rc.1"'), "versions below the minimum are not offered");
  assert.ok(select.includes('value="0.2.0-rc.2"'));
  assert.ok(select.includes('value="0.3.0"'));
  assert.match(
    select,
    /<option(?=[^>]*selected)(?=[^>]*value="0\.2\.0-rc\.2")[^>]*>/,
    "the first supported version is preselected",
  );
});

test("detail dialog shows not pinned and defaults to the host version", async () => {
  const ctrl = controller(fakeApi({
    state: async () => state({ dshVersion: "0.2.0-rc.2", spaces: [manager, alpha] }),
    runtimes: async () => [runtimeEntry({ version: "0.2.0-rc.2", installed: true, host: true })],
  }));
  await ctrl.poll();
  ctrl.openDetail("alpha");
  await flush();
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "detail.dshNotPinned")));
  assert.ok(html.includes('value="0.2.0-rc.2"'));
});

test("detail DSH section is hidden for the manager", async () => {
  const ctrl = controller();
  await ctrl.poll();
  ctrl.openDetail("hub");
  await flush();
  await flush();
  const html = ready(ctrl);
  const detail = html.slice(html.indexOf('data-space-detail="true"'));
  assert.notEqual(detail, "", "the detail page is rendered");
  assert.ok(!detail.includes(t("zh", "detail.dshVersion")));
});

function pluginSelect(html: string): string {
  return html.match(/<select[^>]*data-space-plugin-versions="true"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? "";
}

test("the plugin section fills the version list and previews the exact version", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openDetail("alpha");
  await flush();
  await flush();
  assert.ok(
    api.calls.some((item) => item.method === "product" && (item.arg as { method?: string })?.method === "plugin.versions"),
    "the installed plugin's published versions are read",
  );
  ctrl.setPluginCatalog("catalog.demo");
  await flush();
  await flush();
  const html = ready(ctrl);
  const select = pluginSelect(html);
  assert.notEqual(select, "", "the version list is rendered");
  assert.ok(select.includes('value="2.0.0"'));
  assert.ok(select.includes('value="1.2.3"'));
  assert.match(
    select,
    /<option(?=[^>]*selected)(?=[^>]*value="2\.0\.0")[^>]*>/,
    "the newest published version is preselected",
  );
  assert.equal(ctrl.getSnapshot().pluginVersion, "2.0.0");
  ctrl.previewInstallSelected("alpha");
  await flush();
  assert.deepEqual(api.calls.filter((item) => item.method === "preview").map((item) => item.arg), [
    { kind: "plugin.install", spaceIds: ["alpha"], catalogId: "catalog.demo", version: "2.0.0" },
  ]);
});

test("a plugin row offers an upgrade only when a newer version exists", async () => {
  const api = fakeApi({
    plugins: async () => [
      {
        id: "catalog.demo",
        title: "Demo",
        packageName: "demo",
        description: "A plugin",
        version: "2.0.0",
        installedIn: ["alpha"],
        protected: false,
      },
    ],
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openDetail("alpha");
  await flush();
  await flush();
  const current = ready(ctrl);
  assert.ok(!current.includes('data-space-plugin-upgrade="catalog.demo"'), "the newest version needs no upgrade");

  const older = controller(fakeApi({
    plugins: async () => [
      {
        id: "catalog.demo",
        title: "Demo",
        packageName: "demo",
        description: "A plugin",
        version: "1.2.3",
        installedIn: ["alpha"],
        protected: false,
      },
    ],
  }));
  await older.poll();
  older.openDetail("alpha");
  await flush();
  await flush();
  const html = ready(older);
  assert.ok(html.includes('data-space-plugin-upgrade="catalog.demo"'), "an older version can be upgraded");
  assert.ok(html.includes(t("zh", "plugins.upgradeTo", { version: "2.0.0" })));
});

test("a failed version read keeps its reason next to the version list", async () => {
  const api = fakeApi({
    product: async (request) => {
      if (request.method === "plugin.versions") {
        throw Object.assign(new Error("The registry could not be read."), { code: "workbench/failed" });
      }
      return productResult(request);
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openDetail("alpha");
  await flush();
  await flush();
  ctrl.setPluginCatalog("catalog.demo");
  await flush();
  await flush();
  const html = ready(ctrl);
  const error = html.match(/<p[^>]*data-space-plugin-versions-error="true"[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.notEqual(error, "", "the failed read is rendered");
  assert.ok(error.includes("The registry could not be read."));
  assert.doesNotMatch(error, /opacity\s*:\s*0/, "the failure is visible from the first frame");
  assert.equal(ctrl.getSnapshot().pluginVersion, "", "no version is guessed");
});

function rowButtons(html: string, spaceId: string): string[] {
  const marker = `class="dsh-wb-space-row" data-space-id="${spaceId}"`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `settings row for ${spaceId}`);
  const segment = html.slice(start, html.indexOf("</div>", start));
  return [...segment.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
    .filter((match) => !match[0].includes("dsh-wb-space-row-main"))
    .map((match) => match[1]);
}

test("settings space rows offer open, ordering and manage actions; lifecycle actions live on the detail page", async () => {
  const ctrl = controller(fakeApi({
    state: async () =>
      state({
        spaces: [
          manager,
          alpha,
          space({ id: "beta", status: "stopped" }),
          space({ id: "gamma", status: "crashed" }),
          space({ id: "delta", status: "starting" }),
          space({ id: "rogue", managed: false }),
        ],
      }),
  }));
  await ctrl.poll();
  ctrl.setHomeTab("spaces");
  const html = ready(ctrl);
  assert.ok(!html.includes('data-space-id="hub"'), "the manager has no settings row");
  for (const id of ["alpha", "beta", "gamma", "delta", "rogue"]) {
    assert.ok(html.includes(`data-space-open-detail="${id}"`), `clickable row main for ${id}`);
    assert.ok(html.includes(`data-space-row-actions="${id}"`), `row menu trigger for ${id}`);
    assert.deepEqual(rowButtons(html, id), ["⋯"]);
  }
  ctrl.openDetail("alpha");
  await flush();
  assert.ok(!ready(ctrl).includes('data-space-section="export"'), "export card moved out of space detail");
});

test("the space detail page offers the per-status actions and hides them for the manager and unmanaged spaces", async () => {
  const ctrl = controller(fakeApi({
    state: async () =>
      state({
        spaces: [manager, alpha, space({ id: "beta", status: "stopped" }), space({ id: "rogue", managed: false })],
      }),
  }));
  await ctrl.poll();
  const [enter, start, stop, restart, del] = [
    t("zh", "detail.enter"), t("zh", "app.start"), t("zh", "app.stop"), t("zh", "app.restart"), t("zh", "app.delete"),
  ];
  const detailButtons = (spaceId: string, section: string): string[] => {
    const html = ready(ctrl);
    const detail = html.indexOf(`data-space-detail="true" data-space-id="${spaceId}"`);
    assert.notEqual(detail, -1, `detail page for ${spaceId}`);
    const to = section === "header" ? html.indexOf('data-space-tablist', detail) : html.indexOf('data-space-section="', html.indexOf(`data-space-section="${section}"`, detail) + 10);
    const region = section === "header" ? html.slice(detail, to === -1 ? html.length : to)
      : html.slice(html.indexOf(`data-space-section="${section}"`, detail), to === -1 ? html.length : to);
    const from = section === "header" ? region.indexOf('dsh-wb-actions') : 0;
    if (section === "header" && from === -1) return [];
    const segment = region.slice(from);
    return [...segment.matchAll(/>([^<]*)<\/button>/g)].map((match) => match[1]);
  };
  ctrl.openDetail("alpha");
  await flush();
  await flush();
  assert.deepEqual(detailButtons("alpha", "header"), [enter, stop, restart]);
  assert.deepEqual(detailButtons("alpha", "danger"), [del]);
  ctrl.openDetail("beta");
  await flush();
  await flush();
  assert.deepEqual(detailButtons("beta", "header"), [enter, start]);
  assert.deepEqual(detailButtons("beta", "danger"), [del]);
  ctrl.openDetail("rogue");
  await flush();
  await flush();
  assert.deepEqual(detailButtons("rogue", "header"), []);
  assert.deepEqual(detailButtons("rogue", "danger"), []);
  ctrl.openDetail("hub");
  await flush();
  await flush();
  assert.deepEqual(detailButtons("hub", "header"), []);
  assert.deepEqual(detailButtons("hub", "danger"), []);
});

test("detail page actions are disabled without mutation rights or while busy", async () => {
  const overviewButtons = (html: string, spaceId: string): Array<{ tag: string; label: string }> => {
    const detail = html.indexOf(`data-space-detail="true" data-space-id="${spaceId}"`);
    assert.notEqual(detail, -1, `detail page for ${spaceId}`);
    const to = html.indexOf('data-space-tablist', detail);
    const region = html.slice(detail, to === -1 ? html.length : to);
    const from = region.indexOf('dsh-wb-actions');
    if (from === -1) return [];
    const segment = region.slice(from);
    return [...segment.matchAll(/<button[^>]*>([^<]*)<\/button>/g)]
      .map((match) => ({ tag: match[0], label: match[1] }));
  };

  const readonly = controller(fakeApi({
    state: async () => state({ writable: false, spaces: [manager, alpha] }),
  }));
  await readonly.poll();
  readonly.openDetail("alpha");
  await flush();
  await flush();
  const readonlyButtons = overviewButtons(ready(readonly), "alpha");
  assert.deepEqual(readonlyButtons.map((button) => button.label), [t("zh", "detail.enter"), t("zh", "app.stop"), t("zh", "app.restart")]);
  for (const button of readonlyButtons) {
    assert.ok(button.tag.includes("disabled"), button.tag);
  }

  const gate = deferred<WorkbenchPlan>();
  const busy = controller(fakeApi({ preview: () => gate.promise }));
  await busy.poll();
  void busy.preview({ kind: "space.stop", spaceId: "alpha" });
  busy.openDetail("alpha");
  await flush();
  await flush();
  const busyButtons = overviewButtons(ready(busy), "alpha");
  assert.ok(busyButtons.length > 0);
  assert.ok(busyButtons.every((button) => button.tag.includes("disabled")), JSON.stringify(busyButtons));
  gate.resolve(planOf({ kind: "space.stop", spaceId: "alpha" }));
  await flush();
});

test("runtime tab shows pinned users and only offers removal for unused runtimes", async () => {
  const ctrl = controller(fakeApi({
    runtimes: async () => [
      runtimeEntry({ version: "0.2.0-rc.2", installed: true, host: true, pinnedBy: ["alpha", "beta"] }),
      runtimeEntry({ version: "0.3.0", installed: true, removable: true }),
      runtimeEntry({ version: "0.4.0" }),
    ],
  }));
  await ctrl.poll();
  ctrl.setHomeTab("runtime");
  await flush();
  await flush();
  const html = ready(ctrl);
  const runtime = html.match(/<section[^>]*data-maintenance-section="runtime"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.ok(runtime.includes("被 Alpha、Beta 使用"));
  assert.ok(!html.includes("预览安装"), "missing runtimes are installed only through a space version change");
  assert.equal(runtime.split(`>${t("zh", "runtime.remove")}<`).length - 1, 1, "remove only for the removable runtime");
});

test("create dialog keeps Web version selection and hides sealed Browser entry points", async () => {
  const ctrl = controller();
  await ctrl.poll();
  ctrl.openCreate();
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "create.webVersion")));
  assert.ok(!html.includes('name="base"'));
  assert.doesNotMatch(html, /Browser|浏览器空间|封存/);
  assert.ok(html.includes('name="baseVersion"'));
});

test("workspace iframe src is only the authorized view and pending stays hidden", async () => {
  const ctrl = controller(
    fakeApi({
      state: async () => state({ spaces: [manager, space({ id: "alpha" }), space({ id: "beta" })] }),
    }),
  );
  await ctrl.poll();
  ctrl.selectSpace("alpha");
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes(`src="${viewSrc("alpha")}"`));
  assert.ok(!html.includes("token="));
  assert.ok(html.includes('hidden=""') || html.includes("hidden"));
});

test("overview keeps failed jobs and reasons without a recovery page", async () => {
  const api = fakeApi({
    state: async () =>
      state({
        writable: false,
        reasons: ["desktop holds write access"],
        jobs: [job({ status: "failed", canCancel: false, message: "needs resume" })],
      }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.setHomeTab("overview");
  const readyHtml = ready(ctrl);
  assert.ok(readyHtml.includes("desktop holds write access"));
  assert.ok(readyHtml.includes("needs resume"));
  assert.ok(!readyHtml.includes("工作台入口"));
  assert.ok(!readyHtml.includes("重试"));
});

test("create validates name and does not submit reserved ids", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.createSpace({ name: "Web" });
  assert.equal(api.calls.filter((item) => item.method === "submit").length, 0);
  ctrl.createSpace({ name: "ok-space", displayName: "Ok", icon: "code" });
  await flush();
  const created = api.calls.find((item) => item.method === "submit");
  assert.deepEqual((created?.arg as { command: WorkbenchCommand }).command, {
    kind: "space.create",
    input: { name: "ok-space", displayName: "Ok", icon: "code" },
  });
  assert.equal(ctrl.getSnapshot().selected, "home");
  assert.equal(ctrl.getSnapshot().createdNotice?.spaceId, "created");
});

test("host selection reads current authority once when its local inventory is stale", async () => {
  let current = state({ spaces: [manager] }), reads = 0;
  const api = fakeApi({ state: async () => { reads++; return current; } });
  const ctrl = controller(api); await ctrl.poll();
  current = state({ spaces: [manager, alpha] });
  assert.equal(await ctrl.selectRunningSpace('alpha'), true); await flush();
  assert.equal(reads, 2);
  assert.equal(ctrl.getSnapshot().pendingId, 'alpha');
  assert.equal(api.calls.filter(call => call.method === 'submit').length, 0);
  assert.equal(api.calls.filter(call => call.method === 'view').length, 1);
});

test("host selection of a now-stopped space never starts it or loads a view", async () => {
  let current = state({ spaces: [manager, alpha] });
  const api = fakeApi({ state: async () => current }); const ctrl = controller(api); await ctrl.poll();
  current = state({ spaces: [manager, space({ id: 'alpha', status: 'stopped' })] });
  assert.equal(await ctrl.selectRunningSpace('alpha'), false); await flush();
  assert.equal(api.calls.some(call => call.method === 'submit' || call.method === 'view'), false);
  assert.equal(ctrl.getSnapshot().pendingId, null);
});

test("adjacent host selection during first start advances the view without rejecting its own intent", async () => {
  let current = state({ spaces: [manager, space({ id: "alpha", status: "stopped", generation: 0 })] });
  let reads = 0, views = 0;
  const api = fakeApi({ state: async () => { reads++; return current; },
    view: async () => { views++; return viewOf("alpha"); } });
  const ctrl = controller(api); await ctrl.poll();
  ctrl.selectSpace("alpha"); await flush();
  const readsBeforeSelection = reads;
  current = state({ spaces: [manager, alpha] });
  assert.equal(await ctrl.selectRunningSpace("alpha"), true); await flush();
  assert.equal(reads, readsBeforeSelection + 1); assert.equal(views, 1);
  assert.equal(api.calls.filter(call => call.method === "submit").length, 1);
  const child = {}; ctrl.registerIframeWindow("alpha", 1, child);
  ctrl.handleMessage({ source: child, origin: CHILD_ORIGIN, data: readyMessage("alpha") });
  assert.equal(ctrl.getSnapshot().selected, "alpha");
  assert.equal(ctrl.getSnapshot().pendingId, null);
  assert.equal(ctrl.getSnapshot().viewError, null);
});

test("same-target selection shares its in-flight authorized view and handshake", async () => {
  const gate = deferred<WorkbenchViewInfo>(); let views = 0;
  const api = fakeApi({ view: () => { views++; return gate.promise; } });
  const ctrl = controller(api); await ctrl.poll();
  ctrl.selectSpace("alpha");
  assert.equal(await ctrl.selectRunningSpace("alpha"), true);
  assert.equal(views, 1);
  gate.resolve(viewOf("alpha")); await flush();
  const child = {}; ctrl.registerIframeWindow("alpha", 1, child);
  ctrl.handleMessage({ source: child, origin: CHILD_ORIGIN, data: readyMessage("alpha") });
  assert.equal(ctrl.getSnapshot().selected, "alpha");
  assert.equal(ctrl.getSnapshot().viewError, null);
});

test("a poll completing first start during the host authority read does not supersede the user choice", async () => {
  let current = state({ spaces: [manager, space({ id: "alpha", status: "stopped", generation: 0 })] });
  const api = fakeApi({ state: async () => current });
  const ctrl = controller(api); await ctrl.poll();
  ctrl.selectSpace("alpha"); await flush();
  const gate = deferred<WorkbenchState>();
  api.state = () => gate.promise;
  const selecting = ctrl.selectRunningSpace("alpha");
  current = state({ spaces: [manager, alpha] });
  api.state = async () => current;
  await ctrl.poll(); await flush();
  gate.resolve(current);
  assert.equal(await selecting, true); await flush();
  assert.equal(api.calls.filter(call => call.method === "view").length, 1);
  const child = {}; ctrl.registerIframeWindow("alpha", 1, child);
  ctrl.handleMessage({ source: child, origin: CHILD_ORIGIN, data: readyMessage("alpha") });
  assert.equal(ctrl.getSnapshot().selected, "alpha");
  assert.equal(ctrl.getSnapshot().viewError, null);
});

test("late host selection state cannot navigate after a newer choice", async () => {
  const pending = deferred<WorkbenchState>(); const api = fakeApi(); const ctrl = controller(api); await ctrl.poll();
  api.state = () => pending.promise; let current = true;
  const selection = ctrl.selectRunningSpace('alpha', () => current);
  current = false; ctrl.selectHome(); pending.resolve(state());
  assert.equal(await selection, false); await flush();
  assert.equal(ctrl.getSnapshot().selected, 'home');
  assert.equal(api.calls.some(call => call.method === 'view' || call.method === 'submit'), false);
});

test("local Home choice invalidates a pending host selection even when its outer request is current", async () => {
  const pending = deferred<WorkbenchState>(); const api = fakeApi(); const ctrl = controller(api); await ctrl.poll();
  api.state = () => pending.promise;
  const selection = ctrl.selectRunningSpace('alpha', () => true);
  ctrl.selectHome(); pending.resolve(state());
  assert.equal(await selection, false); await flush();
  assert.equal(ctrl.getSnapshot().selected, 'home'); assert.equal(ctrl.getSnapshot().pendingId, null);
  assert.equal(api.calls.some(call => call.method === 'view' || call.method === 'submit'), false);
});

test("unmanaged spaces cannot be started", async () => {
  const api = fakeApi({
    state: async () => state({ spaces: [manager, space({ id: "ext", managed: false, status: "stopped" })] }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.startSpace("ext");
  await flush();
  assert.equal(api.calls.filter((item) => item.method === "submit").length, 0);
  assert.equal(ctrl.getSnapshot().commandError, t("zh", "app.unmanaged"));
});

test("pending click keeps committed home highlight and persist until ready", async () => {
  const storage = memoryStorage();
  const api = fakeApi({
    state: async () => state({ spaces: [manager, space({ id: "alpha" }), space({ id: "beta" })] }),
  });
  const ctrl = controller(api, { storage });
  await ctrl.poll();
  ctrl.selectSpace("alpha");
  await flush();
  const ui = ctrl.getSnapshot();
  assert.equal(ui.selected, "home");
  assert.equal(ui.pendingId, "alpha");
  assert.equal(readPersist(storage).selectedId, "__home__");
  const html = ready(ctrl);
  assert.ok(html.includes('aria-current="true"'));
  assert.ok(html.includes(`src="${viewSrc("alpha")}"`));
  assert.ok(html.includes("dsh-wb-frames"));
});

test("a child frame allows clipboard-write for the child origin only", async () => {
  const ctrl = controller(fakeApi({
    state: async () => state({ spaces: [manager, space({ id: "alpha" })] }),
  }));
  await ctrl.poll();
  ctrl.selectSpace("alpha");
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes("dsh-wb-frames"));
  const tag = html.match(/<iframe[^>]*data-space-id="alpha"[^>]*>/)?.[0] ?? "";
  assert.ok(tag.includes(`src="${viewSrc("alpha")}"`));
  assert.ok(tag.includes(`allow="clipboard-write ${CHILD_ORIGIN}"`));
  assert.ok(!tag.includes("clipboard-write *"));
});

test("clicking a stopped space starts it; readonly cannot start", async () => {
  let current = state({
    spaces: [manager, space({ id: "alpha" }), space({ id: "gamma", status: "stopped" })],
  });
  const started: string[] = [];
  const api = fakeApi({
    state: async () => current,
    submit: async (command, requestId) => {
      if (command.kind === "space.start") started.push(command.spaceId);
      if (command.kind === "space.start" && command.spaceId === "gamma") {
        current = state({
          spaces: [manager, space({ id: "alpha" }), space({ id: "gamma", status: "running" })],
        });
      }
      return job({ id: `job-${requestId}`, requestId, kind: command.kind, status: "succeeded", canCancel: false });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.selectSpace("gamma");
  await flush();
  assert.deepEqual(started, ["gamma"]);
  assert.equal(ctrl.getSnapshot().selected, "home");
  await ctrl.poll();
  await flush();
  assert.ok(ctrl.getSnapshot().frames.some((frame) => frame.spaceId === "gamma"));

  const frozen = fakeApi({
    state: async () =>
      state({
        writable: false,
        spaces: [manager, space({ id: "gamma", status: "stopped" })],
      }),
  });
  const ro = controller(frozen);
  await ro.poll();
  ro.selectSpace("gamma");
  await flush();
  assert.equal(frozen.calls.filter((item) => item.method === "submit").length, 0);
  assert.equal(ro.getSnapshot().selected, "home");
});

test("create success does not auto-switch; enter is explicit for immediate and async jobs", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  await becomeReady(ctrl, "alpha");
  assert.equal(ctrl.getSnapshot().selected, "alpha");
  ctrl.createSpace({ name: "ok-space", displayName: "Ok" });
  await flush();
  assert.equal(ctrl.getSnapshot().selected, "alpha");
  assert.equal(ctrl.getSnapshot().createdNotice?.spaceId, "created");
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "create.done")));
  assert.ok(html.includes(t("zh", "create.enter")));
});

test("a space created from this client is entered directly", async () => {
  let current = state();
  const api = fakeApi({
    state: async () => current,
    submit: async (command, requestId) => {
      if (command.kind === "space.create") {
        const done = job({ id: "create-1", requestId, kind: "space.create", status: "succeeded", canCancel: false, result: { spaceId: "made" } });
        current = state({ spaces: [manager, alpha, space({ id: "made" })], jobs: [done] });
        return done;
      }
      return job({ id: `job-${requestId}`, requestId, kind: command.kind, status: "succeeded", canCancel: false });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.createSpace({ name: "made" });
  await flush();
  await flush();
  const ui = ctrl.getSnapshot();
  assert.equal(ui.createdNotice?.spaceId, "made", "the creation is still reported");
  assert.equal(ui.pendingId, "made", "the created space is opened directly");
  await becomeReady(ctrl, "made");
  assert.equal(ctrl.getSnapshot().selected, "made");
});

test("a create does not take the selection back when the user has moved on", async () => {
  let current = state();
  const api = fakeApi({
    state: async () => current,
    submit: async (command, requestId) => {
      if (command.kind === "space.create") {
        const running = job({ id: "create-1", requestId, kind: "space.create", status: "running", canCancel: true });
        current = state({ spaces: [manager, alpha, space({ id: "made" })], jobs: [running] });
        return running;
      }
      return job({ id: `job-${requestId}`, requestId, kind: command.kind, status: "succeeded", canCancel: false });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.createSpace({ name: "made" });
  await flush();
  // The user goes somewhere else while the create is still running.
  ctrl.selectHome();
  current = state({
    spaces: [manager, alpha, space({ id: "made" })],
    jobs: [job({ id: "create-1", requestId: "uuid-1", kind: "space.create", status: "succeeded", canCancel: false, result: { spaceId: "made" } })],
  });
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().selected, "home", "the client does not take the selection back");
  assert.equal(ctrl.getSnapshot().createdNotice?.spaceId, "made");
});

test("a historical terminal create is recorded without a banner; this page's active job can finish into one", async () => {
  const historical = job({ id: "old", kind: "space.create", status: "succeeded", canCancel: false, result: { spaceId: "later" } });
  const live = job({ id: "live", kind: "space.create", status: "running", canCancel: true, result: { spaceId: "watched" } });
  let current = state({ jobs: [historical, live], spaces: [manager, space({ id: "later", status: "stopped" }), space({ id: "watched", status: "stopped" })] });
  const ctrl = controller(fakeApi({ state: async () => current }));
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().selected, "home");
  assert.equal(ctrl.getSnapshot().createdNotice, null);
  current = state({
    jobs: [historical, job({ ...live, status: "succeeded", canCancel: false })],
    spaces: [manager, space({ id: "later", status: "stopped" }), space({ id: "watched", status: "stopped" })],
  });
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().selected, "home");
  assert.equal(ctrl.getSnapshot().createdNotice?.spaceId, "watched");
});

test("a submitted active create is watched even when the first following poll is already terminal", async () => {
  let current = state();
  const api = fakeApi({
    state: async () => current,
    submit: async (_command, requestId) => {
      const active = job({ id: "fast-create", requestId, kind: "space.create", status: "running" });
      current = state({ jobs: [job({ ...active, status: "succeeded", result: { spaceId: "fast" } })], spaces: [manager, space({ id: "fast" })] });
      return active;
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.createSpace({ name: "fast" });
  await flush();
  assert.equal(ctrl.getSnapshot().createdNotice?.spaceId, "fast");
  assert.equal(ctrl.getSnapshot().selected, "home");
});

test("a new service epoch treats already finished creates as history", async () => {
  const finished = job({ id: "old", kind: "space.create", status: "succeeded", canCancel: false, result: { spaceId: "later" } });
  let current = state({ jobs: [], spaces: [manager] });
  const ctrl = controller(fakeApi({ state: async () => current }));
  await ctrl.poll();
  ctrl.createSpace({ name: "ok-space", displayName: "Ok" });
  await flush();
  assert.equal(ctrl.getSnapshot().createdNotice?.spaceId, "created");
  current = state({ serviceEpoch: "b".repeat(64), jobs: [finished], spaces: [manager, space({ id: "later", status: "stopped" })] });
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().createdNotice, null);
  assert.equal(ctrl.getSnapshot().selected, "home");
});

test("deleted spaces do not regain an enter notice from historical creation jobs", async () => {
  const completed = job({ kind: "space.create", status: "succeeded", result: { spaceId: "gone" } });
  let current = state({ jobs: [completed] });
  const ctrl = controller(fakeApi({ state: async () => current }));
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().createdNotice, null);
  current = state({ jobs: [completed], spaces: [manager, space({ id: "gone" })] });
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().createdNotice, null);
});

test("openIndependent re-requests view and does not reuse a consumed src", async () => {
  const opened: string[] = [];
  let views = 0;
  const api = fakeApi({
    view: async (spaceId) => {
      views += 1;
      return { ...viewOf(spaceId), entryPath: `/view/${spaceId}/n${views}` };
    },
  });
  const ctrl = controller(api, { openUrl: (url) => opened.push(url) });
  await ctrl.poll();
  ctrl.selectSpace("alpha");
  await flush();
  const firstSrc = ctrl.getSnapshot().frames.find((frame) => frame.spaceId === "alpha")?.src;
  ctrl.openIndependent("alpha");
  await flush();
  assert.equal(views, 2);
  assert.equal(opened.length, 1);
  assert.notEqual(opened[0], firstSrc);
  assert.ok(opened[0]?.startsWith(`${SUPERVISOR_ORIGIN}/view/alpha/`));
  assert.ok(opened[0]?.includes(`?epoch=${EPOCH}`));
  assert.ok(!opened[0]?.includes("&"));
});

test("going home keeps visited iframes mounted in markup", async () => {
  const ctrl = controller(
    fakeApi({
      state: async () => state({ spaces: [manager, space({ id: "alpha" }), space({ id: "beta" })] }),
    }),
  );
  await ctrl.poll();
  await becomeReady(ctrl, "alpha");
  const before = ready(ctrl);
  assert.ok(before.includes('data-space-id="alpha"'));
  ctrl.selectHome();
  const after = ready(ctrl);
  assert.equal(ctrl.getSnapshot().selected, "home");
  assert.ok(after.includes('data-space-id="alpha"'));
  assert.ok(after.includes("dsh-wb-frames"));
  assert.ok(after.includes('data-visible="false"') || after.includes("hidden"));
});

test("handshake timeout fails pending without stealing the committed view", async () => {
  const timers: Array<() => void> = [];
  const api = fakeApi({
    state: async () => state({ spaces: [manager, space({ id: "alpha" }), space({ id: "beta" })] }),
    view: async (spaceId) => viewOf(spaceId),
  });
  const ctrl = controller(api, {
    handshakeTimeoutMs: 5,
    setTimeout: (handler) => {
      timers.push(handler);
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  await ctrl.poll();
  await becomeReady(ctrl, "alpha", { id: "a" });
  ctrl.selectSpace("beta");
  await flush();
  const winB = { id: "b" };
  ctrl.registerIframeWindow("beta", 1, winB);
  for (const fire of [...timers]) fire();
  assert.equal(ctrl.getSnapshot().selected, "alpha");
  assert.equal(ctrl.getSnapshot().visibleSpaceId, "alpha");
  ctrl.handleMessage({
    origin: CHILD_ORIGIN,
    source: winB,
    data: readyMessage("beta"),
  });
  assert.equal(ctrl.getSnapshot().selected, "alpha");
  assert.equal(ctrl.getSnapshot().visibleSpaceId, "alpha");
});


test("failed interrupted jobs render the persisted unconfirmed not-replayed message", () => {
  const html = renderToStaticMarkup(
    React.createElement(JobsList, {
      locale: "en",
      jobs: [
        job({
          status: "failed",
          canCancel: false,
          phase: "install",
          message: INTERRUPTED_JOB_MESSAGE,
          error: {
            code: "workbench/failed",
            message: INTERRUPTED_JOB_MESSAGE,
          },
        }),
      ],
      onCancel() {},
    }),
  );
  assert.match(html, /unconfirmed/i);
  assert.match(html, /not replayed/i);
  assert.match(html, /install/);
});

test("templates tab lists templates and export without storing archives", async () => {
  const downloads: Array<{ fileName: string; archiveBase64: string }> = [];
  const api = fakeApi();
  const ctrl = controller(api, {
    downloadFile: (fileName, archiveBase64) => downloads.push({ fileName, archiveBase64 }),
  });
  await ctrl.poll();
  ctrl.setHomeTab("templates");
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes('data-templates="true"'), "the templates tab renders the space template page");
  assert.ok(html.includes("Development"));
  assert.ok(html.includes('data-template-use="dev"'));
  assert.ok(html.includes('data-template-delete="dev"'));

  // Deleting a template dispatches template.delete.
  ctrl.deleteTemplate("dev");
  await flush();
  assert.ok(
    api.calls.some(
      (item) =>
        item.method === "submit" &&
        (item.arg as { command?: { kind?: string; templateId?: string } }).command?.kind === "template.delete" &&
        (item.arg as { command?: { templateId?: string } }).command?.templateId === "dev",
    ),
  );

  // Share export now opens from the space context menu as ExportShareDialog.
  ctrl.openExportShare("alpha");
  await flush();
  const exportHtml = ready(ctrl);
  assert.ok(exportHtml.includes('data-export-share-dialog="true"'));
  assert.ok(exportHtml.includes(t("zh", "share.includeConfig")));
  assert.ok(exportHtml.includes(t("zh", "share.export")));
  ctrl.exportShare();
  await flush();
  assert.deepEqual(downloads, [{ fileName: "alpha.dshspace", archiveBase64: "YQ==" }]);
  const raw = api.calls.some((item) => JSON.stringify(item).includes("YQ==") && item.method === "submit");
  assert.equal(raw, false);
});

test("dirty settings draft keeps its observation and does not take a later state revision", async () => {
  let current = state();
  const api = fakeApi({
    state: async () => current,
    submit: async (command, requestId, context) => {
      api.calls.push({ method: "submit", arg: { command, requestId, context } });
      throw Object.assign(new Error("revision conflict"), { code: "workbench/conflict" });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  await flush();
  assert.equal(ctrl.getSnapshot().settingsDraft?.observation.expectedRevision, REVISION);
  ctrl.setHomeSettings({ portStart: 4100 });
  assert.equal(ctrl.getSnapshot().settingsDraft?.dirty, true);
  current = state({ revision: REVISION_NEXT });
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().settingsDraft?.settings.portStart, 4100);
  assert.equal(ctrl.getSnapshot().settingsDraft?.observation.expectedRevision, REVISION);
  ctrl.saveHomeSettings();
  await flush();
  const submitted = api.calls.filter((item) => item.method === "submit").at(-1);
  const arg = submitted?.arg as { context: WorkbenchMutationContext; command: WorkbenchCommand };
  assert.equal(arg.context.expectedRevision, REVISION);
  assert.equal(arg.context.serviceEpoch, EPOCH);
  assert.equal(ctrl.getSnapshot().settingsDraft?.settings.portStart, 4100);
  assert.equal(ctrl.getSnapshot().settingsDraft?.dirty, true);
  assert.equal(
    ctrl.getSnapshot().commandError,
    `${t("zh", "app.conflict")}\n${t("zh", "app.errorReason", { reason: "revision conflict" })}`,
  );
});

test("old-service view frames are rejected without serviceEpoch", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  await becomeReady(ctrl, "alpha", { id: "a" });
  const win = { id: "a" };
  ctrl.handleMessage({
    origin: CHILD_ORIGIN,
    source: win,
    data: {
      source: "dsh-spaces-view",
      spaceId: "alpha",
      generation: 1,
      channel: "ch-alpha-1",
      state: "failed",
      message: "stale",
    },
  });
  assert.equal(ctrl.getSnapshot().visibleSpaceId, "alpha");
  assert.equal(ctrl.getSnapshot().frames.find((frame) => frame.spaceId === "alpha")?.status, "ready");
});

test("import preview then confirm submits once and does not resend after epoch change", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.previewImportArchive("YQ==", "alpha.dshspace");
  await flush();
  assert.equal(ctrl.getSnapshot().overlay?.type, "import");
  assert.equal(ctrl.getSnapshot().importPreview?.importId, "imp-1");
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "share.confirmImport")));
  ctrl.setImportName("notes");
  ctrl.confirmImport();
  await flush();
  const imports = api.calls
    .filter((item) => item.method === "submit")
    .map((item) => (item.arg as { command: WorkbenchCommand }).command)
    .filter((command) => command.kind === "space.import");
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0], { kind: "space.import", importId: "imp-1", name: "notes", displayName: undefined });
  ctrl.confirmImport();
  await flush();
  assert.equal(
    api.calls.filter((item) => item.method === "submit" && (item.arg as { command: WorkbenchCommand }).command.kind === "space.import").length,
    1,
  );

  const stale = fakeApi({
    state: async () => state({ serviceEpoch: "dd".repeat(32) }),
  });
  const staleCtrl = controller(stale);
  await staleCtrl.poll();
  staleCtrl.previewImportArchive("YQ==", "alpha.dshspace");
  await flush();
  staleCtrl.setImportName("notes");
  staleCtrl.confirmImport();
  await flush();
  assert.equal(stale.calls.filter((item) => item.method === "submit").length, 0);
  assert.equal(staleCtrl.getSnapshot().commandError, t("zh", "share.epochChanged"));
});

test("failed import jobs keep partial product results", () => {
  const html = renderToStaticMarkup(
    React.createElement(JobsList, {
      locale: "zh",
      jobs: [
        job({
          kind: "space.import",
          status: "failed",
          canCancel: false,
          result: {
            spaceId: "notes",
            product: {
              kind: "space.import",
              import: {
                definition: "imported",
                plugins: "failed",
                start: "not-run",
                spaceId: "notes",
                errors: ["plugin demo failed"],
                pendingManual: [],
              },
            },
          },
        }),
      ],
      onCancel() {},
    }),
  );
  assert.ok(html.includes(t("zh", "templates.result.definition")));
  assert.ok(html.includes("imported"));
  assert.ok(html.includes("failed"));
  assert.ok(html.includes("not-run"));
  assert.ok(html.includes("plugin demo failed"));
});

test("saving Home settings does not reset client locale or theme", async () => {
  const storage = memoryStorage();
  const api = fakeApi();
  const ctrl = controller(api, { storage });
  await ctrl.poll();
  ctrl.setLocale("en");
  ctrl.setTheme("light");
  ctrl.openSettings();
  await flush();
  assert.equal(ctrl.getSnapshot().locale, "en");
  assert.equal(ctrl.getSnapshot().theme, "light");
  ctrl.setHomeSettings({ portStart: 4100 });
  ctrl.saveHomeSettings();
  await flush();
  assert.equal(ctrl.getSnapshot().locale, "en");
  assert.equal(ctrl.getSnapshot().theme, "light");
  assert.equal(readPersist(storage).locale, "en");
  assert.equal(readPersist(storage).theme, "light");
  const command = (api.calls.find((item) => item.method === "submit")?.arg as { command: WorkbenchCommand }).command;
  assert.equal(command.kind, "settings.update");
  if (command.kind === "settings.update") {
    assert.equal("locale" in command.settings, false);
    assert.equal("theme" in command.settings, false);
    assert.equal(command.settings.portStart, 4100);
  }
});

test("service shutdown is a preview, not acquire", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.setSettingsTab("advanced");
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "settings.service.stop")));
  assert.ok(html.includes(t("zh", "settings.service.danger")));
  assert.ok(!html.includes("controller.acquire"));
  assert.ok(!html.includes("controller.release"));
  ctrl.preview({ kind: "service.shutdown" });
  await flush();
  assert.deepEqual(api.calls.find((item) => item.method === "preview")?.arg, { kind: "service.shutdown" });
  assert.equal((api.calls.find((item) => item.method === "preview")?.context as WorkbenchMutationContext).serviceEpoch, EPOCH);
  ctrl.confirmPlan();
  await flush();
  const executed = api.calls.find((item) => item.method === "submit");
  assert.deepEqual((executed?.arg as { command: WorkbenchCommand }).command, {
    kind: "plan.execute",
    planId: "plan-1",
  });
});

test("shutdown transport loss retains an unconfirmed result and never polls or resubmits through the stopped manager", async () => {
  let submissions = 0;
  const api = fakeApi({ submit: async () => { submissions++; throw new Error("transport closed"); } });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.preview({ kind: "service.shutdown" });
  await flush();
  const reads = api.calls.filter(item => item.method === "state").length;
  ctrl.confirmPlan();
  await flush();
  await ctrl.poll();
  assert.match(ctrl.getSnapshot().commandError ?? "", /尚未确认/);
  assert.equal(ctrl.canMutate(), false);
  assert.equal(api.calls.filter(item => item.method === "state").length, reads);
  assert.equal(submissions, 1);
});

test("applyView rejects missing or non-hex serviceEpoch before minting src", () => {
  const session = new ViewSession();
  const first = session.requestSpace(space({ id: "alpha" }));
  session.applyView("alpha", first.token, { ...viewOf("alpha"), serviceEpoch: "nope" });
  assert.equal(session.get("alpha")?.status, "failed");
  assert.equal(session.get("alpha")?.error, "unauthorized-view");
  assert.equal(session.get("alpha")?.src, null);
  session.destroy("alpha");
  const second = session.requestSpace(space({ id: "alpha" }));
  session.applyView("alpha", second.token, { ...viewOf("alpha"), serviceEpoch: "" });
  assert.equal(session.get("alpha")?.status, "failed");
  session.destroy("alpha");
  const third = session.requestSpace(space({ id: "alpha" }));
  session.applyView("alpha", third.token, viewOf("alpha"));
  assert.equal(session.get("alpha")?.src, viewSrc("alpha"));
});

test("repeat submit of the same pending intent reuses requestId and does not resubmit on poll", async () => {
  const pending = deferred<WorkbenchJob>();
  let submits = 0;
  const api = fakeApi({
    submit: async (command, requestId, context) => {
      submits += 1;
      api.calls.push({ method: "submit", arg: { command, requestId, context } });
      if (submits === 1) return pending.promise;
      return job({ id: `job-${requestId}`, requestId, kind: command.kind, status: "succeeded", canCancel: false });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.createSpace({ name: "ok-space" });
  ctrl.createSpace({ name: "ok-space" });
  await flush();
  assert.equal(submits, 1);
  pending.resolve(job({ id: "job-uuid-1", requestId: "uuid-1", kind: "space.create", status: "running", canCancel: true }));
  await flush();
  const before = submits;
  await ctrl.poll();
  assert.equal(submits, before);
});

test("settings.update success then later dirty edit is not overwritten by polling the same terminal job", async () => {
  const saved = { portStart: 3100, portEnd: 3199, packageSource: "official" as PackageSource, catalogUrl: "" };
  let settingsReads = 0;
  let jobs: WorkbenchJob[] = [];
  const api = fakeApi({
    product: async (request) => {
      if (request.method === "settings") {
        settingsReads += 1;
        return {
          method: "settings",
          settings: { ...saved },
          clientDefaults: { locale: "zh", theme: "dark" },
          observation: OBSERVATION,
        };
      }
      return productResult(request);
    },
    submit: async (command, requestId, context) => {
      api.calls.push({ method: "submit", arg: { command, requestId, context } });
      if (command.kind === "settings.update") {
        saved.portStart = command.settings.portStart;
        saved.portEnd = command.settings.portEnd;
        saved.packageSource = command.settings.packageSource;
        saved.catalogUrl = command.settings.catalogUrl;
        const next = job({
          id: "job-settings-1",
          requestId,
          kind: "settings.update",
          status: "succeeded",
          canCancel: false,
          result: { product: { kind: "settings.update", settings: { ...command.settings } } },
        });
        jobs = [next];
        return next;
      }
      return job({ id: `job-${requestId}`, requestId, kind: command.kind, status: "succeeded", canCancel: false });
    },
    state: async () => state({ jobs }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  await flush();
  const readsAfterOpen = settingsReads;
  ctrl.setHomeSettings({ portStart: 4100 });
  ctrl.saveHomeSettings();
  await flush();
  assert.equal(ctrl.getSnapshot().settingsDraft?.settings.portStart, 4100);
  assert.equal(ctrl.getSnapshot().settingsDraft?.dirty, false);
  ctrl.setHomeSettings({ portStart: 4200 });
  assert.equal(ctrl.getSnapshot().settingsDraft?.dirty, true);
  assert.equal(ctrl.getSnapshot().settingsDraft?.settings.portStart, 4200);
  const readsBeforePoll = settingsReads;
  await ctrl.poll();
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().settingsDraft?.settings.portStart, 4200);
  assert.equal(ctrl.getSnapshot().settingsDraft?.dirty, true);
  assert.equal(settingsReads, readsBeforePoll);
  assert.ok(settingsReads >= readsAfterOpen);
});

test("edits made while settings.update is pending are kept when the old save succeeds", async () => {
  const pending = deferred<WorkbenchJob>();
  const api = fakeApi({
    submit: async (command, requestId, context) => {
      api.calls.push({ method: "submit", arg: { command, requestId, context } });
      if (command.kind === "settings.update") return pending.promise;
      return job({ id: `job-${requestId}`, requestId, kind: command.kind, status: "succeeded", canCancel: false });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  await flush();
  ctrl.setHomeSettings({ portStart: 4100 });
  ctrl.saveHomeSettings();
  ctrl.setHomeSettings({ portStart: 4300 });
  pending.resolve(
    job({
      id: "job-settings-pending",
      requestId: "uuid-1",
      kind: "settings.update",
      status: "succeeded",
      canCancel: false,
      result: {
        product: {
          kind: "settings.update",
          settings: { portStart: 4100, portEnd: 3199, packageSource: "official", catalogUrl: "" },
        },
      },
    }),
  );
  await flush();
  assert.equal(ctrl.getSnapshot().settingsDraft?.settings.portStart, 4300);
  assert.equal(ctrl.getSnapshot().settingsDraft?.dirty, true);
});

test("stop() drops in-flight state and product responses", async () => {
  const stateGate = deferred<WorkbenchState>();
  const settingsGate = deferred<WorkbenchProductResult>();
  const api = fakeApi({
    state: async () => stateGate.promise,
    product: async (request) => {
      if (request.method === "settings") return settingsGate.promise;
      return productResult(request);
    },
  });
  const ctrl = controller(api);
  const pollDone = ctrl.poll();
  ctrl.openSettings();
  ctrl.stop();
  stateGate.resolve(state({ reasons: ["late-state"] }));
  settingsGate.resolve({
    method: "settings",
    settings: { portStart: 4100, portEnd: 3199, packageSource: "official", catalogUrl: "" },
    clientDefaults: { locale: "zh", theme: "dark" },
    observation: OBSERVATION,
  });
  await pollDone;
  await flush();
  assert.equal(ctrl.getSnapshot().state, null);
  assert.equal(ctrl.getSnapshot().boot, "loading");
  assert.equal(ctrl.getSnapshot().settingsDraft, null);
});

test("a failed create keeps the dialog open and shows the reason inside it", async () => {
  const api = fakeApi({
    submit: async () => {
      throw Object.assign(new Error("denied"), { code: "workbench/read-only" });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openCreate();
  ctrl.createSpace({ name: "ok-space" });
  await flush();
  const ui = ctrl.getSnapshot();
  assert.equal(ui.overlay?.type, "create", "the create dialog stays open after a failed submit");
  assert.equal(ui.requestOrigin, "create");
  const html = ready(ctrl);
  assert.ok(html.includes('data-create-error="true"'), "the reason is shown inside the dialog");
  const reason = t("zh", "app.readOnlyError");
  assert.ok(html.includes(reason));
  assert.equal(html.split(reason).length - 1, 1, "the banner at the top does not repeat the reason");
});

test("a failed create job keeps the dialog open with the reason of the job", async () => {
  const api = fakeApi({
    submit: async (command, requestId) =>
      job({
        id: `job-${requestId}`,
        requestId,
        kind: command.kind,
        status: "failed",
        phase: "done",
        message: "the space could not be created",
        canCancel: false,
        error: { code: "workbench/conflict", message: "name in use" },
      }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openCreate();
  ctrl.createSpace({ name: "ok-space" });
  await flush();
  const ui = ctrl.getSnapshot();
  assert.equal(ui.overlay?.type, "create", "a failed job keeps the dialog open");
  const html = ready(ctrl);
  assert.ok(html.includes('data-create-error="true"'));
  assert.ok(html.includes(t("zh", "app.conflict")));
});

test("a failed plugin preview stays in the plugin section of the space detail", async () => {
  const api = fakeApi({
    preview: async () => {
      throw Object.assign(new Error("nope"), { code: "workbench/invalid-input" });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.openDetail("alpha");
  await flush();
  ctrl.setPluginCatalog("demo", "1.0.0");
  await flush();
  ctrl.previewInstallSelected("alpha");
  await flush();
  const ui = ctrl.getSnapshot();
  assert.equal(ui.requestOrigin, "detail:alpha:plugins", "the plugin section owns the failure");
  const html = ready(ctrl);
  assert.ok(html.includes('data-inline-error="detail:alpha:plugins"'), "the reason is shown in the plugin section");
  assert.ok(html.includes(t("zh", "app.invalidInput")));
  assert.equal(html.split(t("zh", "app.invalidInput")).length - 1, 1, "the banner does not repeat the reason");
});

test("a failed rename keeps the rename dialog open with the reason inside it", async () => {
  const api = fakeApi({
    submit: async () => {
      throw Object.assign(new Error("denied"), { code: "workbench/conflict" });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openRename("alpha");
  ctrl.updateSpace("alpha", { displayName: "New name" });
  await flush();
  const ui = ctrl.getSnapshot();
  assert.equal(ui.overlay?.type, "rename", "the rename dialog stays open after a failed submit");
  const html = ready(ctrl);
  assert.ok(html.includes('data-rename-error="true"'), "the reason is shown inside the dialog");
  assert.equal(html.split(t("zh", "app.conflict")).length - 1, 1, "shown exactly once");
});

test("a failure whose owning surface is no longer on screen falls back to the banner", async () => {
  let reject!: (error: Error) => void;
  const api = fakeApi({
    preview: () => new Promise((_resolve, fail) => { reject = fail; }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.openDetail("alpha");
  await flush();
  ctrl.preview({ kind: "space.delete", spaceId: "alpha", removeData: false });
  await flush();
  assert.equal(ctrl.getSnapshot().requestOrigin, "detail:alpha");
  // The user moves to another tab while the preview is still in flight.
  ctrl.setSettingsTab("general");
  reject(Object.assign(new Error("nope"), { code: "workbench/invalid-input" }));
  await flush();
  const html = ready(ctrl);
  const reason = t("zh", "app.invalidInput");
  assert.ok(html.includes(reason), "the reason is never dropped");
  assert.equal(html.split(reason).length - 1, 1, "shown exactly once, in the banner");
  assert.ok(!html.includes('data-inline-error="detail:alpha"'), "the detail surface is not on screen");
});

test("a failure from a surface without an inline host stays visible in the banner", async () => {
  const api = fakeApi({
    preview: async () => {
      throw Object.assign(new Error("nope"), { code: "workbench/invalid-input" });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.setSettingsTab("snapshots");
  await flush();
  ctrl.preview({ kind: "snapshot.create" });
  await flush();
  assert.equal(ctrl.getSnapshot().requestOrigin, "backups");
  const html = ready(ctrl);
  assert.equal(html.split(t("zh", "app.invalidInput")).length - 1, 1, "the backups failure is shown in the banner");
});

test("a failed preview keeps the settings surface open so the reason stays in place", async () => {
  const api = fakeApi({
    preview: async () => {
      throw Object.assign(new Error("nope"), { code: "workbench/invalid-input" });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.setSettingsTab("spaces");
  await flush();
  ctrl.preview({ kind: "space.delete", spaceId: "alpha", removeData: false });
  await flush();
  const ui = ctrl.getSnapshot();
  assert.equal(ui.pendingPlan, null, "the failed preview asks for nothing");
  assert.equal(ui.overlay?.type, "settings", "the settings surface stays open after a failed preview");
  assert.equal(ui.requestOrigin, "spaces");
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "app.invalidInput")));
});

test("an empty list offers the next step", async () => {
  const api = fakeApi({
    state: async () => state({ spaces: [manager] }),
    snapshots: async () => [],
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.setSettingsTab("spaces");
  await flush();
  const spaces = ready(ctrl);
  assert.ok(spaces.includes('data-empty="spaces"'), "the space list says what is missing");
  assert.ok(spaces.includes(t("zh", "app.newSpace")), "and offers the next step");

  ctrl.setSettingsTab("snapshots");
  await flush();
  const backups = ready(ctrl);
  assert.ok(backups.includes('data-empty="backups"'));
  assert.ok(backups.includes(t("zh", "snapshots.create")));
});

test("a space without plugins points at the plugin search", async () => {
  const api = fakeApi({ plugins: async () => [] });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.openDetail("alpha");
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes('data-empty="plugins"'), "the plugin list says what is missing");
  assert.ok(html.includes('data-space-plugin-search-focus="true"'), "and points at the search field");
  assert.ok(html.includes(t("zh", "plugins.search")));
});

test("the space detail does not show the internal generation and managed rows", async () => {
  const ctrl = controller();
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.openDetail("alpha");
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes('data-space-detail="true"'));
  assert.equal(html.includes(t("zh", "detail.id")), true);
  assert.equal(html.includes(t("zh", "app.status.running")), true);
});

test("the general model card reports configured, incomplete and unconfigured settings", async () => {
  const cases: Array<[SpaceModelConfig, SpaceModelConfig["status"], string]> = [
    [{ status: "configured", routeNames: ["gw"], defaultModel: "gw/gw-large", missingCredentials: [] }, "configured", t("zh", "detail.models.configured", { model: "gw/gw-large", routes: "1" })],
    [{ status: "incomplete", routeNames: ["gw"], defaultModel: null, missingCredentials: ["GW_KEY"] }, "incomplete", t("zh", "detail.models.incomplete")],
    [{ status: "unconfigured", routeNames: [], defaultModel: null, missingCredentials: [] }, "unconfigured", t("zh", "detail.models.unconfigured")],
  ];
  for (const [models, state, message] of cases) {
    const api = fakeApi({
      detail: async (spaceId) => ({
        space: { id: spaceId, displayName: spaceId, isHost: false, hasWebApp: true, status: "running" },
        models, plugins: [], snapshots: [], diagnostics: [],
      }),
    });
    const ctrl = controller(api);
    await ctrl.poll();
    ctrl.openSettings();
    ctrl.openDetail("alpha");
    await flush();
    const html = ready(ctrl);
    assert.ok(html.includes(`data-space-models-state="${state}"`));
    assert.ok(html.includes(message));
    const button = html.match(/<button[^>]*data-space-models-sync="true"[^>]*>/)?.[0] ?? "";
    assert.equal(button.includes("disabled"), false, "running spaces can preview sync");
  }
});

test("a completed model sync refreshes the open space model card", async () => {
  let configured = false;
  let reads = 0;
  const api = fakeApi({
    detail: async (spaceId) => {
      reads++;
      return {
        space: { id: spaceId, displayName: spaceId, isHost: false, hasWebApp: true, status: "running" },
        models: { status: configured ? "configured" : "unconfigured", routeNames: configured ? ["gw"] : [], defaultModel: configured ? "gw/gw-large" : null, missingCredentials: [] },
        plugins: [], snapshots: [], diagnostics: [],
      };
    },
    submit: async (command, requestId) => {
      configured = true;
      return job({ id: `job-${requestId}`, requestId, kind: command.kind, status: "succeeded", result: { spaceId: "alpha" } });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.openDetail("alpha");
  await flush();
  assert.equal(ctrl.getSnapshot().detail?.models.status, "unconfigured");
  ctrl.preview({ kind: "space.models.sync", spaceId: "alpha" });
  await flush();
  ctrl.confirmPlan();
  await flush();
  await flush();
  assert.equal(ctrl.getSnapshot().detail?.models.status, "configured");
  assert.equal(reads, 2);
});

test("the delete plan dialog is worded in the locale with the display name and a danger confirm", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.preview({ kind: "space.delete", spaceId: "alpha", removeData: false });
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes('id="dsh-wb-plan-title"'));
  const heading = html.match(/<h2[^>]*id="dsh-wb-plan-title"[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "";
  assert.equal(heading, t("zh", "plan.title.spaceDelete", { name: "Alpha (alpha)" }));
  assert.ok(!heading.includes("space.delete"), "the raw request kind is never the title");
  assert.ok(html.includes(t("zh", "plan.body.spaceDelete")));
  assert.ok(html.includes(t("zh", "plan.details")), "the server wording moves into collapsed details");
  const confirm = html.match(/<button[^>]*data-plan-id="plan-1"[^>]*>([\s\S]*?)<\/button>/)?.[0] ?? "";
  assert.ok(confirm.includes('class="dsh-wb-btn danger"'), "a delete confirmation is destructive");
  assert.ok(confirm.includes(t("zh", "plan.confirm.deleteSpace")));
  assert.equal(ctrl.getSnapshot().pendingPlan?.plan.destructive, true);
});

test("an install plan dialog lists the target spaces by display name", async () => {
  const api = fakeApi();
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.preview({ kind: "plugin.install", spaceIds: ["alpha", "beta"], catalogId: "demo", version: "2.0.0" });
  await flush();
  const html = ready(ctrl);
  const heading = html.match(/<h2[^>]*id="dsh-wb-plan-title"[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "";
  assert.equal(heading, t("zh", "plan.title.pluginInstall", { pkg: "demo", version: "2.0.0" }));
  assert.ok(html.includes(t("zh", "plan.body.pluginInstall", { spaces: "Alpha (alpha), Beta (beta)" })));
  const confirm = html.match(/<button[^>]*data-plan-id="plan-1"[^>]*>([\s\S]*?)<\/button>/)?.[0] ?? "";
  assert.ok(confirm.includes('class="dsh-wb-btn primary"'), "an install confirmation is not destructive");
  assert.ok(confirm.includes(t("zh", "plan.confirm.install")));
});

test("stop-and-modify dialogs show interruption and use an explicit confirm action", async () => {
  const operations: Array<{ request: WorkbenchPlanRequest; confirm: Parameters<typeof t>[1] }> = [
    { request: { kind: "plugin.cleanup-manager", spaceId: "alpha" }, confirm: "plan.confirm.stopAndCleanup" },
    { request: { kind: "space.runtime.set", spaceId: "alpha", version: "0.2.2-rc.1" }, confirm: "plan.confirm.stopAndRuntime" },
  ];
  for (const operation of operations) {
    const api = fakeApi({
      preview: async (request) => planOf(request, {
        runningSpaceIds: ["alpha"],
        ...(request.kind === "space.models.sync" ? { modelsSync: {
          mainProfile: "web", routes: ["gw"], deepseek: false, defaultModel: "gw/gw-large",
          credentials: ["GW_KEY"], skipped: [{ route: "codex", reason: "login-grant" }], missingCredentials: ["MISSING_KEY"],
        } } : {}),
      }),
    });
    const ctrl = controller(api);
    await ctrl.poll();
    ctrl.preview(operation.request);
    await flush();
    const html = ready(ctrl);
    assert.ok(html.includes('data-plan-stop-impact="true"'));
    assert.ok(html.includes(t("zh", "plan.stopAndRestore", { spaces: "Alpha (alpha)" })));
    assert.ok(html.includes(t("zh", operation.confirm)));
    assert.ok(html.indexOf('data-plan-stop-impact="true"') < html.indexOf(t("zh", "plan.details")), "the impact is above collapsed details");
    if (operation.request.kind === "space.models.sync") {
      assert.ok(html.includes('data-plan-models-summary="true"'));
      assert.ok(html.includes("gw/gw-large"));
      assert.ok(html.includes("GW_KEY"));
      assert.ok(html.includes("MISSING_KEY"));
      assert.ok(html.includes(t("zh", "plan.models.skip.login-grant")));
    }
  }
});

test("running plugin dialogs keep the space running and defer restart choice to the user", async () => {
  const operations: Array<{ request: WorkbenchPlanRequest; confirm: Parameters<typeof t>[1] }> = [
    { request: { kind: "plugin.install", spaceIds: ["alpha"], catalogId: "demo", version: "2.0.0" }, confirm: "plan.confirm.install" },
    { request: { kind: "plugin.remove", spaceId: "alpha", packageName: "demo" }, confirm: "plan.confirm.removePlugin" },
    { request: { kind: "plugin.toggle", spaceId: "alpha", pluginId: "demo", enabled: false }, confirm: "plan.confirm.remove" },
    { request: { kind: "plugin.toggle", spaceId: "alpha", pluginId: "demo", enabled: true }, confirm: "plan.confirm.enable" },
  ];
  for (const operation of operations) {
    const api = fakeApi({
      preview: async (request) => planOf(request, { runningSpaceIds: ["alpha"] }),
    });
    const ctrl = controller(api);
    await ctrl.poll();
    ctrl.preview(operation.request);
    await flush();
    const html = ready(ctrl);
    assert.ok(html.includes('data-plan-plugins-live="true"'));
    assert.ok(html.includes(t("zh", "plan.plugins.liveBody")));
    assert.ok(!html.includes('data-plan-stop-impact="true"'));
    const confirm = html.match(/<button[^>]*data-plan-id="plan-1"[^>]*>([\s\S]*?)<\/button>/)?.[0] ?? "";
    assert.ok(confirm.includes(t("zh", operation.confirm)));
  }
});

test("a running model sync confirmation keeps the space running", async () => {
  const api = fakeApi({
    preview: async (request) => planOf(request, {
      runningSpaceIds: ["alpha"],
      modelsSync: {
        mainProfile: "web", routes: ["gw"], deepseek: false, defaultModel: "gw/gw-large",
        credentials: ["GW_KEY"], skipped: [{ route: "codex", reason: "login-grant" }], missingCredentials: ["MISSING_KEY"],
      },
    }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.preview({ kind: "space.models.sync", spaceId: "alpha" });
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes('data-plan-models-live="true"'));
  assert.ok(html.includes(t("zh", "plan.models.liveBody")));
  assert.equal(html.includes('data-plan-stop-impact="true"'), false);
  assert.ok(html.includes('data-plan-models-summary="true"'));
  assert.ok(html.includes("gw/gw-large"));
  assert.ok(html.includes("GW_KEY"));
  assert.ok(html.includes("MISSING_KEY"));
  assert.ok(html.includes(t("zh", "plan.models.skip.login-grant")));
  const button = html.match(/<button[^>]*data-plan-id="plan-1"[^>]*>([\s\S]*?)<\/button>/)?.[0] ?? "";
  assert.ok(button.includes(t("zh", "plan.confirm.syncModels")));
  assert.equal(button.includes("停止并同步"), false);
});

test("model sync waits for starting and stopping spaces", async () => {
  for (const status of ["starting", "stopping"] as const) {
    const ctrl = controller(fakeApi({
      state: async () => state({ spaces: [manager, space({ id: "alpha", status })] }),
    }));
    await ctrl.poll();
    ctrl.openSettings();
    ctrl.openDetail("alpha");
    await flush();
    const html = ready(ctrl);
    const button = html.match(/<button[^>]*data-space-models-sync="true"[^>]*>/)?.[0] ?? "";
    assert.ok(button.includes("disabled"));
    assert.ok(html.includes(t("zh", "detail.models.transitionHint")));
  }
});

test("a crashed space card offers start and error details without a copy button", async () => {
  const ctrl = controller(fakeApi({
    state: async () => state({ spaces: [manager, space({ id: "alpha", status: "crashed" })] }),
  }));
  await ctrl.poll();
  const ui = { ...ctrl.getSnapshot(), selected: "alpha" };
  const html = renderToStaticMarkup(React.createElement(WorkbenchView, { ui, controller: ctrl }));
  assert.ok(html.includes(t("zh", "app.crashedTitle", { name: "alpha" })));
  assert.ok(html.includes(t("zh", "app.crashedBody")));
  assert.ok(html.includes(`>${t("zh", "app.start")}<`), "start stays available");
  assert.ok(html.includes(`>${t("zh", "app.errorDetails")}<`));
  assert.ok(!html.includes(t("zh", "app.copyLogs")));
  assert.ok(!html.includes(t("zh", "app.copyError")));
  assert.ok(!html.includes("alpha crashed"), "the misleading id+status copy is gone");
});

test("rail buttons name each space together with its status", async () => {
  const ctrl = controller(fakeApi({
    state: async () =>
      state({ spaces: [manager, space({ id: "alpha" }), space({ id: "gamma", displayName: "Gamma", status: "crashed" })] }),
  }));
  await ctrl.poll();
  const html = ready(ctrl);
  assert.ok(html.includes(`aria-label="alpha · ${t("zh", "app.status.running")}"`));
  assert.ok(html.includes(`aria-label="Gamma · ${t("zh", "app.status.crashed")}"`));
  assert.ok(html.includes(`title="Gamma · ${t("zh", "app.status.crashed")}"`));
  assert.ok(html.includes('class="dsh-wb-status" data-status="crashed" aria-hidden="true"'));
});

test("a space needing attention gets the rail halo and a labelled hint", async () => {
  const ctrl = controller(fakeApi({
    state: async () => state({ spaces: [
      manager,
      space({ id: "alpha", attention: "required" }),
      space({ id: "gamma", displayName: "Gamma", status: "stopped", attention: "none" }),
      space({ id: "delta", displayName: "Delta", status: "crashed" }),
    ] }),
  }));
  await ctrl.poll();
  const html = ready(ctrl);
  assert.ok(html.includes('data-attention="required"'), "the attention halo is rendered");
  assert.ok(html.includes(`aria-label="alpha · ${t("zh", "app.status.running")} · ${t("zh", "app.attention")}"`));
  const gamma = html.indexOf('data-space-id="gamma"') >= 0 ? html.slice(Math.max(0, html.indexOf('data-space-id="gamma"') - 400), html.indexOf('data-space-id="gamma"')) : html;
  assert.ok(!gamma.includes('data-attention="required"'), "a 'none' space has no halo");
  assert.ok(!html.includes(`Gamma · ${t("zh", "app.status.stopped")} · ${t("zh", "app.attention")}`));
  const crashed = html.indexOf('data-space-id="delta"') >= 0 ? html.slice(Math.max(0, html.indexOf('data-space-id="delta"') - 400), html.indexOf('data-space-id="delta"')) : html;
  assert.ok(!crashed.includes('data-attention="required"'), "a crashed space with no report has no halo");
});

test("known server preview-rejection reasons are localized", () => {
  const localized = localizeError("zh", { code: "workbench/conflict", message: "The preview expired. Request a new preview." });
  assert.ok(localized.includes(t("zh", "error.previewExpired")));
  assert.ok(!localized.includes("The preview expired"));
  const epoch = localizeError("zh", { code: "workbench/conflict", message: "The preview belongs to another service epoch." });
  assert.ok(epoch.includes(t("zh", "error.epochChanged")));
  const english = localizeError("en", { code: "workbench/conflict", message: "The target changed. Request a new preview." });
  assert.ok(english.includes(t("en", "error.targetChanged")));
});

test("active jobs are announced in the global status with kind, phase and message", async () => {
  const api = fakeApi({
    state: async () => state({
      jobs: [job({ kind: "space.create", status: "running", phase: "install", message: "DSH 0.2.1-rc.5" })],
    }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  const html = ready(ctrl);
  assert.ok(html.includes('data-active-job="job-1"'));
  assert.ok(html.includes("创建空间 · 安装中 — DSH 0.2.1-rc.5"));
  ctrl.setLocale("en");
  const en = ready(ctrl);
  assert.ok(en.includes("Create space · Installing — DSH 0.2.1-rc.5"));
});

test("finished jobs leave the global status quiet", async () => {
  const api = fakeApi({
    state: async () => state({ jobs: [job({ status: "failed", phase: "done", canCancel: false })] }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  assert.ok(!ready(ctrl).includes("data-active-job"));
});

test("the create dialog explains the disabled create button during another operation", async () => {
  const api = fakeApi({
    state: async () => state({
      jobs: [job({ kind: "space.create", status: "running", phase: "install", message: "DSH 0.2.1-rc.5" })],
    }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openCreate();
  const html = ready(ctrl);
  assert.ok(html.includes('data-create-busy="true"'));
  assert.ok(html.includes(t("zh", "create.busy")));
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled/);
});

test("the create dialog has no busy reason when nothing is running", async () => {
  const ctrl = controller();
  await ctrl.poll();
  ctrl.openCreate();
  assert.ok(!ready(ctrl).includes("data-create-busy"));
});

test("a space create job renders a rail placeholder while allowing starting other spaces to queue", async () => {
  const createdJob = job({ id: "create-1", kind: "space.create", status: "running", phase: "install", message: "DSH 0.9.9",
    affectedSpaceIds: ["made-space"], subject: { displayName: "Made Space", icon: "whale" } });
  let current = state({ writable: true, jobs: [createdJob] });
  const api = fakeApi({ state: async () => current });
  const ctrl = controller(api);
  await ctrl.poll();
  const markup = ready(ctrl);
  assert.match(markup, /data-creation-step="1"/);
  assert.match(markup, /data-creation-total="4"/);
  assert.match(markup, /Made Space · 正在创建/);
  // The same space id never shows as a normal space while its create is visible.
  assert.doesNotMatch(markup, /data-space-id="made-space"[^>]*aria-current/);
  // Selecting a running space still works.
  ctrl.selectSpace("alpha");
  await flush();
  // Starting an unrelated stopped space submits and queues cleanly without local refusal.
  const submits = () => api.calls.filter((item) => item.method === "submit").length;
  const before = submits();
  ctrl.selectSpace("beta");
  await flush();
  assert.equal(submits(), before + 1);
  assert.equal(ctrl.getSnapshot().commandError, null);
});

test("a failed create placeholder stays until dismissed and opens a failure dialog", async () => {
  const failedJob = job({ id: "create-dead", kind: "space.create", status: "failed", phase: "create",
    affectedSpaceIds: ["lost-space"], error: { code: "workbench/failed", message: "install broke" },
    subject: { displayName: "Lost Space" } });
  // Never seen active: not rendered.
  let hiddenCurrent = state({ writable: true, jobs: [failedJob] });
  const hidden = controller(fakeApi({ state: async () => hiddenCurrent }));
  await hidden.poll();
  assert.doesNotMatch(ready(hidden), /data-creation-step=/);
  // Seen active first: stays visible as failed and opens a reason dialog.
  const runningJob = job({ id: "create-dead", kind: "space.create", status: "running", phase: "create",
    affectedSpaceIds: ["lost-space"], subject: { displayName: "Lost Space" } });
  let current = state({ writable: true, jobs: [runningJob] });
  const ctrl = controller(fakeApi({ state: async () => current }));
  await ctrl.poll();
  current = state({ writable: true, jobs: [failedJob] });
  await ctrl.poll();
  assert.match(ready(ctrl), /data-creation-status="failed"/);
  ctrl.openCreation(ctrl.visibleCreations()[0]);
  await flush();
  const dialog = ready(ctrl);
  assert.match(dialog, /data-creation-error="true">install broke/);
  assert.match(dialog, /查看任务|移除/);
  ctrl.dismissCreation("create-dead");
  await flush();
  assert.doesNotMatch(ready(ctrl), /data-creation-step=/);
});

test("space detail page is a three-tab layout with the header carrying lifecycle actions", async () => {
  const ctrl = controller(fakeApi());
  await ctrl.poll();
  ctrl.openDetail("alpha");
  await flush(); await flush();
  const html = ready(ctrl);
  // Header carries identity + actions.
  assert.ok(html.includes('dsh-wb-space-detail-header'), "header present");
  assert.ok(html.includes('data-space-detail-back="true"'), "back button");
  const headerSeg = html.slice(html.indexOf("dsh-wb-space-detail-header"), html.indexOf("data-space-tablist"));
  assert.ok(!headerSeg.includes("<code>alpha</code>"), "internal space id moved out of header");
  assert.ok(html.includes(t("zh", "detail.enter")), "enter action in header");
  const advancedSeg = html.slice(html.indexOf('data-space-tab="advanced"'));
  assert.ok(advancedSeg.includes('data-space-section="identity"'), "identity card in advanced tab");
  assert.ok(advancedSeg.includes("<code>alpha</code>"), "space id shown in advanced tab");
  // Tablist: three tabs with ARIA wiring.
  const tablistSeg = html.slice(html.indexOf("data-space-tablist"), html.indexOf('data-space-tab="general"'));
  const tabs = [...tablistSeg.matchAll(/role="tab"[^>]*aria-selected="(true|false)"[^>]*>/g)];
  assert.equal(tabs.length, 3, "3 tabs for a web space");
  assert.equal(tabs.filter(m => m[1] === "true").length, 1);
  assert.ok(html.includes('aria-orientation="horizontal"'));
  assert.ok(html.includes('data-space-tab="general"'));
  assert.ok(html.includes('data-space-tab="plugins"'));
  assert.ok(html.includes('data-space-tab="advanced"'));
  assert.ok(html.includes('role="tabpanel"'));
  // Panels stay mounted for effects; the three inactive ones are hidden.
  const generalPanel = html.match(/data-space-tab="general"([^>]*)>/)?.[1] ?? "missing";
  assert.ok(!generalPanel.includes("hidden"), "active general panel visible");
  const pluginsPanel = html.match(/data-space-tab="plugins"([^>]*)>/)?.[1] ?? "missing";
  assert.ok(pluginsPanel.includes("hidden"), "plugins panel hidden by default");
});

test("space detail browser base keeps three tabs and still shows 更换图标", async () => {
  const browserSpace: WorkbenchSpace = { ...alpha, id: "browser-one", base: "browser", managed: true };
  const ctrl = controller(fakeApi({ state: async () => state({ spaces: [manager, browserSpace] }) }));
  await ctrl.poll();
  ctrl.openDetail("browser-one");
  await flush(); await flush();
  const html = ready(ctrl);
  const tablistSeg = html.slice(html.indexOf("data-space-tablist"), html.indexOf('data-space-tab="general"'));
  const tabs = [...tablistSeg.matchAll(/role="tab"[^>]*aria-selected="(true|false)"[^>]*>/g)];
  assert.equal(tabs.length, 3, "3 tabs for a browser space");
  assert.ok(html.includes(t("zh", "detail.changeIcon")), "the icon entry point stays");
});

test("plugin row keeps its row actions inside the ⋯ menu and the install area collapsed", async () => {
  const ctrl = controller(fakeApi({
    plugins: async () => [
      { id: "demo", title: "Demo", packageName: "catalog.demo", description: "A plugin", version: "1.0.0", installedIn: ["alpha"], protected: false },
    ],
    product: async (request) => {
      if (request.method === "plugin.versions") {
        throw Object.assign(new Error("registry offline: 503"), { code: "workbench/failed" });
      }
      return productResult(request);
    },
  }));
  await ctrl.poll();
  ctrl.openDetail("alpha");
  await flush(); await flush(); await flush(); await flush();
  const html = ready(ctrl);
  // Title renders once (no duplicated id when it equals the title).
  const row = html.match(/data-space-plugin="demo"[\s\S]*?<\/span>/)?.[0] ?? "";
  assert.ok(row.includes("<strong>Demo</strong>"), "title once");
  assert.ok(!row.includes(" · <code>demo</code>"), "id not duplicated when it equals the title");
  // Version lookup failure is a compact tag carrying the full reason.
  const note = html.match(/<small[^>]*data-space-plugin-versions-note="demo"[^>]*>/)?.[0] ?? "";
  assert.notEqual(note, "", "compact versions note");
  const noteTitle = note.match(/title="([^"]+)"/)?.[1] ?? "";
  assert.ok(noteTitle.length > 0, "the tag title carries the full reason");
  assert.ok(html.includes(t("zh", "plugins.versionsUnavailable")));
  // Removal actions live inside the per-row ⋯ menu only; no menu exists while closed.
  assert.ok(html.includes(`data-space-plugin-actions="demo"`), "the ⋯ trigger exists");
  assert.ok(!html.includes('[role="menu"]'), "no menu is rendered while all are closed");
  assert.ok(!html.includes('data-space-plugin-menu='), "closed menus do not exist in the DOM");
  const rowText = html.match(/data-space-plugin="demo"[\s\S]*?(?=data-space-plugin=|dsh-wb-actions|data-space-plugin-install)/)?.[0] ?? "";
  assert.ok(!rowText.includes(t("zh", "plugins.removeFromSpace")), "row shows no removal action outside the menu");
  // Install area collapsed by default; the empty-state expander stays reachable.
  assert.ok(html.includes('data-space-plugin-install-area="true" hidden'), "install area collapsed");
});

test("a plugins-origin error is also visible in the header while another tab is active", async () => {
  const api = fakeApi({
    preview: async () => {
      throw Object.assign(new Error("nope"), { code: "workbench/invalid-input" });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.openDetail("alpha");
  await flush();
  ctrl.setPluginCatalog("demo", "1.0.0");
  await flush();
  ctrl.previewInstallSelected("alpha");
  await flush();
  const html = ready(ctrl);
  // The plugins tab is inactive: the reason must still surface under the header.
  const headerArea = html.slice(html.indexOf("dsh-wb-space-detail-header"), html.indexOf("data-space-tablist"));
  assert.ok(headerArea.includes('data-inline-error="detail:alpha:plugins"'),
    "the plugins failure surfaces in the header while the plugins tab is inactive");
});

// ---------------------------------------------------------------------------
// Creator channel (creator.create) parity with ordinary space.create jobs.
// ---------------------------------------------------------------------------

test("a running creator.create job renders the rail placeholder while allowing starting other spaces to queue", async () => {
  const createdJob = job({ id: "creator-1", requestId: "creator-req-1", kind: "creator.create", status: "running",
    phase: "plugins", message: "@acme/tool",
    affectedSpaceIds: ["space-demo"], subject: { displayName: "Demo Space", icon: "whale" } });
  let current = state({ writable: true, jobs: [createdJob] });
  const api = fakeApi({ state: async () => current });
  const ctrl = controller(api);
  await ctrl.poll();
  const markup = ready(ctrl);
  // Later pipeline stages share the last ring step instead of rewinding.
  assert.match(markup, /data-creation-step="4"/);
  assert.match(markup, /data-creation-total="4"/);
  assert.match(markup, /Demo Space · 正在创建/);
  assert.doesNotMatch(markup, /data-space-id="space-demo"[^>]*aria-current/);
  // Starting an unrelated stopped space queues instead of being blocked.
  const submits = () => api.calls.filter((item) => item.method === "submit").length;
  const before = submits();
  ctrl.selectSpace("beta");
  await flush();
  assert.equal(submits(), before + 1);
  assert.equal(ctrl.getSnapshot().commandError, null);
});

test("a creator.create failure keeps the seen placeholder and never enters automatically", async () => {
  const runningJob = job({ id: "creator-dead", requestId: "creator-req-2", kind: "creator.create", status: "running",
    phase: "plugins", affectedSpaceIds: ["space-lost"], subject: { displayName: "Lost Space" } });
  const failedJob = job({ ...runningJob, status: "failed",
    error: { code: "creator/failed", message: "plugin install broke" } });
  let current = state({ writable: true, jobs: [runningJob] });
  const ctrl = controller(fakeApi({ state: async () => current }));
  await ctrl.poll();
  current = state({ writable: true, jobs: [failedJob] });
  await ctrl.poll();
  assert.match(ready(ctrl), /data-creation-status="failed"/);
  ctrl.openCreation(ctrl.visibleCreations()[0]);
  await flush();
  assert.match(ready(ctrl), /data-creation-error="true">plugin install broke/);
  // A failed Agent job is a terminal record: no notice, no pending navigation.
  assert.equal(ctrl.getSnapshot().createdNotice, null);
});

test("a succeeded creator.create shows the notice but never auto-enters", async () => {
  const requestId = "creator-req-3";
  const runningJob = job({ id: "creator-ok", requestId, kind: "creator.create", status: "running",
    phase: "plugins", affectedSpaceIds: ["space-made"], subject: { displayName: "Made Space" } });
  const doneJob = job({ id: "creator-ok", requestId, kind: "creator.create", status: "succeeded",
    phase: "result", affectedSpaceIds: ["space-made"], subject: { displayName: "Made Space" },
    result: { spaceId: "space-made" } });
  let current = state({ writable: true, jobs: [runningJob] });
  const ctrl = controller(fakeApi({ state: async () => current }));
  await ctrl.poll();
  assert.match(ready(ctrl), /Made Space · 正在创建/);
  current = state({ writable: true, jobs: [doneJob], spaces: [manager, alpha, beta, space({ id: "space-made", displayName: "Made Space" })] });
  await ctrl.poll();
  await flush();
  // The notice is shown; auto-enter is reserved for this client's own creates.
  assert.deepEqual(ctrl.getSnapshot().createdNotice, { spaceId: "space-made" });
  assert.equal(ctrl.getSnapshot().selected, "home");
  assert.equal(ctrl.getSnapshot().pendingId, null);
  ctrl.enterCreated();
  await flush();
  assert.equal(ctrl.getSnapshot().createdNotice, null);
  assert.equal(ctrl.getSnapshot().pendingId, "space-made");
});

test("per-space busy keeps unrelated spaces operable, surfaces queued status, and shows restart-now vs restart-later plugin outcome", async () => {
  const runningAlpha = job({
    id: "job-alpha",
    kind: "plan.execute",
    status: "running",
    phase: "install",
    affectedSpaceIds: ["alpha"],
  });
  const queuedBeta = job({
    id: "job-beta",
    kind: "space.start",
    status: "queued",
    phase: "queued",
    affectedSpaceIds: ["beta"],
  });
  const gamma = space({ id: "gamma", displayName: "Gamma", status: "stopped" });
  let current = state({ writable: true, spaces: [manager, alpha, beta, gamma], jobs: [runningAlpha, queuedBeta] });
  const api = fakeApi({
    state: async () => current,
    preview: async (request) => planOf(request, { taskActivity: "busy", runningSpaceIds: ["alpha"] }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  assert.equal(ctrl.isGlobalBusy(), false);
  assert.equal(ctrl.isSpaceBusy("alpha"), true);
  assert.equal(ctrl.isSpaceBusy("beta"), true);
  assert.equal(ctrl.isSpaceBusy("gamma"), false);

  // Queued status shows on beta's detail page and spaces list, while gamma's detail buttons stay enabled.
  ctrl.openSettings();
  const listHtml = ready(ctrl);
  assert.match(listHtml, /Beta[\s\S]*?排队中/);
  ctrl.openDetail("beta");
  await flush();
  assert.ok(ready(ctrl).includes('data-space-job-status="queued"'));
  ctrl.openDetail("gamma");
  await flush();
  const gammaHtml = ready(ctrl);
  assert.doesNotMatch(gammaHtml, /data-space-job-status=/);
  assert.match(gammaHtml, /<button[^>]*class="dsh-wb-btn"[^>]*>启动<\/button>/);

  // Finish alpha's plugin job with restart-required -> shows 立即重启 and 稍后自行重启 on alpha's detail page.
  const settledAlpha = job({
    ...runningAlpha,
    status: "succeeded",
    phase: "done",
    canCancel: false,
    result: {
      spaceId: "alpha",
      pluginApplication: "restart-required",
      restartRequiredSpaceIds: ["alpha"],
    },
  });
  current = state({ writable: true, spaces: [manager, alpha, beta, gamma], jobs: [settledAlpha] });
  await ctrl.poll();
  ctrl.openDetail("alpha");
  await flush();
  const alphaHtml = ready(ctrl);
  assert.ok(alphaHtml.includes('data-plugin-outcome="restart-required"'));
  assert.ok(alphaHtml.includes('data-plugin-restart-now="true"'));
  assert.ok(alphaHtml.includes('data-plugin-restart-later="true"'));

  // Clicking 立即重启 previews space.restart and clears the notice for alpha.
  ctrl.restartFromPluginOutcome("alpha");
  await flush();
  assert.equal(ctrl.getSnapshot().pluginOutcomeNotice, null);
  assert.equal(ctrl.getSnapshot().pendingPlan?.request.kind, "space.restart");
});

test("settings UX: sources live in general, dirty tracks actual changes, quick plugin install and conditional cleanup work", async () => {
  const api = fakeApi({
    plugins: async () => [
      { id: "catalog.demo", title: "Demo", packageName: "demo", description: "A plugin", version: "1.0.0", installedIn: ["alpha"], protected: false },
      { id: "spaces", title: "Spaces", packageName: "dsh-spaces", description: "Manager", version: "0.5.0", installedIn: ["beta"], protected: false },
    ],
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.setSettingsTab("general");
  await flush();
  await flush();
  const generalHtml = ready(ctrl);
  assert.ok(generalHtml.includes('data-settings-advanced="true"'));
  assert.ok(generalHtml.includes('data-settings-section="all"'));
  assert.ok(generalHtml.includes(t("zh", "settings.packageSource")));
  assert.ok(generalHtml.includes(t("zh", "settings.catalogUrl")));
  assert.ok(generalHtml.includes(t("zh", "settings.portStart")), "ports live in unified general -> advanced");
  assert.ok(generalHtml.includes(t("zh", "settings.portEnd")), "ports live in unified general -> advanced");
  assert.equal(ctrl.getSnapshot().settingsDraft?.dirty, false);
  ctrl.saveHomeSettings();
  assert.equal(api.calls.some((call) => call.method === "submit" && (call.arg as { kind?: string })?.kind === "settings.update"), false, "clean settings never submit");
  ctrl.setHomeSettings({ packageSource: "china" });
  assert.equal(ctrl.getSnapshot().settingsDraft?.dirty, true);
  ctrl.setHomeSettings({ packageSource: "official" });
  assert.equal(ctrl.getSnapshot().settingsDraft?.dirty, false, "reverting back to saved settings clears dirty");

  // Alpha does not show cleanup; Beta has misinstalled dsh-spaces and shows cleanup.
  ctrl.openDetail("alpha");
  await flush();
  await flush();
  const alphaHtml = ready(ctrl);
  assert.ok(!alphaHtml.includes('data-space-section="cleanup"'));
  assert.ok(alphaHtml.includes('data-space-plugin-installed="catalog.demo"'), "installed badge rendered in catalog");
  assert.ok(alphaHtml.includes('data-space-delete-remove-data="true"'), "delete removeData checkbox rendered");

  // One-click quick install fetches versions if needed and previews latest.
  ctrl.installCatalogPlugin("alpha", "demo");
  await flush();
  await flush();
  assert.deepEqual(ctrl.getSnapshot().pendingPlan?.request, {
    kind: "plugin.install",
    spaceIds: ["alpha"],
    catalogId: "demo",
    version: "2.0.0",
  });
  ctrl.closePlan();

  ctrl.openDetail("beta");
  await flush();
  await flush();
  assert.ok(ready(ctrl).includes('data-space-section="cleanup"'), "misinstalled manager package reveals cleanup section");

  // startAfterCreate: false skips automatic entry when the create job finishes.
  ctrl.createSpace({ name: "quiet-space", displayName: "Quiet", startAfterCreate: false });
  await flush();
  assert.equal(ctrl.getSnapshot().selected, "home");
});

test("space menu unifies space actions and child overlays stack cleanly above web settings", async () => {
  const ctrl = controller();
  await ctrl.poll();
  ctrl.openSettings();
  ctrl.setSettingsTab("spaces");
  await flush();

  // Opening the context menu from settings keeps SettingsDialog mounted underneath.
  ctrl.openMenu("alpha", 40, 60);
  const menuHtml = ready(ctrl);
  assert.ok(menuHtml.includes('role="dialog"'), "SettingsDialog remains mounted underneath SpaceMenu");
  assert.ok(menuHtml.includes('role="menu"'), "SpaceMenu renders on top");
  for (const label of [
    t("zh", "detail.manage"),
    t("zh", "app.rename"),
    t("zh", "app.changeIcon"),
    t("zh", "app.moveUp"),
    t("zh", "app.moveDown"),
    t("zh", "share.export"),
    t("zh", "templates.save"),
    t("zh", "app.delete"),
  ]) {
    assert.ok(menuHtml.includes(label), `menu includes ${label}`);
  }
  ctrl.closeOverlay();
  assert.deepEqual(ctrl.getSnapshot().overlay, { type: "settings" });

  // Opening SaveTemplateDialog, ExportShareDialog, and CreateDialog over settings preserves SettingsDialog.
  ctrl.openSaveTemplate("alpha");
  assert.ok(ready(ctrl).includes('data-save-template-dialog="true"'));
  assert.ok(ready(ctrl).includes('id="settings-tab-spaces"'));
  ctrl.closeOverlay();
  assert.deepEqual(ctrl.getSnapshot().overlay, { type: "settings" });

  ctrl.openExportShare("alpha");
  assert.ok(ready(ctrl).includes('data-export-share-dialog="true"'));
  assert.ok(ready(ctrl).includes('id="settings-tab-spaces"'));
  ctrl.closeOverlay();
  assert.deepEqual(ctrl.getSnapshot().overlay, { type: "settings" });

  ctrl.openCreate({ mode: "template", templateId: "dev" });
  await flush();
  const createHtml = ready(ctrl);
  assert.ok(createHtml.includes('data-create-dialog="true"'));
  assert.ok(createHtml.includes('data-create-mode="template"'));
  assert.ok(createHtml.includes('id="settings-tab-spaces"'));
  ctrl.closeOverlay();
  assert.deepEqual(ctrl.getSnapshot().overlay, { type: "settings" });
});
