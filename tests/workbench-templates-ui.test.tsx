import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
import type { Blueprint } from "../src/shared/blueprint.ts";
import { SpaceTemplatesPage, sectionForMode } from "../packages/plugin/src/workbench/templates/page.tsx";
import { detectTemplateFile } from "../packages/plugin/src/workbench/templates/detect.ts";
import { importTemplateFile } from "../packages/plugin/src/workbench/templates/import-section.tsx";
import { TemplatesError } from "../packages/plugin/src/workbench/templates/errors.tsx";
import { WorkbenchController, type WorkbenchEnv } from "../packages/plugin/src/workbench/store.ts";
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
    icon: "",
    status: "running",
    generation: 1,
    managed: true,
    dshVersion: null,
    ...partial,
  };
}

const manager = space({ id: "hub", displayName: "Hub", isHost: true });
const alpha = space({ id: "alpha", displayName: "Alpha" });
const beta = space({ id: "beta", displayName: "Beta" });

function state(): WorkbenchState {
  return {
    protocolVersion: 2,
    serviceEpoch: EPOCH,
    revision: REVISION,
    availability: "ready",
    role: "manager",
    managerId: "hub",
    owner: { kind: "web", since: "2026-09-21T00:00:00.000Z" },
    writable: true,
    mode: "verified-full",
    dshVersion: "0.1.5-rc.2",
    maintenance: false,
    reasons: [],
    spaces: [manager, alpha, beta],
    jobs: [],
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

const blueprint: Blueprint = {
  kind: "dsh-blueprint",
  formatVersion: 1,
  metadata: { name: "写作工作台", version: "1.0.0", description: "demo" },
  packages: [{ name: "@example/writing-tools", version: "2.1.0", source: { type: "npm" } }],
  profile: { base: "web", bundles: ["@example/writing-tools"], patch: [], settings: {} },
  inputs: [],
  bindings: [],
  relations: [],
};

function defaultProduct(request: WorkbenchProductRequest): WorkbenchProductResult {
  if (request.method === "blueprint.inspect") {
    return { method: "blueprint.inspect", blueprint, diagnostics: [], observation: OBSERVATION };
  }
  if (request.method === "blueprint.source") {
    return {
      method: "blueprint.source",
      spaceId: request.spaceId,
      packages: [],
      bundles: [],
      patch: { exists: false, shareable: false },
      settingsNamespaces: [],
      localObservations: [],
      host: { dsh: "0.1.5-rc.2", spaces: "0.3.1", node: "22.0.0", os: "win32", arch: "x64", base: "0.1.5-rc.2", webApp: "0.1.5-rc.2" },
      observation: OBSERVATION,
    };
  }
  throw new Error(request.method);
}

function fakeApi(product: (request: WorkbenchProductRequest) => WorkbenchProductResult): WorkbenchApi {
  return {
    state: async () => state(),
    detail: async (spaceId) => ({
      space: { id: spaceId, displayName: spaceId, isHost: false, hasWebApp: true, status: "running" },
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

function html(ctrl: WorkbenchController, initialSection?: "create" | "import" | "export"): string {
  return renderToStaticMarkup(
    React.createElement(SpaceTemplatesPage, {
      ui: ctrl.getSnapshot(),
      controller: ctrl,
      ...(initialSection ? { initialSection } : {}),
    }),
  );
}

function file(name: string, bytes: Uint8Array): File {
  return {
    name,
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

test("the page shows one section at a time and marks the open one", async () => {
  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();

  const create = html(ctrl);
  assert.ok(create.includes('data-templates="true"'));
  assert.ok(create.includes('data-templates-section="create"'));
  assert.equal(create.includes('data-templates-section="import"'), false);
  assert.equal(create.includes('data-templates-section="export"'), false);
  assert.ok(create.includes('role="tablist"'));
  assert.equal(create.split('aria-selected="true"').length - 1, 1);

  const importSection = html(ctrl, "import");
  assert.ok(importSection.includes('data-templates-section="import"'));
  assert.ok(importSection.includes('data-templates-panel="import"'));
  assert.ok(importSection.includes('data-templates-dropzone="true"'));
  assert.equal(importSection.includes('data-templates-section="create"'), false);
  assert.equal(importSection.includes('data-templates-section="export"'), false);

  const exportSection = html(ctrl, "export");
  assert.ok(exportSection.includes('data-templates-section="export"'));
  assert.ok(exportSection.includes('data-templates-panel="export"'));
  assert.ok(exportSection.includes(t("zh", "share.export")));
  assert.equal(exportSection.includes('data-templates-dropzone="true"'), false);
  assert.equal(exportSection.includes('data-templates-section="create"'), false);
});

test("a blueprint session decides the section", () => {
  assert.equal(sectionForMode("use"), "create");
  assert.equal(sectionForMode("generate"), "export");
});

test("a blueprint session in generate mode opens the export section", async () => {
  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  ctrl.blueprint.setMode("generate");
  const page = html(ctrl);
  assert.ok(page.includes('data-templates-section="export"'));
  assert.ok(page.includes(t("zh", "share.export")));
  assert.ok(page.includes(t("zh", "share.includeConfig")));
  assert.equal(page.includes('data-templates-dropzone="true"'), false);
});

test("openBlueprintGenerate lands in the export section with the space preselected", async () => {
  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  ctrl.openBlueprintGenerate("beta");
  await flush();
  const page = html(ctrl);
  assert.equal(ctrl.getSnapshot().homeTab, "blueprints");
  assert.ok(page.includes('data-blueprint-mode="generate"'));
  assert.ok(page.includes('data-templates-section="export"'));
  assert.ok(page.includes('<option value="beta" selected=""'));
  assert.equal(page.includes('data-templates-section="create"'), false);
});

test("the drop zone tells a share file, a blueprint and an unknown file apart", () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
  assert.equal(detectTemplateFile("share.dshspace", zip), "share-archive");
  assert.equal(detectTemplateFile("share.dshspace", new TextEncoder().encode("not a zip")), "share-archive");
  assert.equal(detectTemplateFile("package.json", new TextEncoder().encode('{"kind":"dsh-blueprint","formatVersion":2}')), "blueprint");
  assert.equal(detectTemplateFile("code.txt", new TextEncoder().encode("DSHBP2:abc")), "blueprint");
  assert.equal(detectTemplateFile("notes.txt", new TextEncoder().encode("just a note")), "unknown");
  assert.equal(detectTemplateFile("other.json", new TextEncoder().encode('{"hello":1}')), "unknown");
});

test("a picked file goes to the flow it belongs to, and an unknown file is reported", async () => {
  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  const previews: string[] = [];
  ctrl.previewImportArchive = (_archiveBase64, fileName) => {
    previews.push(fileName);
  };
  const errors: string[] = [];
  let ready = 0;

  await importTemplateFile(
    file("share.dshspace", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])),
    ctrl,
    "zh",
    (message) => errors.push(message),
    () => {
      ready += 1;
    },
  );
  assert.deepEqual(previews, ["share.dshspace"]);
  assert.deepEqual(errors, [] as string[]);
  assert.equal(ready, 0);

  await importTemplateFile(
    file("package.json", new TextEncoder().encode(JSON.stringify(blueprint))),
    ctrl,
    "zh",
    (message) => errors.push(message),
    () => {
      ready += 1;
    },
  );
  await flush();
  assert.deepEqual(errors, [] as string[]);
  assert.equal(ready, 1);
  assert.ok(ctrl.getSnapshot().blueprint.inspect);
  assert.equal(ctrl.getSnapshot().blueprint.mode, "use");

  await importTemplateFile(
    file("notes.txt", new TextEncoder().encode("just a note")),
    ctrl,
    "zh",
    (message) => errors.push(message),
    () => {
      ready += 1;
    },
  );
  assert.deepEqual(errors, [t("zh", "templates.drop.unknown")]);
  assert.equal(ready, 1);
});

test("a failure is visible in the first frame and carries no recovery action", async () => {
  const failure = renderToStaticMarkup(React.createElement(TemplatesError, { message: "boom" }));
  assert.ok(failure.includes('role="alert"'));
  assert.ok(failure.includes("boom"));
  assert.equal(failure.includes("opacity:0"), false);
  assert.equal(failure.includes("opacity: 0"), false);

  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  ctrl.blueprint.readFileBytes(new Uint8Array([0xff, 0xfe]), "broken.json");
  const page = html(ctrl, "import");
  assert.ok(page.includes("data-templates-error=\"true\""));
  assert.match(page, /<p class="dsh-wb-alert" role="alert" data-templates-error="true">[^<]+<\/p>/);
  assert.equal(page.includes(t("zh", "templates.drop.unknown")), false);
});
