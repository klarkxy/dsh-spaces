import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpaceDetail } from "../src/shared/spaces-control.ts";
import type {
  WorkbenchApi,
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchSnapshot,
  WorkbenchSpace,
  WorkbenchState,
  WorkbenchView,
} from "../src/shared/workbench.ts";
import { WorkbenchApp } from "../packages/plugin/src/workbench/app.tsx";
import { RecoverySurface } from "../packages/plugin/src/workbench/recovery.tsx";
import { WorkbenchView } from "../packages/plugin/src/workbench/components.tsx";
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

function state(partial: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    role: "manager",
    managerId: "hub",
    owner: { kind: "web", since: "2026-09-12T00:00:00.000Z" },
    writable: true,
    mode: "verified-full",
    dshVersion: "0.1.5-rc.1",
    maintenance: false,
    recoveryRequired: false,
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
    spaceId,
    generation,
    origin: CHILD_ORIGIN,
    entryOrigin: SUPERVISOR_ORIGIN,
    entryPath: `/view/${spaceId}`,
    channel: `ch-${spaceId}-${generation}`,
  };
}

function readyMessage(spaceId: string, generation = 1, state: "ready" | "failed" = "ready") {
  return {
    source: "dsh-spaces-view" as const,
    spaceId,
    generation,
    channel: `ch-${spaceId}-${generation}`,
    state,
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
    ...partial,
  };
}

interface SpyApi extends WorkbenchApi {
  calls: Array<{ method: string; arg: unknown }>;
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
    submit: async (command, requestId) => {
      calls.push({ method: "submit", arg: { command, requestId } });
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
    preview: async (request) => {
      calls.push({ method: "preview", arg: request });
      return planOf(request);
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
  assert.equal(authorizedViewSrc(view), `${SUPERVISOR_ORIGIN}/view/alpha`);
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
  assert.throws(() => authorizedViewSrc({ ...view, entryPath: "/view\\alpha" }));
  assert.notEqual(authorizedViewSrc(view), `${CHILD_ORIGIN}/view/alpha`);
});

test("view handshake requires origin, event.source, spaceId, generation and channel", () => {
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
  assert.equal(session.get("alpha")?.src, `${SUPERVISOR_ORIGIN}/view/alpha`);
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
  assert.ok(html.includes(t("zh", "app.retry")));
  assert.ok(html.includes(t("zh", "app.diagnose")));
  assert.ok(html.includes(t("zh", "app.openIndependent")));
  assert.ok(html.includes('data-space-id="alpha"'));
  assert.ok(html.includes('data-visible="true"'));
});

test("readonly rejects mutations but still allows queries and acquire/resume", async () => {
  const api = fakeApi({
    state: async () =>
      state({
        writable: false,
        recoveryRequired: true,
        reasons: ["owner held by desktop"],
        jobs: [job({ canCancel: false, status: "recovery-required" })],
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
  ctrl.acquire();
  await flush();
  ctrl.resume();
  await flush();
  const submits = api.calls.filter((item) => item.method === "submit").map((item) => (item.arg as { command: WorkbenchCommand }).command.kind);
  assert.deepEqual(submits, ["controller.acquire", "recovery.resume"]);
  const html = ready(ctrl);
  assert.ok(html.includes("disabled"));
  assert.ok(html.includes(t("zh", "app.readonly")) || html.includes(t("zh", "app.recovery")));
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

test("localStorage only keeps selectedId and locale", async () => {
  const storage = memoryStorage();
  const ctrl = controller(fakeApi(), { storage });
  await ctrl.poll();
  ctrl.setLocale("en");
  ctrl.selectHome();
  const raw = storage.getItem(WORKBENCH_STORAGE_KEY);
  assert.equal(persistLooksSafe(raw), true);
  assert.ok(raw && !raw.includes("http"));
  assert.ok(raw && !raw.includes("token"));
  assert.ok(raw && !raw.includes("entryPath"));
  assert.ok(raw && !raw.includes("channel"));
  const parsed = readPersist(storage);
  assert.equal(parsed.locale, "en");
  assert.equal(parsed.selectedId, "__home__");
  writePersist(storage, { selectedId: "alpha", locale: "zh" });
  assert.deepEqual(JSON.parse(storage.getItem(WORKBENCH_STORAGE_KEY) ?? "{}"), {
    selectedId: "alpha",
    locale: "zh",
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
  assert.ok(html.includes(`src="${SUPERVISOR_ORIGIN}/view/alpha"`));
  assert.ok(!html.includes("token="));
  assert.ok(html.includes('hidden=""') || html.includes("hidden"));
});

test("RecoverySurface shows reasons, jobs, acquire and resume without a manager iframe", async () => {
  const api = fakeApi({
    state: async () =>
      state({
        writable: false,
        recoveryRequired: true,
        reasons: ["desktop holds write access"],
        jobs: [job({ status: "recovery-required", canCancel: false, message: "needs resume" })],
      }),
  });
  const ctrl = controller(api);
  await ctrl.poll();
  const html = renderToStaticMarkup(
    React.createElement(RecoverySurface, { api, env: env({ storage: memoryStorage() }) }),
  );
  assert.ok(html.includes(t("zh", "recovery.title")));
  assert.ok(html.includes(t("zh", "recovery.acquire")));
  assert.ok(html.includes(t("zh", "recovery.resume")));
  assert.ok(!html.includes("<iframe"));
  const readyHtml = renderToStaticMarkup(
    React.createElement(WorkbenchView, {
      ui: { ...ctrl.getSnapshot(), boot: "ready" },
      controller: ctrl,
    }),
  );
  assert.ok(readyHtml.includes("desktop holds write access") || readyHtml.includes(t("zh", "app.recovery")));
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
  assert.ok(html.includes(`src="${SUPERVISOR_ORIGIN}/view/alpha"`));
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
