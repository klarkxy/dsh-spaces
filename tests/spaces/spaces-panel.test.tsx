import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  SpaceDetail,
  SpacesCapabilities,
  SpacesApi,
  SpaceSummary,
  SpacesOverview,
} from "../../src/shared/spaces-control.ts";
import {
  createSpacesRemote,
  displayMessage,
  SpacesRemoteError,
  type SpacesConnection,
} from "../../packages/plugin/src/client/remote.ts";
import { SpacesPanelStore, type SpacesPanelSnapshot } from "../../packages/plugin/src/client/state.ts";
import { SpacesPanelView } from "../../packages/plugin/src/client/components.tsx";
import { SpacesMainPanel } from "../../packages/plugin/src/client/panel.tsx";
import {
  ACCEPTANCE_LABELS,
  inferSpacesLocale,
  localizeSafeText,
  t,
  type SpacesLocale,
} from "../../packages/plugin/src/client/i18n.ts";

// ---------- fixtures ----------

const hostSpace: SpaceSummary = {
  id: "host",
  displayName: "Host Space",
  isHost: true,
  hasWebApp: false,
  status: "running",
};

const alpha: SpaceSummary = {
  id: "alpha",
  displayName: "Alpha",
  isHost: false,
  hasWebApp: true,
  status: "running",
};

const beta: SpaceSummary = {
  id: "beta",
  displayName: "Beta",
  isHost: false,
  hasWebApp: false,
  status: "stopped",
};

function capabilities(overrides: Partial<SpacesCapabilities> = {}): SpacesCapabilities {
  return {
    mode: "verified-full",
    hostSpaceId: "host",
    dshVersion: "0.1.5-rc.1",
    canCreate: true,
    reasons: [],
    ...overrides,
  };
}

function detailOf(space: SpaceSummary): SpaceDetail {
  return {
    space,
    plugins: [
      { name: "dsh-spaces", version: "0.2.0" },
      { name: "unversioned-plugin", version: null },
    ],
    snapshots: [{ id: "snap-1", createdAt: "2026-09-01T00:00:00.000Z", runtimeVersion: "0.1.5-rc.1" }],
    diagnostics: [
      {
        level: "error",
        code: "LIVE_CONFIG_UNVERIFIED",
        message: "Current host configuration roots could not be verified.",
      },
    ],
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface FakeApi extends SpacesApi {
  calls: Array<{ method: string; arg: unknown }>;
}

function fakeApi(overrides: Partial<SpacesApi> = {}): FakeApi {
  const calls: FakeApi["calls"] = [];
  return {
    calls,
    overview: async () => {
      calls.push({ method: "overview", arg: undefined });
      return { capabilities: capabilities(), spaces: [hostSpace, alpha] };
    },
    detail: async (id: string) => {
      calls.push({ method: "detail", arg: id });
      const space = [hostSpace, alpha, beta].find((s) => s.id === id);
      if (!space) throw new SpacesRemoteError("spaces/not-found", "Space not found.");
      return detailOf(space);
    },
    create: async (input) => {
      calls.push({ method: "create", arg: input });
      return { ...alpha, id: "created", displayName: input.displayName ?? input.name };
    },
    ...overrides,
  };
}

// ---------- transport: createSpacesRemote over ctx.connection.rpc ----------

test("remote invokes the spaces namespace endpoints with args payload", async () => {
  const seen: Array<{ channel: string; endpoint: string; payload: unknown }> = [];
  const connection: SpacesConnection = {
    rpc: {
      call: async (channel: string, endpoint: string, payload: unknown) => {
        seen.push({ channel, endpoint, payload });
        if (endpoint === "spaces/overview") {
          return { ok: true as const, value: { capabilities: capabilities(), spaces: [alpha] } };
        }
        return { ok: true as const, value: {} };
      },
    },
  };
  const remote = createSpacesRemote(connection);
  const overview = await remote.overview();
  assert.equal(overview.spaces[0]?.id, "alpha");
  await remote.detail("alpha");
  await remote.create({ name: "work" });
  assert.deepEqual(
    seen.map((c) => [c.channel, c.endpoint, c.payload]),
    [
      ["/api", "spaces/overview", { args: {} }],
      ["/api", "spaces/detail", { args: { id: "alpha" } }],
      ["/api", "spaces/create", { args: { input: { name: "work" } } }],
    ],
  );
});

test("remote surfaces known backend error codes verbatim", async () => {
  const connection: SpacesConnection = {
    rpc: {
      call: async () => ({
        ok: false as const,
        error: { code: "spaces/host-denied", message: "The host space cannot be modified.", details: {} },
      }),
    },
  };
  const remote = createSpacesRemote(connection);
  await assert.rejects(remote.create({ name: "host" }), (error: unknown) => {
    assert.ok(error instanceof SpacesRemoteError);
    assert.equal(error.code, "spaces/host-denied");
    assert.equal(error.message, "The host space cannot be modified.");
    return true;
  });
});

test("remote never exposes unknown backend errors or raw transport failures", async () => {
  const unknownCode: SpacesConnection = {
    rpc: {
      call: async () => ({
        ok: false as const,
        error: { code: "internal/boom", message: "token=abc123 at /home/admin/.dsh/config", details: {} },
      }),
    },
  };
  const thrown: SpacesConnection = {
    rpc: {
      call: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:47821 authorization=secret");
      },
    },
  };
  const malformed: SpacesConnection = {
    rpc: { call: async () => ({ ok: true as const, value: null }) },
  };
  for (const connection of [unknownCode, thrown, malformed]) {
    const remote = createSpacesRemote(connection);
    await assert.rejects(remote.overview(), (error: unknown) => {
      assert.ok(error instanceof SpacesRemoteError);
      assert.equal(error.code, null);
      assert.ok(!error.message.includes("token"));
      assert.ok(!error.message.includes("secret"));
      assert.ok(!error.message.includes("ECONNREFUSED"));
      assert.ok(!error.message.includes(".dsh"));
      return true;
    });
  }
});

test("displayMessage passes through sanitized errors and hides everything else", () => {
  assert.equal(displayMessage(new SpacesRemoteError("spaces/locked", "Space is locked.")), "Space is locked.");
  const hidden = displayMessage(new Error("raw path C:/Users/admin/.dsh"));
  assert.ok(!hidden.includes(".dsh"));
});

// ---------- store: state machine ----------

test("refresh loads the overview and auto-selects the first space", async () => {
  const api = fakeApi();
  const store = new SpacesPanelStore(api);
  assert.equal(store.getSnapshot().overview.status, "loading");
  await store.refresh();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.overview.status, "ready");
  assert.equal(snapshot.overview.spaces.length, 2);
  assert.equal(snapshot.selectedId, "host");
  assert.equal(snapshot.detail?.status, "ready");
  assert.equal(snapshot.detail?.detail?.space.id, "host");
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ["overview", "detail"],
  );
});

test("refresh failure without data yields the error state; with data keeps the list", async () => {
  const api = fakeApi({
    overview: async () => {
      throw new SpacesRemoteError("spaces/unavailable", "The Spaces backend is starting up.");
    },
  });
  const store = new SpacesPanelStore(api);
  await store.refresh();
  let snapshot = store.getSnapshot();
  assert.equal(snapshot.overview.status, "error");
  assert.equal(snapshot.overview.error, "The Spaces backend is starting up.");

  // Now let it succeed, then fail again: data must stay visible with a notice.
  let fail = false;
  const api2 = fakeApi({
    overview: async () => {
      if (fail) throw new SpacesRemoteError("spaces/unavailable", "The Spaces backend is starting up.");
      return { capabilities: capabilities(), spaces: [alpha] };
    },
  });
  const store2 = new SpacesPanelStore(api2);
  await store2.refresh();
  fail = true;
  await store2.refresh();
  snapshot = store2.getSnapshot();
  assert.equal(snapshot.overview.status, "ready");
  assert.equal(snapshot.overview.spaces.length, 1);
  assert.equal(snapshot.overview.error, "The Spaces backend is starting up.");
  assert.equal(snapshot.overview.refreshing, false);
});

test("stale detail response for the SAME selection cannot replace the newer one", async () => {
  const pending: Array<(detail: SpaceDetail) => void> = [];
  const api = fakeApi({
    overview: async () => ({ capabilities: capabilities(), spaces: [alpha] }),
    detail: () => new Promise<SpaceDetail>((resolve) => pending.push(resolve)),
  });
  const store = new SpacesPanelStore(api);
  await store.refresh();
  await store.refresh();
  assert.equal(pending.length, 2);
  // Resolve the NEWER request first, then the older one.
  pending[1](detailOf({ ...alpha, displayName: "Alpha NEW" }));
  await flush();
  pending[0](detailOf({ ...alpha, displayName: "Alpha OLD" }));
  await flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.detail?.status, "ready");
  assert.equal(snapshot.detail?.detail?.space.displayName, "Alpha NEW");
});

test("stale detail response for a previous selection never replaces the new selection", async () => {
  const pending = new Map<string, Array<(detail: SpaceDetail) => void>>();
  const api = fakeApi({
    overview: async () => ({ capabilities: capabilities(), spaces: [alpha, beta] }),
    detail: (id: string) =>
      new Promise<SpaceDetail>((resolve) => {
        const list = pending.get(id) ?? [];
        list.push(resolve);
        pending.set(id, list);
      }),
  });
  const store = new SpacesPanelStore(api);
  await store.refresh();
  assert.equal(store.getSnapshot().selectedId, "alpha");
  store.select("beta");
  assert.equal(store.getSnapshot().detail?.status, "loading");
  // Alpha's slow response arrives after the selection moved on.
  pending.get("alpha")![0](detailOf({ ...alpha, displayName: "Alpha STALE" }));
  await flush();
  let snapshot = store.getSnapshot();
  assert.equal(snapshot.selectedId, "beta");
  assert.equal(snapshot.detail?.status, "loading");
  pending.get("beta")![0](detailOf(beta));
  await flush();
  snapshot = store.getSnapshot();
  assert.equal(snapshot.detail?.status, "ready");
  assert.equal(snapshot.detail?.detail?.space.displayName, "Beta");
});

test("a superseded overview refresh cannot roll back newer data", async () => {
  const pending: Array<(overview: SpacesOverview) => void> = [];
  const api = fakeApi({
    overview: () => new Promise<SpacesOverview>((resolve) => pending.push(resolve)),
  });
  const store = new SpacesPanelStore(api);
  void store.refresh();
  void store.refresh();
  assert.equal(pending.length, 2);
  pending[1]({ capabilities: capabilities(), spaces: [alpha, beta] });
  await flush();
  pending[0]({ capabilities: capabilities({ canCreate: false }), spaces: [] });
  await flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.overview.spaces.length, 2);
  assert.equal(snapshot.overview.capabilities?.canCreate, true);
});

test("create is gated on capabilities.canCreate === true before any transport call", async () => {
  const api = fakeApi({
    overview: async () => ({
      capabilities: capabilities({ canCreate: false, reasons: ["Unknown DSH runtime."] }),
      spaces: [alpha],
    }),
  });
  const store = new SpacesPanelStore(api);
  await store.refresh();
  await store.createSpace({ name: "work" });
  assert.equal(api.calls.filter((c) => c.method === "create").length, 0);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.create.pending, false);
  assert.ok(snapshot.create.error !== null && snapshot.create.error.length > 0);
});

test("create success refreshes and selects the new space", async () => {
  const api = fakeApi();
  const store = new SpacesPanelStore(api);
  await store.refresh();
  await store.createSpace({ name: "work", displayName: "Work" });
  const snapshot = store.getSnapshot();
  assert.deepEqual(api.calls.find((c) => c.method === "create")?.arg, { name: "work", displayName: "Work" });
  assert.equal(snapshot.create.pending, false);
  assert.equal(snapshot.create.error, null);
  assert.equal(snapshot.selectedId, "created");
});

// ---------- SSR: accessible structure of the presentational views ----------

const noop = (): void => {};

function render(snapshot: SpacesPanelSnapshot, locale: SpacesLocale = "en"): string {
  return renderToStaticMarkup(
    React.createElement(SpacesPanelView, {
      snapshot,
      locale,
      onLocaleChange: noop,
      onRefresh: noop,
      onSelect: noop,
      onCreate: noop,
    }),
  );
}

function readySnapshot(overrides: Partial<SpacesPanelSnapshot> = {}): SpacesPanelSnapshot {
  return {
    overview: {
      status: "ready",
      capabilities: capabilities(),
      spaces: [hostSpace, alpha],
      error: null,
      refreshing: false,
    },
    selectedId: "alpha",
    detail: {
      id: "alpha",
      status: "ready",
      detail: detailOf(alpha),
      error: null,
    },
    create: { pending: false, error: null },
    ...overrides,
  };
}

test("SSR: loading state announces itself with role=status", () => {
  const html = render({
    overview: { status: "loading", capabilities: null, spaces: [], error: null, refreshing: false },
    selectedId: null,
    detail: null,
    create: { pending: false, error: null },
  });
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes("Loading spaces"));
  assert.ok(html.includes('data-locale="en"'));
  assert.ok(html.includes('aria-pressed="true">English</button>'));
});

test("SSR: overview error renders an alert and only the safe message", () => {
  const html = render({
    overview: {
      status: "error",
      capabilities: null,
      spaces: [],
      error: "A previous space operation did not finish. Recovery is required.",
      refreshing: false,
    },
    selectedId: null,
    detail: null,
    create: { pending: false, error: null },
  });
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes("A previous space operation did not finish. Recovery is required."));
});

test("SSR: unknown error text is replaced, never shown raw", () => {
  const html = render({
    overview: {
      status: "error",
      capabilities: null,
      spaces: [],
      error: "token=abc123 at /home/admin/.dsh/config",
      refreshing: false,
    },
    selectedId: null,
    detail: null,
    create: { pending: false, error: null },
  });
  assert.ok(html.includes("The Spaces service request failed. Try again later."));
  assert.ok(!html.includes("token=abc123"));
  assert.ok(!html.includes("/home/admin"));
  assert.ok(!html.includes(".dsh/config"));
});

test("SSR: list exposes accessible selection, host badge and status text", () => {
  const html = render(readySnapshot());
  assert.ok(html.includes('aria-label="Spaces"'));
  assert.ok(html.includes('aria-current="true"'));
  assert.ok(html.includes(">Alpha</span>"));
  assert.ok(html.includes(">Host</span>"));
  assert.ok(html.includes("Running"));
  // Capabilities: truthful mode label and version.
  assert.ok(html.includes("creation available"));
  assert.ok(html.includes("0.1.5-rc.1"));
});

test("SSR: restricted capabilities render the reasons and disable creation", () => {
  const html = render(
    readySnapshot({
      overview: {
        status: "ready",
        capabilities: capabilities({
          mode: "unknown-readonly",
          canCreate: false,
          reasons: [
            "The bound DSH CLI is not an exact installed version.",
            "Spaces are read-only until the host identity and runtime are confirmed.",
          ],
        }),
        spaces: [alpha],
        error: null,
        refreshing: false,
      },
    }),
  );
  assert.ok(html.includes("The bound DSH CLI is not an exact installed version."));
  assert.ok(html.includes("Spaces are read-only until the host identity and runtime are confirmed."));
  assert.ok(html.includes("Unknown runtime — read-only"));
  assert.ok(html.includes("Creation is not available in the current mode."));
});

test("SSR: empty state and no-selection placeholder", () => {
  const html = render({
    overview: { status: "ready", capabilities: capabilities(), spaces: [], error: null, refreshing: false },
    selectedId: null,
    detail: null,
    create: { pending: false, error: null },
  });
  assert.ok(html.includes("No spaces yet"));
  assert.ok(html.includes("Select a space"));
});

test("SSR: detail renders badge, plugins, snapshots and diagnostics", () => {
  const html = render(readySnapshot());
  assert.ok(html.includes(">Alpha</h3>"));
  assert.ok(html.includes("<code>alpha</code>"));
  assert.ok(html.includes("dsh-spaces"));
  assert.ok(html.includes("0.2.0"));
  assert.ok(html.includes("unversioned-plugin"));
  assert.ok(html.includes("<code>snap-1</code>"));
  assert.ok(html.includes("Current host configuration roots could not be verified."));
  assert.ok(html.includes('data-level="error"'));
});

test("SSR: host detail shows the host badge", () => {
  const html = render(
    readySnapshot({
      selectedId: "host",
      detail: {
        id: "host",
        status: "ready",
        detail: detailOf(hostSpace),
        error: null,
      },
    }),
  );
  assert.ok(html.includes(">Host</span>"));
});

test("SSR: pending create state is exposed", () => {
  const html = render(
    readySnapshot({
      create: { pending: true, error: null },
    }),
  );
  assert.ok(html.includes("Creating…"));
});

test("SSR: connected main panel renders its loading state without a DOM", () => {
  const api = fakeApi();
  const html = renderToStaticMarkup(React.createElement(SpacesMainPanel, { remote: api }));
  assert.ok(html.includes('role="status"'));
  assert.equal(api.calls.length, 0);
});

test("inferSpacesLocale maps zh* to zh and everything else to en", () => {
  assert.equal(inferSpacesLocale("zh"), "zh");
  assert.equal(inferSpacesLocale("zh-CN"), "zh");
  assert.equal(inferSpacesLocale("zh_TW"), "zh");
  assert.equal(inferSpacesLocale("en"), "en");
  assert.equal(inferSpacesLocale("en-US"), "en");
  assert.equal(inferSpacesLocale("ja-JP"), "en");
});

test("localizeSafeText maps known backend English and hides unknown secrets", () => {
  assert.equal(
    localizeSafeText("zh", "The current host space cannot be modified this way."),
    t("zh", "error.hostDenied"),
  );
  assert.equal(localizeSafeText("zh", "spaces/host-denied", "spaces/host-denied"), t("zh", "error.hostDenied"));
  const hidden = localizeSafeText("zh", "token=abc123 at C:/Users/admin/.dsh");
  assert.equal(hidden, t("zh", "error.generic"));
  assert.ok(!hidden.includes("token"));
  assert.ok(!hidden.includes(".dsh"));
});

test("SSR zh: buttons, empty, host lock, capability limit, diagnostics, names stay literal", () => {
  const zh = ACCEPTANCE_LABELS.zh;
  const empty = render(
    {
      overview: { status: "ready", capabilities: capabilities(), spaces: [], error: null, refreshing: false },
      selectedId: null,
      detail: null,
      create: { pending: false, error: null },
    },
    "zh",
  );
  assert.ok(empty.includes(zh.panelTitle));
  assert.ok(empty.includes(zh.refresh));
  assert.ok(empty.includes(zh.empty));
  assert.ok(empty.includes(zh.create));
  assert.ok(empty.includes('data-locale="zh"'));
  assert.ok(empty.includes('lang="zh-CN"'));
  assert.ok(empty.includes('aria-pressed="true">中文</button>'));
  assert.ok(empty.includes("选择一个空间查看详情。"));

  const html = render(
    readySnapshot({
      overview: {
        status: "ready",
        capabilities: capabilities({
          mode: "unknown-readonly",
          canCreate: false,
          reasons: ["The bound DSH CLI is not an exact installed version."],
        }),
        spaces: [hostSpace, alpha],
        error: "The current host space cannot be modified this way.",
        refreshing: false,
      },
      selectedId: "host",
      detail: {
        id: "host",
        status: "ready",
        detail: detailOf(hostSpace),
        error: null,
      },
      create: { pending: false, error: "Creation is not available in the current mode." },
    }),
    "zh",
  );
  assert.ok(html.includes(zh.host));
  assert.ok(html.includes(zh.createDenied));
  assert.ok(html.includes(zh.hostDenied));
  assert.ok(html.includes(zh.modeReadonly));
  assert.ok(html.includes("已绑定的 DSH CLI 不是精确安装版本。"));
  assert.ok(html.includes("无法验证当前宿主配置根目录。"));
  assert.ok(html.includes(">Host Space</h3>"));
  assert.ok(html.includes(">Alpha</span>"));
  assert.ok(html.includes("dsh-spaces"));
  assert.ok(html.includes("unversioned-plugin"));
  assert.ok(html.includes("<code>snap-1</code>"));
  assert.ok(html.includes("0.1.5-rc.1"));
});

test("SSR zh: pending create and running status", () => {
  const zh = ACCEPTANCE_LABELS.zh;
  const html = render(
    readySnapshot({
      create: { pending: true, error: null },
    }),
    "zh",
  );
  assert.ok(html.includes("正在创建…"));
  assert.ok(html.includes(zh.running));
  assert.ok(html.includes(">Alpha</h3>"));
});

test("SSR zh: unknown diagnostic message is not shown", () => {
  const html = render(
    readySnapshot({
      detail: {
        id: "alpha",
        status: "ready",
        detail: {
          ...detailOf(alpha),
          diagnostics: [
            { level: "error", code: "internal/boom", message: "token=abc123 at /home/admin/.dsh/config" },
          ],
        },
        error: null,
      },
    }),
    "zh",
  );
  assert.ok(html.includes(ACCEPTANCE_LABELS.zh.genericError));
  assert.ok(html.includes("internal/boom"));
  assert.ok(!html.includes("token=abc123"));
  assert.ok(!html.includes("/home/admin"));
  assert.ok(!html.includes(".dsh/config"));
});
