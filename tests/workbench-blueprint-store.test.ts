import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Blueprint } from "../src/shared/blueprint.ts";
import type {
  WorkbenchApi,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchSpace,
  WorkbenchState,
} from "../src/shared/workbench.ts";
import type {
  WorkbenchProductObservation,
  WorkbenchProductRequest,
  WorkbenchProductResult,
} from "../src/shared/workbench-product.ts";
import type {
  WorkbenchBlueprintApplyOutcome,
  WorkbenchBlueprintGeneratePayload,
  WorkbenchBlueprintInspectPayload,
  WorkbenchBlueprintPreviewPayload,
  WorkbenchBlueprintSourcePayload,
} from "../src/shared/workbench-blueprint.ts";
import {
  WorkbenchController,
  type WorkbenchEnv,
} from "../packages/plugin/src/workbench/store.ts";
import { utf8ToBase64 } from "../packages/plugin/src/workbench/blueprint-session.ts";
import { t } from "../packages/plugin/src/workbench/i18n.ts";
import { persistLooksSafe, readPersist, WORKBENCH_STORAGE_KEY } from "../packages/plugin/src/workbench/persistence.ts";

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

const EPOCH = "aa".repeat(32);
const REVISION = "bb".repeat(32);
const REVISION_NEXT = "cc".repeat(32);
const OBSERVATION: WorkbenchProductObservation = { serviceEpoch: EPOCH, expectedRevision: REVISION };
const OBSERVATION_NEXT: WorkbenchProductObservation = { serviceEpoch: EPOCH, expectedRevision: REVISION_NEXT };

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
const web = space({ id: "web", displayName: "Web" });

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
    packages: [
      { name: "@example/writing-tools", version: "2.1.0", source: { type: "npm" } },
    ],
    profile: {
      base: "web",
      bundles: ["@example/writing-tools"],
      patch: [{ id: "example-writing-tools", config: { outputDirectory: null } }],
      settings: { "example-writing-preferences": { fontSize: 18 } },
    },
    inputs: [
      { id: "output-directory", type: "directory", label: "Dir", required: true },
      { id: "title", type: "string", label: "Title", required: false },
      { id: "count", type: "number", label: "Count", required: false },
      { id: "flag", type: "boolean", label: "Flag", required: false },
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

function inspectResult(blueprint = sampleBlueprint()): WorkbenchBlueprintInspectPayload & { observation: WorkbenchProductObservation } {
  return { method: "blueprint.inspect", blueprint, diagnostics: [], observation: OBSERVATION };
}

function previewResult(
  partial: Partial<WorkbenchBlueprintPreviewPayload> = {},
): WorkbenchBlueprintPreviewPayload & { observation: WorkbenchProductObservation } {
  const blueprint = partial.blueprint ?? sampleBlueprint();
  return {
    method: "blueprint.preview",
    blueprint,
    packages: [
      { name: "@example/writing-tools", version: "2.1.0", source: "npm", bundled: true, order: 0 },
    ],
    inputs: [
      { id: "output-directory", type: "directory", origin: "explicit", value: "/tmp/out" },
      { id: "count", type: "number", origin: "explicit", value: 0 },
      { id: "flag", type: "boolean", origin: "explicit", value: false },
      { id: "title", type: "string", origin: "explicit", value: "" },
    ],
    host,
    planId: "plan-bp-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    diagnostics: [],
    missingInputs: [],
    observation: OBSERVATION,
    ...partial,
  };
}

function sourceResult(): WorkbenchBlueprintSourcePayload & { observation: WorkbenchProductObservation } {
  return {
    method: "blueprint.source",
    spaceId: "alpha",
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
      {
        name: "@example/local-only",
        version: "1.0.0",
        source: "local",
        inBundles: false,
        hasBundlePatch: false,
        eligibility: { available: false, reason: "local source" },
        lifecycleScripts: [],
      },
    ],
    bundles: [{ name: "@example/writing-tools", order: 0, eligible: true }],
    patch: { exists: true, shareable: true },
    settingsNamespaces: [
      { namespace: "keep-a", eligible: true, shareable: true, convertible: true },
      { namespace: "skip-b", eligible: true, shareable: true, convertible: true },
      { namespace: "keep-c", eligible: true, shareable: true, convertible: true },
      { namespace: "forbidden", eligible: false, shareable: false, convertible: false, reason: "managed" },
    ],
    localObservations: [
      { pointer: "/profile/patch/0/config/outputDirectory", kind: "directory", reason: "local directory" },
    ],
    host,
    observation: OBSERVATION,
  };
}

function mixedObservationSource(): WorkbenchBlueprintSourcePayload & { observation: WorkbenchProductObservation } {
  return {
    ...sourceResult(),
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
}

function managedOnlySource(): WorkbenchBlueprintSourcePayload & { observation: WorkbenchProductObservation } {
  return {
    ...sourceResult(),
    localObservations: [
      { pointer: "/profile/patch/0", kind: "managed", reason: "Owned isolation fields were omitted." },
      { pointer: "/profile/patch/1", kind: "managed", reason: "Owned isolation fields were omitted." },
      { pointer: "/profile/patch/2", kind: "managed", reason: "Owned isolation fields were omitted." },
      { pointer: "/profile/patch/3", kind: "managed", reason: "Owned isolation fields were omitted." },
    ],
  };
}

function generateResult(): WorkbenchBlueprintGeneratePayload & { observation: WorkbenchProductObservation } {
  const blueprint = sampleBlueprint();
  const json = JSON.stringify(blueprint);
  return {
    method: "blueprint.generate",
    fileName: "writing.dsh-blueprint.json",
    json,
    shareCode: `DSHBP1:J:${utf8ToBase64(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`,
    blueprint,
    diagnostics: [],
    observation: OBSERVATION,
  };
}

function applyOutcome(): WorkbenchBlueprintApplyOutcome {
  return {
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
}

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

type ProductHandler = (request: WorkbenchProductRequest) => Promise<WorkbenchProductResult> | WorkbenchProductResult;

function fakeApi(
  calls: Call[],
  product: ProductHandler,
  submitImpl?: WorkbenchApi["submit"],
  stateFn?: () => WorkbenchState,
): WorkbenchApi {
  return {
    state: async () => (stateFn ? stateFn() : state()),
    detail: async (spaceId) => ({
      space: { id: spaceId, displayName: spaceId, isHost: false, hasWebApp: true, status: "running", isolation: "verified" },
      plugins: [],
      snapshots: [],
      diagnostics: [],
    }),
    submit: async (command, requestId, context) => {
      calls.push({ method: "submit", arg: command, context });
      if (submitImpl) return submitImpl(command, requestId, context);
      return job({ kind: command.kind, requestId, id: requestId });
    },
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
    product: async (request) => {
      calls.push({ method: "product", arg: request });
      return product(request);
    },
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

function controller(api: WorkbenchApi, extra: Partial<WorkbenchEnv> = {}): WorkbenchController {
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
    ...extra,
  });
  controllers.push(instance);
  return instance;
}

async function ready(ctrl: WorkbenchController): Promise<void> {
  await ctrl.poll();
  await flush();
}

type Call = { method: string; arg?: WorkbenchProductRequest | WorkbenchCommand; context?: unknown };

function productArg(value: Call["arg"]): WorkbenchProductRequest | undefined {
  if (value && "method" in value) return value;
  return undefined;
}

function productRequest(calls: Call[], method: WorkbenchProductRequest["method"]): WorkbenchProductRequest | undefined {
  for (const item of calls) {
    if (item.method !== "product") continue;
    const arg = productArg(item.arg);
    if (arg?.method === method) return arg;
  }
  return undefined;
}

test("stale inspect response is ignored after content change, mode change, and stop", async () => {
  const first = deferred<WorkbenchProductResult>();
  const second = deferred<WorkbenchProductResult>();
  let inspectCalls = 0;
  const calls: Call[] = [];
  const ctrl = controller(
    fakeApi(calls, async (request) => {
      if (request.method === "blueprint.inspect") {
        inspectCalls += 1;
        return inspectCalls === 1 ? first.promise : second.promise;
      }
      throw new Error(request.method);
    }),
  );
  await ready(ctrl);
  ctrl.blueprint.setContent("{ \"a\": 1 }");
  ctrl.blueprint.inspect();
  ctrl.blueprint.setContent("{ \"a\": 2 }");
  first.resolve(inspectResult(sampleBlueprint({ metadata: { name: "stale", version: "1.0.0" } })));
  await flush();
  assert.equal(ctrl.blueprint.getSnapshot().inspect, null);

  ctrl.blueprint.inspect();
  ctrl.blueprint.setMode("generate");
  second.resolve(inspectResult(sampleBlueprint({ metadata: { name: "mode-stale", version: "1.0.0" } })));
  await flush();
  assert.equal(ctrl.blueprint.getSnapshot().inspect, null);

  const third = deferred<WorkbenchProductResult>();
  const stopped = controller(
    fakeApi([], async (request) => {
      if (request.method === "blueprint.inspect") return third.promise;
      throw new Error(request.method);
    }),
  );
  await ready(stopped);
  stopped.blueprint.setContent("{}");
  stopped.blueprint.inspect();
  stopped.stop();
  third.resolve(inspectResult());
  await flush();
  assert.equal(stopped.blueprint.getSnapshot().inspect, null);
});

test("stale preview and generate responses do not overwrite newer edits", async () => {
  const previewHold = deferred<WorkbenchProductResult>();
  const generateHold = deferred<WorkbenchProductResult>();
  const ctrl = controller(
    fakeApi([], async (request) => {
      if (request.method === "blueprint.inspect") return inspectResult();
      if (request.method === "blueprint.preview") return previewHold.promise;
      if (request.method === "blueprint.source") return sourceResult();
      if (request.method === "blueprint.generate") return generateHold.promise;
      throw new Error(request.method);
    }),
  );
  await ready(ctrl);
  ctrl.blueprint.setContent("{}");
  ctrl.blueprint.inspect();
  await flush();
  ctrl.blueprint.setName("demo-space");
  ctrl.blueprint.preview();
  ctrl.blueprint.setName("demo-space-2");
  previewHold.resolve(previewResult());
  await flush();
  assert.equal(ctrl.blueprint.getSnapshot().preview, null);
  assert.equal(ctrl.blueprint.getSnapshot().previewInvalid, true);

  ctrl.blueprint.setMode("generate");
  ctrl.blueprint.setSourceSpaceId("alpha");
  await flush();
  ctrl.blueprint.setMetaName("One");
  ctrl.blueprint.generate();
  ctrl.blueprint.setMetaName("Two");
  generateHold.resolve(generateResult());
  await flush();
  assert.equal(ctrl.blueprint.getSnapshot().generate, null);
  assert.equal(ctrl.blueprint.getSnapshot().generateInvalid, true);
});

test("duplicate apply is ignored and preview observation is sent, not the latest revision", async () => {
  const calls: Call[] = [];
  const hold = deferred<WorkbenchJob>();
  let current = state();
  const ctrl = controller(
    fakeApi(
      calls,
      async (request) => {
        if (request.method === "blueprint.inspect") return inspectResult();
        if (request.method === "blueprint.preview") {
          return { ...previewResult(), observation: OBSERVATION };
        }
        throw new Error(request.method);
      },
      async (command, requestId, context) => {
        calls.push({ method: "submit-inner", arg: command, context });
        return hold.promise.then(() =>
          job({
            kind: command.kind,
            requestId,
            id: "apply-1",
            result: { product: applyOutcome(), spaceId: "from-blueprint" },
          }),
        );
      },
      () => current,
    ),
  );
  await ready(ctrl);
  ctrl.blueprint.setContent("{}");
  ctrl.blueprint.inspect();
  await flush();
  ctrl.blueprint.setName("from-blueprint");
  ctrl.blueprint.setStringInput("output-directory", "/tmp/out");
  ctrl.blueprint.preview();
  await flush();
  current = state({ revision: REVISION_NEXT });
  await ctrl.poll();
  assert.equal(ctrl.getSnapshot().state?.revision, REVISION_NEXT);
  ctrl.blueprint.apply();
  ctrl.blueprint.apply();
  await flush();
  const submits = calls.filter((item) => item.method === "submit");
  assert.equal(submits.length, 1);
  assert.deepEqual(submits[0]?.arg, { kind: "blueprint.apply", planId: "plan-bp-1" });
  assert.deepEqual(submits[0]?.context, OBSERVATION);
  assert.notDeepEqual(submits[0]?.context, OBSERVATION_NEXT);
  hold.resolve(
    job({
      kind: "blueprint.apply",
      requestId: "uuid-1",
      id: "apply-1",
      result: { product: applyOutcome(), spaceId: "from-blueprint" },
    }),
  );
  await flush();
});

test("missing, 0, false and empty string are sent distinctly on preview", async () => {
  const calls: Call[] = [];
  const ctrl = controller(
    fakeApi(calls, async (request) => {
      if (request.method === "blueprint.inspect") return inspectResult();
      if (request.method === "blueprint.preview") return previewResult();
      throw new Error(request.method);
    }),
  );
  await ready(ctrl);
  ctrl.blueprint.setContent("{}");
  ctrl.blueprint.inspect();
  await flush();
  ctrl.blueprint.setName("from-blueprint");
  ctrl.blueprint.setStringInput("title", "");
  ctrl.blueprint.setStringInput("count", "0");
  ctrl.blueprint.setBooleanInput("flag", false);
  ctrl.blueprint.unsetInput("output-directory");
  ctrl.blueprint.preview();
  await flush();
  const request = productRequest(calls, "blueprint.preview");
  assert.ok(request);
  assert.equal(request.method, "blueprint.preview");
  if (request.method !== "blueprint.preview") return;
  assert.equal(request.values.title, "");
  assert.equal(request.values.count, 0);
  assert.equal(request.values.flag, false);
  assert.equal("output-directory" in request.values, false);
});

test("imported file strict UTF-8/BOM errors keep invalid contents", async () => {
  const ctrl = controller(fakeApi([], async () => inspectResult()));
  await ready(ctrl);
  ctrl.blueprint.setContent("keep-me");
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  ctrl.blueprint.readFileBytes(bom, "x.json");
  const bomState = ctrl.blueprint.getSnapshot();
  assert.equal(bomState.contentError, t("zh", "blueprints.bom"));
  assert.equal(bomState.content, "\uFEFF{}");
  assert.equal(bomState.inspect, null);
  ctrl.blueprint.setContent("keep-me");
  ctrl.blueprint.readFileBytes(new Uint8Array([0xff, 0x80]), "bad.json");
  const utf8State = ctrl.blueprint.getSnapshot();
  assert.equal(utf8State.contentError, t("zh", "blueprints.utf8"));
  assert.equal(utf8State.content, "keep-me");
});

test("expired preview blocks apply; cancel clears staged UI only", async () => {
  const ctrl = controller(
    fakeApi([], async (request) => {
      if (request.method === "blueprint.inspect") return inspectResult();
      if (request.method === "blueprint.preview") {
        return previewResult({ expiresAt: "2020-01-01T00:00:00.000Z" });
      }
      throw new Error(request.method);
    }),
    { now: () => Date.parse("2026-09-21T00:00:00.000Z") },
  );
  await ready(ctrl);
  ctrl.blueprint.setContent("{}");
  ctrl.blueprint.inspect();
  await flush();
  ctrl.blueprint.setName("from-blueprint");
  ctrl.blueprint.setStringInput("output-directory", "/tmp/out");
  ctrl.blueprint.preview();
  await flush();
  assert.equal(ctrl.blueprint.canApply(), false);
  ctrl.blueprint.apply();
  assert.equal(ctrl.blueprint.getSnapshot().applyStatus, "idle");
  assert.equal(ctrl.blueprint.getSnapshot().applyError, t("zh", "blueprints.previewExpired"));
  const content = ctrl.blueprint.getSnapshot().content;
  ctrl.blueprint.cancelStaged();
  assert.equal(ctrl.blueprint.getSnapshot().preview, null);
  assert.equal(ctrl.blueprint.getSnapshot().content, content);
  assert.ok(ctrl.blueprint.getSnapshot().inspect);
});

test("successful apply does not start or enter the space", async () => {
  const calls: Call[] = [];
  const ctrl = controller(
    fakeApi(
      calls,
      async (request) => {
        if (request.method === "blueprint.inspect") return inspectResult();
        if (request.method === "blueprint.preview") return previewResult();
        throw new Error(request.method);
      },
      async (command, requestId) =>
        job({
          kind: command.kind,
          requestId,
          id: "apply-1",
          status: "succeeded",
          result: { product: applyOutcome(), spaceId: "from-blueprint" },
        }),
    ),
  );
  await ready(ctrl);
  ctrl.blueprint.setContent("{}");
  ctrl.blueprint.inspect();
  await flush();
  ctrl.blueprint.setName("from-blueprint");
  ctrl.blueprint.setStringInput("output-directory", "/tmp/out");
  ctrl.blueprint.preview();
  await flush();
  ctrl.blueprint.apply();
  await flush();
  const kinds = calls
    .filter((item) => item.method === "submit")
    .map((item) => (item.arg && "kind" in item.arg ? item.arg.kind : undefined));
  assert.deepEqual(kinds, ["blueprint.apply"]);
  assert.equal(ctrl.getSnapshot().createdNotice, null);
  assert.equal(ctrl.getSnapshot().selected, "home");
  assert.equal(ctrl.blueprint.getSnapshot().applyStatus, "succeeded");
  assert.equal(ctrl.blueprint.getSnapshot().applyOutcome?.stages.start.status, "not-run");
  assert.equal(ctrl.blueprint.getSnapshot().previewInvalid, false);
  assert.equal(ctrl.blueprint.getSnapshot().preview?.planId, "plan-bp-1");
  assert.equal(ctrl.blueprint.getSnapshot().applyPlanId, "plan-bp-1");
  assert.equal(ctrl.blueprint.canApply(), false);
});

test("generate sends the selected settings namespaces exactly", async () => {
  const calls: Call[] = [];
  const ctrl = controller(
    fakeApi(calls, async (request) => {
      if (request.method === "blueprint.source") return sourceResult();
      if (request.method === "blueprint.generate") return generateResult();
      throw new Error(request.method);
    }),
  );
  await ready(ctrl);
  ctrl.openBlueprintGenerate("alpha");
  await flush();
  ctrl.blueprint.setNamespaceSelected("skip-b", false);
  ctrl.blueprint.setMetaName("写作工作台");
  ctrl.blueprint.setMetaVersion("1.0.0");
  ctrl.blueprint.generate();
  await flush();
  const request = productRequest(calls, "blueprint.generate");
  assert.ok(request);
  assert.equal(request.method, "blueprint.generate");
  if (request.method !== "blueprint.generate") return;
  assert.deepEqual(request.selection.settingsNamespaces, ["keep-a", "keep-c"]);
  assert.equal(request.selection.settingsNamespaces.includes("skip-b"), false);
  assert.equal(request.selection.settingsNamespaces.includes("forbidden"), false);
  assert.deepEqual(request.selection.packages, ["@example/writing-tools"]);
});

test("copy and download use UTF-8 bytes and surface clipboard errors", async () => {
  const downloads: Array<{ fileName: string; archiveBase64: string }> = [];
  let clipboard: string | null = null;
  const ctrl = controller(
    fakeApi([], async (request) => {
      if (request.method === "blueprint.source") return sourceResult();
      if (request.method === "blueprint.generate") return generateResult();
      throw new Error(request.method);
    }),
    {
      downloadFile: (fileName, archiveBase64) => {
        downloads.push({ fileName, archiveBase64 });
      },
      writeClipboard: async (text) => {
        clipboard = text;
      },
    },
  );
  await ready(ctrl);
  ctrl.openBlueprintGenerate("alpha");
  await flush();
  ctrl.blueprint.setMetaName("写作工作台");
  ctrl.blueprint.generate();
  await flush();
  ctrl.blueprint.copyShareCode();
  await flush();
  ctrl.blueprint.saveJson();
  const generated = generateResult();
  assert.equal(clipboard, generated.shareCode);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0]?.fileName, generated.fileName);
  assert.equal(Buffer.from(downloads[0]?.archiveBase64 ?? "", "base64").toString("utf8"), generated.json);

  const failing = controller(
    fakeApi([], async (request) => {
      if (request.method === "blueprint.source") return sourceResult();
      if (request.method === "blueprint.generate") return generateResult();
      throw new Error(request.method);
    }),
    {
      writeClipboard: async () => {
        throw new Error("denied");
      },
    },
  );
  await ready(failing);
  failing.openBlueprintGenerate("alpha");
  await flush();
  failing.blueprint.setMetaName("写作工作台");
  failing.blueprint.generate();
  await flush();
  failing.blueprint.copyShareCode();
  await flush();
  assert.equal(failing.blueprint.getSnapshot().copied, false);
  assert.equal(failing.blueprint.getSnapshot().copyError, t("zh", "blueprints.copyFailed"));
});

test("manager and web are not blueprint sources; contents are not persisted", async () => {
  const calls: Call[] = [];
  const storage = memoryStorage();
  const ctrl = controller(
    fakeApi(calls, async (request) => {
      if (request.method === "blueprint.source") return sourceResult();
      throw new Error(request.method);
    }),
    { storage },
  );
  await ready(ctrl);
  ctrl.openBlueprintGenerate("hub");
  assert.equal(ctrl.getSnapshot().homeTab, "overview");
  ctrl.openBlueprintGenerate("web");
  assert.equal(ctrl.blueprint.getSnapshot().sourceSpaceId, "");
  ctrl.blueprint.setContent("secret-path");
  ctrl.setLocale("en");
  const raw = storage.getItem(WORKBENCH_STORAGE_KEY);
  assert.equal(persistLooksSafe(raw), true);
  assert.ok(raw && !raw.includes("secret-path"));
  assert.deepEqual(readPersist(storage), { selectedId: "__home__", locale: "en", theme: "system" });
});

test("enabling a detected directory observation sends bindingOverrides", async () => {
  const calls: Call[] = [];
  const ctrl = controller(
    fakeApi(calls, async (request) => {
      if (request.method === "blueprint.source") return sourceResult();
      if (request.method === "blueprint.generate") return generateResult();
      throw new Error(request.method);
    }),
  );
  await ready(ctrl);
  ctrl.openBlueprintGenerate("alpha");
  await flush();
  ctrl.blueprint.setBinding(0, { enabled: true });
  ctrl.blueprint.setMetaName("writing-lab");
  ctrl.blueprint.setMetaVersion("1.0.0");
  ctrl.blueprint.generate();
  await flush();
  const request = productRequest(calls, "blueprint.generate");
  assert.ok(request);
  assert.equal(request.method, "blueprint.generate");
  if (request.method !== "blueprint.generate") return;
  assert.ok(request.bindingOverrides);
  assert.equal(request.bindingOverrides.length, 1);
  assert.equal(request.bindingOverrides[0]?.pointer, "/profile/patch/0/config/outputDirectory");
  assert.equal(request.bindingOverrides[0]?.input.type, "directory");
  assert.equal(request.bindingOverrides[0]?.input.id, "outputdirectory");
});

test("managed, dynamic, and model observations do not become conversion drafts", async () => {
  const ctrl = controller(
    fakeApi([], async (request) => {
      if (request.method === "blueprint.source") return mixedObservationSource();
      throw new Error(request.method);
    }),
  );
  await ready(ctrl);
  ctrl.openBlueprintGenerate("alpha");
  await flush();
  const bindings = ctrl.blueprint.getSnapshot().bindings;
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]?.pointer, "/profile/patch/0/config/outputDirectory");
  assert.equal(bindings[0]?.type, "directory");
  assert.equal(bindings[0]?.detected, true);
  assert.equal(bindings[0]?.enabled, false);
  assert.equal(
    bindings.some((row) => row.pointer === "/profile/patch/0" || row.pointer === "/profile/settings/llm-pi-ai"),
    false,
  );
});

test("managed-only isolation observations create no conversion drafts", async () => {
  const ctrl = controller(
    fakeApi([], async (request) => {
      if (request.method === "blueprint.source") return managedOnlySource();
      throw new Error(request.method);
    }),
  );
  await ready(ctrl);
  ctrl.openBlueprintGenerate("alpha");
  await flush();
  assert.deepEqual(ctrl.blueprint.getSnapshot().bindings, []);
});

test("changing name or inputs after preview invalidates apply", async () => {
  const ctrl = controller(
    fakeApi([], async (request) => {
      if (request.method === "blueprint.inspect") return inspectResult();
      if (request.method === "blueprint.preview") return previewResult();
      throw new Error(request.method);
    }),
  );
  await ready(ctrl);
  ctrl.blueprint.setContent("{}");
  ctrl.blueprint.inspect();
  await flush();
  ctrl.blueprint.setName("from-blueprint");
  ctrl.blueprint.setStringInput("output-directory", "/tmp/out");
  ctrl.blueprint.preview();
  await flush();
  assert.equal(ctrl.blueprint.canApply(), true);
  ctrl.blueprint.setStringInput("title", "x");
  assert.equal(ctrl.blueprint.getSnapshot().previewInvalid, true);
  assert.equal(ctrl.blueprint.canApply(), false);
  ctrl.blueprint.preview();
  await flush();
  assert.equal(ctrl.blueprint.canApply(), true);
  ctrl.blueprint.setDisplayName("Shown");
  assert.equal(ctrl.blueprint.canApply(), false);
});

test("consumed current plan stays settled; a new plan is valid; unsent stale stays disabled", async () => {
  let previews = 0;
  const calls: Call[] = [];
  const ctrl = controller(
    fakeApi(
      calls,
      async (request) => {
        if (request.method === "blueprint.inspect") return inspectResult();
        if (request.method === "blueprint.preview") {
          previews += 1;
          return previewResult({ planId: `plan-bp-${previews}` });
        }
        throw new Error(request.method);
      },
      async (command, requestId) =>
        job({
          kind: command.kind,
          requestId,
          id: "apply-1",
          status: "succeeded",
          result: { product: applyOutcome(), spaceId: "from-blueprint" },
        }),
    ),
  );
  await ready(ctrl);
  ctrl.blueprint.setContent("{}");
  ctrl.blueprint.inspect();
  await flush();
  ctrl.blueprint.setName("from-blueprint");
  ctrl.blueprint.setStringInput("output-directory", "/tmp/out");
  ctrl.blueprint.preview();
  await flush();
  ctrl.blueprint.apply();
  await flush();
  const consumed = ctrl.blueprint.getSnapshot();
  assert.equal(consumed.applyStatus, "succeeded");
  assert.equal(consumed.applyPlanId, "plan-bp-1");
  assert.equal(consumed.applyJobId, "apply-1");
  assert.equal(consumed.preview?.planId, "plan-bp-1");
  assert.equal(consumed.previewInvalid, false);
  assert.equal(ctrl.blueprint.canApply(), false);
  const submitsAfterSuccess = calls.filter((item) => item.method === "submit").length;
  ctrl.blueprint.apply();
  await flush();
  assert.equal(calls.filter((item) => item.method === "submit").length, submitsAfterSuccess);

  ctrl.blueprint.preview();
  await flush();
  const next = ctrl.blueprint.getSnapshot();
  assert.equal(next.preview?.planId, "plan-bp-2");
  assert.equal(next.applyPlanId, "plan-bp-1");
  assert.equal(next.applyStatus, "succeeded");
  assert.equal(next.previewInvalid, false);
  assert.equal(ctrl.blueprint.canApply(), true);

  ctrl.blueprint.setStringInput("title", "later");
  assert.equal(ctrl.blueprint.getSnapshot().previewInvalid, true);
  assert.equal(ctrl.blueprint.getSnapshot().previewError, t("zh", "blueprints.previewExpired"));
  assert.equal(ctrl.blueprint.canApply(), false);
});

test("failed apply keeps four stages including not-run start and does not retry", async () => {
  const failed: WorkbenchBlueprintApplyOutcome = {
    kind: "blueprint.apply",
    spaceId: "partial",
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
  const calls: Call[] = [];
  const ctrl = controller(
    fakeApi(
      calls,
      async (request) => {
        if (request.method === "blueprint.inspect") return inspectResult();
        if (request.method === "blueprint.preview") return previewResult();
        throw new Error(request.method);
      },
      async (command, requestId) =>
        job({
          kind: command.kind,
          requestId,
          id: "apply-fail",
          status: "failed",
          message: "install failed",
          error: { code: "workbench/failed", message: "install failed" },
          result: { product: failed, spaceId: "partial" },
        }),
    ),
  );
  await ready(ctrl);
  ctrl.blueprint.setContent("{}");
  ctrl.blueprint.inspect();
  await flush();
  ctrl.blueprint.setName("from-blueprint");
  ctrl.blueprint.setStringInput("output-directory", "/tmp/out");
  ctrl.blueprint.preview();
  await flush();
  ctrl.blueprint.apply();
  await flush();
  const outcome = ctrl.blueprint.getSnapshot().applyOutcome;
  assert.equal(ctrl.blueprint.getSnapshot().applyStatus, "failed");
  assert.ok(outcome);
  assert.equal(outcome.stages["space-create"].status, "succeeded");
  assert.equal(outcome.stages.packages.status, "failed");
  assert.equal(outcome.stages.presets.status, "not-run");
  assert.equal(outcome.stages.start.status, "not-run");
  assert.equal(ctrl.getSnapshot().createdNotice, null);
  assert.equal(ctrl.blueprint.canApply(), false);
  const submits = calls.filter((item) => item.method === "submit").length;
  ctrl.blueprint.apply();
  await flush();
  assert.equal(calls.filter((item) => item.method === "submit").length, submits);
  assert.equal(ctrl.blueprint.getSnapshot().applyStatus, "failed");
});
