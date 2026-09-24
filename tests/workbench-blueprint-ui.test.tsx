import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Blueprint } from "../src/shared/blueprint.ts";
import type {
  WorkbenchApi,
  WorkbenchJob,
  WorkbenchSpace,
  WorkbenchState,
} from "../src/shared/workbench.ts";
import type {
  WorkbenchProductObservation,
  WorkbenchProductRequest,
  WorkbenchProductResult,
} from "../src/shared/workbench-product.ts";
import type { WorkbenchBlueprintApplyOutcome } from "../src/shared/workbench-blueprint.ts";
import { WorkbenchView } from "../packages/plugin/src/workbench/components.tsx";
import { BlueprintApplyResult } from "../packages/plugin/src/workbench/blueprint-ui.tsx";
import {
  WorkbenchController,
  type WorkbenchEnv,
} from "../packages/plugin/src/workbench/store.ts";
import { t } from "../packages/plugin/src/workbench/i18n.ts";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const EPOCH = "aa".repeat(32);
const REVISION = "bb".repeat(32);
const OBSERVATION: WorkbenchProductObservation = { serviceEpoch: EPOCH, expectedRevision: REVISION };

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

const manager = space({ id: "hub", displayName: "Hub", isHost: true });
const alpha = space({ id: "alpha", displayName: "Alpha" });

function state(partial: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    protocolVersion: 2,
    serviceEpoch: EPOCH,
    revision: REVISION,
    availability: "ready",
    role: "manager",
    managerId: "hub",
    owner: { kind: "supervisor", since: "2026-09-21T00:00:00.000Z" },
    writable: true,
    mode: "verified-full",
    dshVersion: "0.1.5-rc.2",
    maintenance: false,
    reasons: [],
    spaces: [manager, alpha],
    jobs: [],
    ...partial,
  };
}

function sampleBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    kind: "dsh-blueprint",
    formatVersion: 1,
    metadata: { name: "写作工作台", version: "1.0.0", description: "demo" },
    packages: [{ name: "@example/writing-tools", version: "2.1.0", source: { type: "npm" } }],
    profile: {
      base: "web",
      bundles: ["@example/writing-tools"],
      patch: [{ id: "example-writing-tools", config: { outputDirectory: null } }],
      settings: { "example-writing-preferences": { fontSize: 18 } },
    },
    inputs: [
      { id: "output-directory", type: "directory", label: "Dir", required: true },
      { id: "title", type: "string", label: "Title", required: false, default: "draft" },
    ],
    bindings: [],
    relations: [],
    ...overrides,
  };
}

const host = {
  dsh: "0.1.5-rc.2",
  spaces: "0.3.1",
  node: "22.0.0",
  os: "win32",
  arch: "x64",
  base: "0.1.5-rc.2",
  webApp: "0.1.5-rc.2",
};

function job(partial: Partial<WorkbenchJob> & Pick<WorkbenchJob, "kind">): WorkbenchJob {
  return {
    id: "job-1",
    requestId: "req-1",
    status: "succeeded",
    phase: "done",
    message: "ok",
    affectedSpaceIds: [],
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    canCancel: false,
    ...partial,
  };
}

function fakeApi(product: (request: WorkbenchProductRequest) => WorkbenchProductResult): WorkbenchApi {
  return {
    state: async () => state(),
    detail: async (spaceId) => ({
      space: {
        id: spaceId,
        displayName: spaceId,
        isHost: false,
        hasWebApp: true,
        status: "running",
        isolation: "verified",
      },
      plugins: [],
      snapshots: [],
      diagnostics: [],
    }),
    submit: async (command, requestId) => job({ kind: command.kind, requestId, id: requestId }),
    job: async (id) => job({ kind: "job", id, requestId: id }),
    cancel: async (id) => job({ kind: "cancel", id, requestId: id }),
    view: async (spaceId) => ({
      serviceEpoch: EPOCH,
      spaceId,
      generation: 1,
      origin: "http://127.0.0.1:3101",
      entryOrigin: "http://127.0.0.1:3100",
      entryPath: `/view/${spaceId}`,
      channel: `ch-${spaceId}-1`,
    }),
    preview: async () => {
      throw new Error("not used");
    },
    product: async (request) => product(request),
    plugins: async () => [],
    snapshots: async () => [],
    snapshot: async (id) => ({
      id,
      createdAt: "2026-09-21T00:00:00.000Z",
      runtimeVersion: "0.1.5-rc.2",
      spaceIds: [],
      bytes: 0,
      restorable: false,
    }),
    runtimes: async () => [],
    backups: async () => [],
  };
}

const controllers: WorkbenchController[] = [];
afterEach(() => {
  for (const instance of controllers.splice(0)) instance.stop();
});

function controller(api: WorkbenchApi): WorkbenchController {
  const instance = new WorkbenchController(api, {
    uuid: () => "uuid-1",
    storage: memoryStorage(),
    hidden: () => false,
    onVisibilityChange: () => () => undefined,
    addMessageListener: () => () => undefined,
    openUrl: () => undefined,
    downloadFile: () => undefined,
    writeClipboard: async () => undefined,
    now: () => Date.parse("2026-09-21T00:00:00.000Z"),
  });
  controllers.push(instance);
  return instance;
}

function html(ctrl: WorkbenchController): string {
  return renderToStaticMarkup(React.createElement(WorkbenchView, { ui: ctrl.getSnapshot(), controller: ctrl }));
}

function defaultProduct(request: WorkbenchProductRequest): WorkbenchProductResult {
  const blueprint = sampleBlueprint();
  if (request.method === "blueprint.inspect") {
    return { method: "blueprint.inspect", blueprint, diagnostics: [], observation: OBSERVATION };
  }
  if (request.method === "blueprint.preview") {
    return {
      method: "blueprint.preview",
      blueprint,
      packages: [{ name: "@example/writing-tools", version: "2.1.0", source: "npm", bundled: true, order: 0 }],
      inputs: [
        { id: "output-directory", type: "directory", origin: "explicit", value: "/tmp/out" },
        { id: "title", type: "string", origin: "default", value: "draft" },
        { id: "unused", type: "string", origin: "missing" },
      ],
      host,
      planId: "plan-bp-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      diagnostics: [{ code: "rel", message: "author relation", severity: "warning" }],
      missingInputs: [],
      observation: OBSERVATION,
    };
  }
  if (request.method === "blueprint.source") {
    return {
      method: "blueprint.source",
      spaceId: request.spaceId,
      packages: [
        {
          name: "@example/writing-tools",
          version: "2.1.0",
          source: "npm",
          inBundles: true,
          hasBundlePatch: true,
          eligibility: { available: true },
          lifecycleScripts: ["postinstall"],
        },
      ],
      bundles: [{ name: "@example/writing-tools", order: 0, eligible: true }],
      patch: { exists: true, shareable: true },
      settingsNamespaces: [{ namespace: "keep-a", eligible: true, shareable: true, convertible: true }],
      localObservations: [
        { pointer: "/profile/patch/0/config/outputDirectory", kind: "directory", reason: "local directory" },
      ],
      host,
      observation: OBSERVATION,
    };
  }
  if (request.method === "blueprint.generate") {
    return {
      method: "blueprint.generate",
      fileName: "writing.dsh-blueprint.json",
      json: JSON.stringify(blueprint),
      shareCode: "DSHBP1:J:e30",
      blueprint,
      diagnostics: [],
      observation: OBSERVATION,
    };
  }
  throw new Error(request.method);
}

test("settings navigation includes Blueprints without renaming templates or import", async () => {
  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  ctrl.openSettings();
  const home = html(ctrl);
  assert.ok(home.includes(t("zh", "home.blueprints")));
  assert.ok(home.includes(t("zh", "home.templates")));
  assert.ok(!home.includes("data-blueprints=\"true\""));
  ctrl.setHomeTab("blueprints");
  const page = html(ctrl);
  assert.ok(page.includes("data-blueprints=\"true\""));
  assert.ok(page.includes(t("zh", "blueprints.use")));
  assert.ok(page.includes(t("zh", "blueprints.generate")));
  assert.ok(page.includes(t("zh", "blueprints.paste")));
  assert.ok(page.includes(t("zh", "blueprints.openFile")));
  assert.ok(page.includes(t("zh", "blueprints.inspect")));
  assert.ok(!page.includes(t("zh", "templates.title")));
  assert.ok(!page.includes(t("zh", "share.import")));
  ctrl.setLocale("en");
  const english = html(ctrl);
  assert.ok(english.includes("Use blueprint"));
  assert.ok(english.includes("Create blueprint"));
  assert.ok(english.includes("Paste a share code or JSON"));
});

test("ordinary space menu offers Create blueprint; manager and web do not", async () => {
  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  ctrl.openMenu("alpha", 10, 10);
  const menu = html(ctrl);
  assert.ok(menu.includes(t("zh", "blueprints.generate")));
  const generate = t("zh", "blueprints.generate");
  const alphaAt = menu.lastIndexOf(generate);
  assert.ok(alphaAt > 0);
  assert.equal(menu.slice(Math.max(0, alphaAt - 120), alphaAt).includes("disabled"), false);
  ctrl.openMenu("hub", 10, 10);
  const hub = html(ctrl);
  const hubAt = hub.lastIndexOf(generate);
  assert.ok(hubAt > 0);
  assert.equal(hub.slice(Math.max(0, hubAt - 120), hubAt).includes("disabled"), true);
});

test("inspect, preview origins, install hint and GitHub warning render", async () => {
  const github = sampleBlueprint({
    packages: [
      {
        name: "@example/from-git",
        version: "1.0.0",
        source: { type: "github", repository: "ex/repo", commit: "a".repeat(40) },
      },
    ],
  });
  const ctrl = controller(
    fakeApi((request) => {
      if (request.method === "blueprint.inspect") {
        return { method: "blueprint.inspect", blueprint: github, diagnostics: [], observation: OBSERVATION };
      }
      return defaultProduct(request);
    }),
  );
  await ctrl.poll();
  ctrl.setHomeTab("blueprints");
  ctrl.blueprint.setContent("{}");
  ctrl.blueprint.inspect();
  await flush();
  const inspected = html(ctrl);
  assert.ok(inspected.includes(t("zh", "blueprints.githubUnsupported")));
  assert.ok(inspected.includes(t("zh", "blueprints.selected")));
  assert.ok(inspected.includes(t("zh", "blueprints.bundled")));
  assert.ok(inspected.includes(t("zh", "blueprints.selectionNote")));
  assert.ok(inspected.includes(t("zh", "blueprints.directoryHint")));
  ctrl.blueprint.setName("from-blueprint");
  ctrl.blueprint.setStringInput("output-directory", "/tmp/out");
  ctrl.blueprint.preview();
  await flush();
  const previewed = html(ctrl);
  assert.ok(previewed.includes(t("zh", "blueprints.origin.explicit")));
  assert.ok(previewed.includes(t("zh", "blueprints.origin.default")));
  assert.ok(previewed.includes(t("zh", "blueprints.origin.missing")));
  assert.ok(previewed.includes(t("zh", "blueprints.installHint")));
  assert.ok(previewed.includes(t("zh", "blueprints.apply")));
  assert.ok(previewed.includes(t("zh", "blueprints.host")));
  assert.ok(previewed.includes("0.1.5-rc.2"));
});

test("create mode lists packages separately from bundle order and convert controls", async () => {
  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  ctrl.openBlueprintGenerate("alpha");
  await flush();
  const page = html(ctrl);
  assert.equal(ctrl.getSnapshot().homeTab, "blueprints");
  assert.ok(page.includes("data-blueprint-mode=\"generate\""));
  assert.ok(page.includes("@example/writing-tools"));
  assert.ok(page.includes(t("zh", "blueprints.bundles")));
  assert.ok(page.includes(t("zh", "blueprints.convert")));
  assert.ok(page.includes("/profile/patch/0/config/outputDirectory"));
  assert.ok(page.includes(t("zh", "blueprints.advancedPointer")));
  assert.ok(page.includes(t("zh", "blueprints.provenance")));
  assert.match(page, /<details[^>]*>/);
  assert.doesNotMatch(page, /<details[^>]*\sopen(?:[=&\s>]|$)/);
  assert.match(page, new RegExp(`<summary>${t("zh", "blueprints.advancedPointer")}</summary>`));
});

test("managed observations stay out of convert drafts while directory and dynamic remain reachable", async () => {
  const convert = t("zh", "blueprints.convert");
  const ctrl = controller(
    fakeApi((request) => {
      if (request.method !== "blueprint.source") return defaultProduct(request);
      const source = defaultProduct(request);
      if (source.method !== "blueprint.source") throw new Error(source.method);
      return {
        ...source,
        localObservations: [
          { pointer: "/profile/patch/0", kind: "managed", reason: "Owned isolation fields were omitted." },
          { pointer: "/profile/patch/1", kind: "managed", reason: "Owned isolation fields were omitted." },
          { pointer: "/profile/patch/2", kind: "managed", reason: "Owned isolation fields were omitted." },
          { pointer: "/profile/patch/3", kind: "managed", reason: "Owned isolation fields were omitted." },
          { pointer: "/profile/patch/4/config/hook", kind: "dynamic", reason: "Dynamic expressions cannot be shared." },
          { pointer: "/profile/settings/llm-pi-ai", kind: "model", reason: "Managed model settings are not copied." },
          { pointer: "/profile/patch/0/config/outputDirectory", kind: "directory", reason: "local directory" },
        ],
      };
    }),
  );
  await ctrl.poll();
  ctrl.openBlueprintGenerate("alpha");
  await flush();
  const page = html(ctrl);
  const bindings = ctrl.blueprint.getSnapshot().bindings;
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]?.type, "directory");
  assert.equal(bindings[0]?.pointer, "/profile/patch/0/config/outputDirectory");
  assert.equal(page.includes("Owned isolation fields were omitted."), false);
  assert.ok(page.includes("Dynamic expressions cannot be shared."));
  assert.ok(page.includes("/profile/patch/4/config/hook"));
  assert.ok(page.includes("/profile/patch/0/config/outputDirectory"));
  assert.ok(page.includes(convert));
  assert.equal(page.split(convert).length - 1, 2);
  assert.match(page, /<details class="dsh-wb-form">/);
  assert.doesNotMatch(page, /<details[^>]*\sopen(?:[=&\s>]|$)/);
  assert.match(page, new RegExp(`<summary>${t("zh", "blueprints.advancedPointer")}</summary>`));
  assert.ok(page.includes(t("zh", "blueprints.inputId")));
});

test("managed-only source hides isolation noise and keeps the closed pointer editor", async () => {
  const convert = t("zh", "blueprints.convert");
  const ctrl = controller(
    fakeApi((request) => {
      if (request.method !== "blueprint.source") return defaultProduct(request);
      const source = defaultProduct(request);
      if (source.method !== "blueprint.source") throw new Error(source.method);
      return {
        ...source,
        localObservations: [
          { pointer: "/profile/patch/0", kind: "managed", reason: "Owned isolation fields were omitted." },
          { pointer: "/profile/patch/1", kind: "managed", reason: "Owned isolation fields were omitted." },
          { pointer: "/profile/patch/2", kind: "managed", reason: "Owned isolation fields were omitted." },
          { pointer: "/profile/patch/3", kind: "managed", reason: "Owned isolation fields were omitted." },
        ],
      };
    }),
  );
  await ctrl.poll();
  ctrl.openBlueprintGenerate("alpha");
  await flush();
  const page = html(ctrl);
  assert.deepEqual(ctrl.blueprint.getSnapshot().bindings, []);
  assert.equal(page.includes("Owned isolation fields were omitted."), false);
  assert.equal(page.includes(t("zh", "blueprints.local")), false);
  assert.equal(page.split(convert).length - 1, 1);
  assert.match(page, new RegExp(`<summary>${t("zh", "blueprints.advancedPointer")}</summary>`));
  assert.ok(page.includes(t("zh", "blueprints.inputId")));
});

test("apply result shows four stages, created-not-started, and no recovery actions", () => {
  const outcome: WorkbenchBlueprintApplyOutcome = {
    kind: "blueprint.apply",
    spaceId: "from-blueprint",
    stages: {
      "space-create": { status: "succeeded" },
      packages: { status: "failed", error: "install failed" },
      presets: { status: "not-run" },
      start: { status: "not-run" },
    },
    installed: [],
    packageResults: [{ name: "@example/writing-tools", version: "2.1.0", status: "failed", error: "install failed" }],
    writes: [{ kind: "patch", status: "not-run" }, { kind: "settings", status: "not-run" }],
    host: { dsh: "0.1.5-rc.2", spaces: "0.3.1", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
    source: { name: "写作工作台", version: "1.0.0" },
  };
  const zh = renderToStaticMarkup(React.createElement(BlueprintApplyResult, { locale: "zh", outcome }));
  assert.ok(zh.includes(t("zh", "blueprints.stage.spaceCreate")));
  assert.ok(zh.includes(t("zh", "blueprints.stage.packages")));
  assert.ok(zh.includes(t("zh", "blueprints.stage.presets")));
  assert.ok(zh.includes(t("zh", "blueprints.stage.start")));
  assert.ok(zh.includes(t("zh", "blueprints.status.notRun")));
  assert.ok(zh.includes("data-blueprint-stage=\"start\""));
  assert.ok(!zh.includes("重试"));
  assert.ok(!zh.includes("恢复"));
  const en = renderToStaticMarkup(React.createElement(BlueprintApplyResult, { locale: "en", outcome }));
  assert.ok(en.includes("Space creation"));
  assert.ok(en.includes("Package installation"));
  assert.ok(en.includes("Presets"));
  assert.ok(en.includes("Space start"));
  assert.ok(en.includes("Not run"));
});

test("successful blueprint apply renders created-not-started and does not auto-enter", async () => {
  const outcome: WorkbenchBlueprintApplyOutcome = {
    kind: "blueprint.apply",
    spaceId: "from-blueprint",
    stages: {
      "space-create": { status: "succeeded" },
      packages: { status: "succeeded" },
      presets: { status: "succeeded" },
      start: { status: "not-run" },
    },
    installed: [{ name: "@example/writing-tools", version: "2.1.0" }],
    packageResults: [{ name: "@example/writing-tools", version: "2.1.0", status: "succeeded" }],
    writes: [
      { kind: "patch", status: "succeeded" },
      { kind: "settings", status: "succeeded" },
    ],
    host: { dsh: "0.1.5-rc.2", spaces: "0.3.1", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
    source: { name: "写作工作台", version: "1.0.0" },
  };
  const api = fakeApi((request) => defaultProduct(request));
  api.submit = async (command, requestId) =>
    job({
      kind: command.kind,
      requestId,
      id: "apply-1",
      status: "succeeded",
      result: { product: outcome, spaceId: "from-blueprint" },
    });
  const live = controller(api);
  await live.poll();
  live.setHomeTab("blueprints");
  live.blueprint.setContent("{}");
  live.blueprint.inspect();
  await flush();
  live.blueprint.setName("from-blueprint");
  live.blueprint.setStringInput("output-directory", "/tmp/out");
  live.blueprint.preview();
  await flush();
  live.blueprint.apply();
  await flush();
  const page = html(live);
  assert.ok(page.includes(t("zh", "blueprints.createdNotStarted")));
  assert.ok(page.includes("data-blueprint-created=\"true\""));
  assert.ok(!page.includes(t("zh", "create.enter")));
  assert.equal(page.includes(t("zh", "blueprints.previewExpired")), false);
  assert.equal(page.includes(t("zh", "blueprints.apply")), false);
  assert.equal(live.getSnapshot().selected, "home");
  assert.equal(live.getSnapshot().createdNotice, null);
  assert.equal(live.blueprint.getSnapshot().applyOutcome?.stages.start.status, "not-run");
});

test("successful current plan hides expired chrome; a new plan is valid; unsent stale stays disabled", async () => {
  const outcome: WorkbenchBlueprintApplyOutcome = {
    kind: "blueprint.apply",
    spaceId: "from-blueprint",
    stages: {
      "space-create": { status: "succeeded" },
      packages: { status: "succeeded" },
      presets: { status: "succeeded" },
      start: { status: "not-run" },
    },
    installed: [{ name: "@example/writing-tools", version: "2.1.0" }],
    packageResults: [{ name: "@example/writing-tools", version: "2.1.0", status: "succeeded" }],
    writes: [
      { kind: "patch", status: "succeeded" },
      { kind: "settings", status: "succeeded" },
    ],
    host: { dsh: "0.1.5-rc.2", spaces: "0.3.1", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
    source: { name: "写作工作台", version: "1.0.0" },
  };
  let previews = 0;
  const api = fakeApi((request) => {
    if (request.method !== "blueprint.preview") return defaultProduct(request);
    previews += 1;
    return { ...defaultProduct(request), planId: `plan-bp-${previews}` };
  });
  api.submit = async (command, requestId) =>
    job({
      kind: command.kind,
      requestId,
      id: "apply-1",
      status: "succeeded",
      result: { product: outcome, spaceId: "from-blueprint" },
    });
  const live = controller(api);
  await live.poll();
  live.setHomeTab("blueprints");
  live.blueprint.setContent("{}");
  live.blueprint.inspect();
  await flush();
  live.blueprint.setName("from-blueprint");
  live.blueprint.setStringInput("output-directory", "/tmp/out");
  live.blueprint.preview();
  await flush();
  live.blueprint.apply();
  await flush();
  const expired = t("zh", "blueprints.previewExpired");
  const applyLabel = t("zh", "blueprints.apply");
  const created = html(live);
  assert.ok(created.includes(t("zh", "blueprints.createdNotStarted")));
  assert.ok(created.includes("data-blueprint-created=\"true\""));
  assert.ok(created.includes("data-blueprint-apply=\"true\""));
  assert.equal(created.includes(expired), false);
  assert.equal(created.includes(applyLabel), false);
  assert.equal(live.blueprint.canApply(), false);

  live.blueprint.preview();
  await flush();
  const next = html(live);
  assert.equal(live.blueprint.getSnapshot().preview?.planId, "plan-bp-2");
  assert.equal(live.blueprint.getSnapshot().applyPlanId, "plan-bp-1");
  assert.equal(next.includes(expired), false);
  assert.ok(next.includes(applyLabel));
  const nextAt = next.lastIndexOf(applyLabel);
  assert.ok(nextAt > 0);
  assert.equal(next.slice(Math.max(0, nextAt - 180), nextAt).includes("disabled"), false);
  assert.equal(live.blueprint.canApply(), true);
  assert.equal(next.includes(t("zh", "blueprints.createdNotStarted")), false);

  live.blueprint.setDisplayName("Shown");
  const stale = html(live);
  assert.ok(stale.includes(expired));
  assert.equal(live.blueprint.canApply(), false);
  const staleAt = stale.lastIndexOf(applyLabel);
  assert.ok(staleAt > 0);
  assert.equal(stale.slice(Math.max(0, staleAt - 180), staleAt).includes("disabled"), true);
});
