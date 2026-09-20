import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpaceDetail } from "../src/shared/spaces-control.ts";
import type { SpaceSharePreview } from "../src/shared/space-share.ts";
import type {
  WorkbenchApi,
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPackageRelease,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchSnapshot,
  WorkbenchSpace,
  WorkbenchState,
  WorkbenchView,
} from "../src/shared/workbench.ts";
import type { WorkbenchProductRequest, WorkbenchProductResult } from "../src/shared/workbench-product.ts";
import { WorkbenchApp } from "../packages/plugin/src/workbench/app.tsx";
import { RecoverySurface } from "../packages/plugin/src/workbench/recovery.tsx";
import { JobsList, WorkbenchView } from "../packages/plugin/src/workbench/components.tsx";
import { INTERRUPTED_JOB_MESSAGE } from "../src/adapters/node/workbench-jobs.ts";
import {
  WorkbenchController,
  pollDelayMs,
  type WorkbenchEnv,
} from "../packages/plugin/src/workbench/store.ts";
import {
  ViewSession,
  acceptViewMessage,
  authorizedViewSrc,
  isCleanLoopbackOrigin,
  isTrustedOrigin,
} from "../packages/plugin/src/workbench/view-session.ts";
import { validateWorkbenchIcon } from "../packages/plugin/src/workbench/icons.ts";
import {
  persistLooksSafe,
  readPersist,
  WORKBENCH_STORAGE_KEY,
  writePersist,
} from "../packages/plugin/src/workbench/persistence.ts";
import { t } from "../packages/plugin/src/workbench/i18n.ts";

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
    isolation: "verified",
    icon: "",
    status: "running",
    generation: 1,
    managed: true,
    needsIsolation: false,
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
    owner: { kind: "supervisor", since: "2026-09-12T00:00:00.000Z" },
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

function viewOf(spaceId: string, generation = 1): WorkbenchView {
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
    llmMappingRequired: true,
    llmRequirements: [],
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

test("polling does not duplicate a hanging view request or postpone its timeout", async () => {
  const pending = deferred<WorkbenchView>();
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
    detail: async (spaceId) => {
      calls.push({ method: "detail", arg: spaceId });
      return {
        space: { id: spaceId, displayName: spaceId, isHost: spaceId === "hub", hasWebApp: true, status: "running", isolation: "verified" },
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
      return planOf(request);
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
      return [{ version: "0.1.5-rc.1", installed: true, current: true, compatible: true } satisfies WorkbenchRuntime];
    },
    backups: async (spaceId) => {
      calls.push({ method: "backups", arg: spaceId });
      return [{ id: "bak-1", createdAt: "2026-09-12T00:00:00.000Z", reason: "auto" } satisfies WorkbenchBackup];
    },
    ...overrides,
  };
  if (api.workbenchPackage) {
    const original = api.workbenchPackage.bind(api);
    api.workbenchPackage = async () => {
      calls.push({ method: "workbenchPackage", arg: undefined });
      return original();
    };
  }
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
  const pending = new Map<string, ReturnType<typeof deferred<WorkbenchView>>>();
  const api = fakeApi({
    state: async () => state({ spaces: [manager, space({ id: "alpha" }), space({ id: "beta" })] }),
    view: (spaceId) => {
      const item = deferred<WorkbenchView>();
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
  assert.ok(html.includes(t("zh", "app.copyLogs")));
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
  assert.equal(ui.planError, t("zh", "app.invalidInput"));
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
  assert.ok(html.includes(t("zh", "plan.title")));
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

test("SSR ready home shows management actions and plugin install wording", async () => {
  const ctrl = controller();
  await ctrl.poll();
  ctrl.setHomeTab("plugins");
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "app.home")));
  assert.ok(html.includes(t("zh", "plugins.installToSpace")) || html.includes(t("zh", "plugins.removeFromSpace")));
  assert.ok(html.includes(t("zh", "plugins.toggleHint")));
  assert.ok(html.includes(t("zh", "plugins.cleanup")));
  ctrl.setHomeTab("snapshots");
  await flush();
  const snap = ready(ctrl);
  assert.ok(snap.includes(t("zh", "snapshots.create")));
  assert.ok(!snap.includes(t("zh", "snapshots.restore")));
  assert.ok(!snap.includes("snapshot.restore"));
  ctrl.setHomeTab("runtime");
  await flush();
  const runtime = ready(ctrl);
  assert.ok(runtime.includes(t("zh", "runtime.install")));
  assert.ok(runtime.includes(t("zh", "runtime.upgrade")));
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

test("RecoverySurface shows reasons and jobs without acquire or a manager iframe", async () => {
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
  const html = renderToStaticMarkup(
    React.createElement(RecoverySurface, { api, env: env({ storage: memoryStorage() }) }),
  );
  assert.ok(html.includes(t("zh", "recovery.title")));
  assert.ok(!html.includes("Take write control"));
  assert.ok(!html.includes("接管写控制权"));
  assert.ok(html.includes(t("zh", "app.copyLogs")));
  assert.ok(html.includes(t("zh", "app.errorDetails")));
  assert.ok(!html.includes("<iframe"));
  const readyHtml = renderToStaticMarkup(
    React.createElement(WorkbenchView, {
      ui: { ...ctrl.getSnapshot(), boot: "ready" },
      controller: ctrl,
    }),
  );
  assert.ok(readyHtml.includes("desktop holds write access"));
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
  const ctrl2 = controller(
    fakeApi({
      state: async () =>
        state({
          jobs: [
            job({
              kind: "space.create",
              status: "succeeded",
              canCancel: false,
              result: { spaceId: "later" },
            }),
          ],
          spaces: [manager, space({ id: "later", status: "stopped" })],
        }),
    }),
  );
  await ctrl2.poll();
  assert.equal(ctrl2.getSnapshot().selected, "home");
  assert.equal(ctrl2.getSnapshot().createdNotice?.spaceId, "later");
});

test("deleted spaces do not regain an enter notice from historical creation jobs", async () => {
  const completed = job({ kind: "space.create", status: "succeeded", result: { spaceId: "gone" } });
  let current = state({ jobs: [completed] });
  const ctrl = controller(fakeApi({ state: async () => current }));
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().createdNotice, null);
  current = state({ jobs: [completed], spaces: [manager, space({ id: "gone" })] });
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().createdNotice?.spaceId, "gone");
  current = state({ jobs: [completed] });
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

function packageRelease(partial: Partial<WorkbenchPackageRelease> = {}): WorkbenchPackageRelease {
  return {
    id: "bundled-workbench",
    version: "0.2.0",
    installedVersion: "0.1.0",
    digest: "c0ffee" + "ab".repeat(29),
    updateAvailable: true,
    ...partial,
  };
}

function upgradeButton(html: string): string {
  const match = html.match(/<button[^>]*data-workbench-upgrade="true"[^>]*>/);
  assert.ok(match, "missing workbench upgrade button");
  return match[0];
}

test("runtime tab shows a workbench update region and previews bundled-workbench with candidate version", async () => {
  const digest = "c0ffee" + "ab".repeat(29);
  const api = fakeApi({
    workbenchPackage: async () => packageRelease({ digest }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  assert.equal(api.calls.filter((item) => item.method === "workbenchPackage").length, 0);
  ctrl.setHomeTab("runtime");
  await flush();
  assert.equal(api.calls.filter((item) => item.method === "workbenchPackage").length, 1);
  await ctrl.poll();
  assert.equal(api.calls.filter((item) => item.method === "workbenchPackage").length, 1);
  const html = ready(ctrl);
  assert.ok(html.includes('data-workbench-package="true"'));
  assert.ok(html.includes(t("zh", "workbenchPackage.title")));
  assert.ok(html.includes(t("zh", "workbenchPackage.hint")));
  assert.ok(html.includes(t("zh", "workbenchPackage.consequences")));
  assert.ok(html.includes('data-installed-version="0.1.0"'));
  assert.ok(html.includes('data-candidate-version="0.2.0"'));
  assert.ok(html.includes(`data-candidate-digest="${digest}"`));
  assert.ok(html.includes('data-workbench-prepare="true"'));
  assert.ok(!upgradeButton(html).includes("disabled"));
  ctrl.preview({ kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  await flush();
  assert.deepEqual(api.calls.find((item) => item.method === "preview")?.arg, {
    kind: "workbench.upgrade",
    catalogId: "bundled-workbench",
    version: "0.2.0",
  });
  const planHtml = ready(ctrl);
  assert.ok(planHtml.includes(t("zh", "plan.title")));
  assert.ok(planHtml.includes('data-plan-id="plan-1"'));
  ctrl.confirmPlan();
  await flush();
  const executed = api.calls.find((item) => item.method === "submit");
  assert.deepEqual((executed?.arg as { command: WorkbenchCommand }).command, {
    kind: "plan.execute",
    planId: "plan-1",
  });
  assert.equal(ctrl.getSnapshot().selected, "home");
});

test("old adapter or null candidate explains that this entry has no manager package update", async () => {
  const missing = controller(fakeApi());
  await missing.poll();
  missing.setHomeTab("runtime");
  await flush();
  const missingHtml = ready(missing);
  assert.ok(missingHtml.includes('data-workbench-package-unavailable="true"'));
  assert.ok(missingHtml.includes(t("zh", "workbenchPackage.none")));
  assert.ok(!missingHtml.includes('data-workbench-upgrade="true"'));
  missing.preview({ kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  await flush();
  assert.equal(missing.getSnapshot().pendingPlan, null);

  const emptyApi = fakeApi({
    workbenchPackage: async () => null,
  });
  const empty = controller(emptyApi);
  await empty.poll();
  empty.setHomeTab("runtime");
  await flush();
  assert.equal(emptyApi.calls.filter((item) => item.method === "workbenchPackage").length, 1);
  const emptyHtml = ready(empty);
  assert.ok(emptyHtml.includes(t("zh", "workbenchPackage.none")));
  assert.ok(!emptyHtml.includes('data-workbench-upgrade="true"'));
  empty.preview({ kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  await flush();
  assert.equal(emptyApi.calls.filter((item) => item.method === "preview").length, 0);
});

test("readonly and recovery block workbench upgrade writes", async () => {
  const api = fakeApi({
    state: async () =>
      state({
        writable: false,
        reasons: ["owner held by desktop"],
      }),
    workbenchPackage: async () => packageRelease(),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.setHomeTab("runtime");
  await flush();
  const html = ready(ctrl);
  assert.ok(upgradeButton(html).includes("disabled"));
  ctrl.preview({ kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  await flush();
  assert.equal(api.calls.filter((item) => item.method === "preview").length, 0);
  assert.equal(api.calls.filter((item) => item.method === "submit").length, 0);
  assert.equal(ctrl.getSnapshot().pendingPlan, null);

  const busyApi = fakeApi({
    state: async () => state({ maintenance: true, jobs: [job({ status: "running", kind: "workbench.upgrade" })] }),
    workbenchPackage: async () => packageRelease(),
  });
  const busy = controller(busyApi);
  await busy.poll();
  busy.setHomeTab("runtime");
  await flush();
  assert.ok(upgradeButton(ready(busy)).includes("disabled"));
  busy.preview({ kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  await flush();
  assert.equal(busyApi.calls.filter((item) => item.method === "preview").length, 0);
  assert.equal(busy.getSnapshot().planError, t("zh", "app.locked"));
});

test("same-version content update stays enabled; identical candidate is disabled", async () => {
  const digest = "dd" + "ef".repeat(31);
  const contentApi = fakeApi({
    workbenchPackage: async () =>
      packageRelease({
        version: "0.2.0",
        installedVersion: "0.2.0",
        digest,
        updateAvailable: true,
      }),
  });
  const content = controller(contentApi);
  await content.poll();
  content.setHomeTab("runtime");
  await flush();
  const contentHtml = ready(content);
  assert.ok(contentHtml.includes('data-content-update="true"'));
  assert.ok(contentHtml.includes(t("zh", "workbenchPackage.contentUpdate")));
  assert.ok(contentHtml.includes(`data-candidate-digest="${digest}"`));
  assert.ok(!upgradeButton(contentHtml).includes("disabled"));
  content.preview({ kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  await flush();
  assert.deepEqual(contentApi.calls.find((item) => item.method === "preview")?.arg, {
    kind: "workbench.upgrade",
    catalogId: "bundled-workbench",
    version: "0.2.0",
  });

  const sameApi = fakeApi({
    workbenchPackage: async () =>
      packageRelease({
        version: "0.2.0",
        installedVersion: "0.2.0",
        updateAvailable: false,
      }),
  });
  const same = controller(sameApi);
  await same.poll();
  same.setHomeTab("runtime");
  await flush();
  const sameHtml = ready(same);
  assert.ok(sameHtml.includes(t("zh", "workbenchPackage.current")));
  assert.ok(!sameHtml.includes('data-content-update="true"'));
  assert.ok(upgradeButton(sameHtml).includes("disabled"));
  same.preview({ kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  await flush();
  assert.equal(sameApi.calls.filter((item) => item.method === "preview").length, 0);
});

test("workbench package reloads after a confirmed upgrade reaches a terminal job", async () => {
  let packageCalls = 0;
  const api = fakeApi({
    workbenchPackage: async () => {
      packageCalls += 1;
      return packageRelease({ updateAvailable: packageCalls === 1 });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.setHomeTab("runtime");
  await flush();
  assert.equal(packageCalls, 1);
  ctrl.preview({ kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  await flush();
  ctrl.confirmPlan();
  await flush();
  assert.equal(packageCalls, 2);
  const html = ready(ctrl);
  assert.ok(upgradeButton(html).includes("disabled"));
  assert.ok(html.includes(t("zh", "workbenchPackage.current")));
});

test("handoff-pending upgrade success is not shown as a completed update; failed jobs still show the real error", async () => {
  let packageCalls = 0;
  const failedJob = job({
    id: "job-fail-1",
    requestId: "req-fail",
    kind: "plan.execute",
    status: "failed",
    phase: "verify",
    message: "candidate digest mismatch",
    canCancel: false,
    error: {
      code: "workbench/failed",
      message: "candidate digest mismatch",
    },
  });
  const pendingJob = job({
    id: "job-uuid-1",
    requestId: "uuid-1",
    kind: "plan.execute",
    status: "succeeded",
    phase: "handoff-pending",
    message: "prepared",
    canCancel: false,
  });
  let jobs: WorkbenchJob[] = [failedJob];
  const api = fakeApi({
    workbenchPackage: async () => {
      packageCalls += 1;
      return packageRelease({ updateAvailable: true });
    },
    state: async () => state({ jobs }),
    submit: async (command, requestId) => {
      const next = {
        ...pendingJob,
        id: `job-${requestId}`,
        requestId,
        kind: command.kind,
      };
      jobs = [next, failedJob];
      return next;
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.setHomeTab("runtime");
  await flush();
  assert.equal(packageCalls, 1);
  ctrl.preview({ kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  await flush();
  ctrl.confirmPlan();
  await flush();
  await ctrl.poll();
  assert.equal(packageCalls, 1);
  const runtimeHtml = ready(ctrl);
  assert.ok(!runtimeHtml.includes(t("zh", "workbenchPackage.current")));
  assert.ok(!runtimeHtml.includes(t("en", "workbenchPackage.current")));

  ctrl.setHomeTab("overview");
  const zhHtml = ready(ctrl);
  assert.ok(zhHtml.includes('data-job-id="job-uuid-1"'));
  assert.ok(zhHtml.includes('data-status="succeeded"'));
  assert.ok(zhHtml.includes('data-phase="handoff-pending"'));
  assert.ok(zhHtml.includes('data-handoff-pending="true"'));
  assert.ok(zhHtml.includes("plan.execute"));
  assert.ok(zhHtml.includes("succeeded"));
  assert.ok(zhHtml.includes("handoff-pending"));
  assert.ok(zhHtml.includes("prepared"));
  assert.ok(zhHtml.includes(t("zh", "jobs.handoffPending")));
  assert.equal(t("zh", "jobs.handoffPending"), "已准备更新，正在交接服务；新服务启动尚未确认");
  assert.ok(!zhHtml.includes(t("zh", "workbenchPackage.current")));
  assert.ok(!zhHtml.includes("升级完成"));
  assert.ok(!zhHtml.includes("成功启动"));
  assert.ok(zhHtml.includes('data-job-id="job-fail-1"'));
  assert.ok(zhHtml.includes('data-status="failed"'));
  assert.ok(zhHtml.includes(`${t("zh", "jobs.failed")}: candidate digest mismatch`));

  ctrl.setLocale("en");
  const enHtml = ready(ctrl);
  assert.ok(enHtml.includes(t("en", "jobs.handoffPending")));
  assert.equal(
    t("en", "jobs.handoffPending"),
    "Update is prepared; handing off the service. The new service has not been confirmed started.",
  );
  assert.ok(!enHtml.includes(t("en", "workbenchPackage.current")));
  assert.ok(!enHtml.includes("upgrade complete"));
  assert.ok(!enHtml.includes("successfully started"));
  assert.ok(enHtml.includes(`${t("en", "jobs.failed")}: candidate digest mismatch`));

  ctrl.setHomeTab("runtime");
  await flush();
  assert.equal(packageCalls, 1);
});

test("prepare update submits workbench.prepare through CAS and reloads the candidate", async () => {
  let packageCalls = 0;
  const first = packageRelease({ version: "0.1.0", installedVersion: "0.1.0", updateAvailable: false, digest: "aa".repeat(32) });
  const prepared = packageRelease({ version: "0.2.0", installedVersion: "0.1.0", updateAvailable: true, digest: "bb".repeat(32) });
  const api = fakeApi({
    workbenchPackage: async () => {
      packageCalls += 1;
      return packageCalls === 1 ? first : prepared;
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.setHomeTab("runtime");
  await flush();
  assert.equal(packageCalls, 1);
  const before = ready(ctrl);
  assert.ok(before.includes('data-candidate-version="0.1.0"'));
  assert.ok(before.includes(t("zh", "workbenchPackage.current")));
  assert.ok(!before.includes(t("zh", "plan.title")));
  ctrl.prepareWorkbenchPackage();
  await flush();
  const submitted = api.calls.find((item) => item.method === "submit");
  const submittedArg = submitted?.arg as { command: WorkbenchCommand; context: WorkbenchMutationContext };
  assert.deepEqual(submittedArg.command, { kind: "workbench.prepare" });
  assert.deepEqual(submittedArg.context, { serviceEpoch: EPOCH, expectedRevision: REVISION });
  assert.equal(api.calls.filter((item) => item.method === "product").length, 0);
  assert.equal(packageCalls, 2);
  const html = ready(ctrl);
  assert.ok(html.includes('data-candidate-version="0.2.0"'));
  assert.ok(html.includes(`data-candidate-digest="${prepared.digest}"`));
  assert.ok(html.includes(t("zh", "workbenchPackage.consequences")));
  assert.ok(!html.includes(t("zh", "plan.title")));
  assert.equal(api.calls.filter((item) => item.method === "preview").length, 0);
  assert.ok(!upgradeButton(html).includes("disabled"));
  ctrl.preview({ kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" });
  await flush();
  assert.ok(ready(ctrl).includes(t("zh", "plan.title")));
});

test("failed prepare keeps the previous candidate and does not claim a ready update", async () => {
  const previous = packageRelease({ version: "0.1.0", installedVersion: "0.1.0", updateAvailable: false, digest: "aa".repeat(32) });
  const api = fakeApi({
    workbenchPackage: async () => previous,
    submit: async (command, requestId, context) => {
      api.calls.push({ method: "submit", arg: { command, requestId, context } });
      return job({
        id: `job-${requestId}`,
        requestId,
        kind: command.kind,
        status: "failed",
        canCancel: false,
        error: { code: "workbench/failed", message: "catalog unreachable" },
      });
    },
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.setHomeTab("runtime");
  await flush();
  ctrl.prepareWorkbenchPackage();
  await flush();
  assert.equal(api.calls.filter((item) => item.method === "workbenchPackage").length, 1);
  const html = ready(ctrl);
  assert.ok(html.includes('data-candidate-version="0.1.0"'));
  assert.ok(html.includes(t("zh", "workbenchPackage.current")));
  assert.ok(html.includes("catalog unreachable"));
  assert.ok(!html.includes("0.2.0"));
  assert.ok(upgradeButton(html).includes("disabled"));
  assert.equal(ctrl.getSnapshot().pendingPlan, null);
});

test("prepare stays disabled while a job is busy and does not auto-retry", async () => {
  const api = fakeApi({
    state: async () => state({ jobs: [job({ status: "running", kind: "workbench.prepare" })] }),
    workbenchPackage: async () => packageRelease({ updateAvailable: false, version: "0.1.0", installedVersion: "0.1.0" }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  ctrl.setHomeTab("runtime");
  await flush();
  const html = ready(ctrl);
  const prepare = html.match(/<button[^>]*data-workbench-prepare="true"[^>]*>/);
  assert.ok(prepare);
  assert.ok(prepare[0].includes("disabled"));
  ctrl.prepareWorkbenchPackage();
  await flush();
  assert.equal(api.calls.filter((item) => item.method === "submit").length, 0);
  assert.equal(ctrl.getSnapshot().commandError, t("zh", "app.locked"));
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
  assert.ok(html.includes("Development"));
  assert.ok(html.includes(t("zh", "share.includeConfig")));
  assert.ok(html.includes(t("zh", "share.export")));
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
  assert.equal(ctrl.getSnapshot().commandError, t("zh", "app.conflict"));
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
  assert.ok(html.includes(t("zh", "share.llmMapping")));
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
                llm: { mappingRequired: true, requirements: [], mapped: false },
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
  await flush();
  const html = ready(ctrl);
  assert.ok(html.includes(t("zh", "settings.shutdown")));
  assert.ok(html.includes(t("zh", "settings.exit")));
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

test("applyView rejects missing or non-hex serviceEpoch before minting src", () => {
  const session = new ViewSession();
  const first = session.requestSpace(space({ id: "alpha" }));
  session.applyView("alpha", first.token, { ...viewOf("alpha"), serviceEpoch: "nope" });
  assert.equal(session.get("alpha")?.status, "failed");
  assert.equal(session.get("alpha")?.error, "unauthorized-view");
  assert.equal(session.get("alpha")?.src, null);
  const second = session.retry(space({ id: "alpha" }));
  session.applyView("alpha", second.token, { ...viewOf("alpha"), serviceEpoch: "" });
  assert.equal(session.get("alpha")?.status, "failed");
  const third = session.retry(space({ id: "alpha" }));
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
  const saved = { portStart: 3100, portEnd: 3199, packageSource: "official" as const, catalogUrl: "" };
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
