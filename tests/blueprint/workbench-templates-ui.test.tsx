import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  WorkbenchApi,
  WorkbenchJob,
  WorkbenchSpace,
  WorkbenchState,
} from "../../src/shared/workbench.ts";
import type {
  WorkbenchProductObservation,
  WorkbenchProductRequest,
  WorkbenchProductResult,
} from "../../src/shared/workbench-product.ts";
import type { Blueprint } from "@klarkxy/dsh-blueprint/v1/types";
import { SpaceTemplatesPage, sectionForMode } from "../../packages/plugin/src/workbench/templates/page.tsx";
import { detectTemplateFile } from "../../packages/plugin/src/workbench/templates/detect.ts";
import { importTemplateFile } from "../../packages/plugin/src/workbench/templates/import-section.tsx";
import { TemplatesError } from "../../packages/plugin/src/workbench/templates/errors.tsx";
import { CreateDialog, ExportShareDialog, SaveTemplateDialog } from "../../packages/plugin/src/workbench/view/create-dialog.tsx";
import { WorkbenchController, type WorkbenchEnv } from "../../packages/plugin/src/workbench/store.ts";
import { t } from "../../packages/plugin/src/workbench/i18n.ts";

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
    dshVersion: null, startWithDesktop: false,
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
  if (request.method === "templates") {
    return {
      method: "templates",
      templates: [
        {
          id: "dev",
          name: "dev",
          displayName: "Development",
          plugins: [{ packageName: "dsh-outline", resolvedVersion: "1.2.0", source: "npm" }],
          createdAt: "2026-09-21T00:00:00.000Z",
          recipe: { schemaVersion: 1, displayName: "Development", plugins: [] },
        },
      ],
      observation: OBSERVATION,
    };
  }
  if (request.method === "base.versions") {
    return { method: "base.versions", base: request.base, versions: ["0.1.5-rc.2"], preferred: "0.1.5-rc.2", observation: OBSERVATION };
  }
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
    startupStatus: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", phase: "ready" as const, reasons: [], failure: null }),
    detail: async (spaceId) => ({
      space: { id: spaceId, displayName: spaceId, isHost: false, hasWebApp: true, status: "running" },
      models: { status: "unconfigured", routeNames: [], defaultModel: null, missingCredentials: [] },
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

test("the templates page manages saved local templates and shows an empty state when none exist", async () => {
  const emptyCtrl = controller(
    fakeApi((req) =>
      req.method === "templates"
        ? { method: "templates", templates: [], observation: OBSERVATION }
        : defaultProduct(req),
    ),
  );
  await emptyCtrl.poll();
  emptyCtrl.setHomeTab("templates");
  await flush();
  const emptyPage = html(emptyCtrl);
  assert.ok(emptyPage.includes('data-templates="true"'));
  assert.ok(emptyPage.includes('data-templates-empty="true"'));
  assert.equal(emptyPage.includes('data-blueprints="true"'), false);
  assert.equal(emptyPage.includes('data-templates-action="share-code"'), false);

  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  ctrl.setHomeTab("templates");
  await flush();
  const populated = html(ctrl);
  assert.ok(populated.includes('data-template-card="true"'));
  assert.ok(populated.includes('data-template-use="dev"'));
  assert.ok(populated.includes('data-template-delete="dev"'));
  assert.ok(populated.includes("Development"));
  assert.ok(populated.includes("dsh-outline"));
});

test("a blueprint session decides the section", () => {
  assert.equal(sectionForMode("use"), "create");
  assert.equal(sectionForMode("generate"), "export");
});

test("the create dialog switches cleanly across blank, template and file import modes", async () => {
  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  await ctrl.loadTemplates();

  const renderCreate = (mode: "blank" | "template" | "import", templateId?: string) =>
    renderToStaticMarkup(
      React.createElement(CreateDialog, {
        ui: ctrl.getSnapshot(),
        controller: ctrl,
        initialMode: mode,
        initialTemplateId: templateId,
        error: null,
      }),
    );

  const blank = renderCreate("blank");
  assert.ok(blank.includes('data-create-mode="blank"'));
  assert.ok(blank.includes('role="tablist"'));
  assert.equal(blank.split('aria-selected="true"').length - 1, 1);
  assert.equal(blank.includes('data-templates-dropzone="true"'), false);

  const fromTemplate = renderCreate("template", "dev");
  assert.ok(fromTemplate.includes('data-create-mode="template"'));
  assert.ok(fromTemplate.includes('data-create-template-select="true"'));
  assert.ok(fromTemplate.includes("Development"));
  assert.ok(fromTemplate.includes(t("zh", "templates.createConfirm")));

  const fromFile = renderCreate("import");
  assert.ok(fromFile.includes('data-create-mode="import"'));
  assert.ok(fromFile.includes('data-templates-dropzone="true"'));
  assert.ok(fromFile.includes(t("zh", "templates.drop.hint")));
  assert.ok(fromFile.includes('accept=".dshspace,application/zip"'));
});

test("save-template and export-share dialogs preselect the target space and hide sealed blueprint actions", async () => {
  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  ctrl.openSaveTemplate("beta");
  const saveHtml = renderToStaticMarkup(
    React.createElement(SaveTemplateDialog, {
      ui: ctrl.getSnapshot(),
      controller: ctrl,
      spaceId: "beta",
      error: null,
    }),
  );
  assert.ok(saveHtml.includes('data-save-template-dialog="true"'));
  assert.ok(saveHtml.includes("Beta"));
  assert.ok(!saveHtml.includes(`aria-label="${t("zh", "create.displayName")}"`), "saving a local template only asks for a single template name");

  ctrl.openExportShare("beta");
  const exportHtml = renderToStaticMarkup(
    React.createElement(ExportShareDialog, {
      ui: ctrl.getSnapshot(),
      controller: ctrl,
      spaceId: "beta",
      error: null,
    }),
  );
  assert.ok(exportHtml.includes('data-export-share-dialog="true"'));
  assert.ok(exportHtml.includes("Beta"));
  assert.ok(exportHtml.includes(t("zh", "share.includeConfig")));
  assert.ok(exportHtml.includes(t("zh", "share.export")));
  assert.equal(exportHtml.includes('data-templates-action="share-code"'), false);
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
  assert.deepEqual(errors, [t("zh", "templates.drop.unknown")]);
  assert.equal(ready, 0);
  assert.equal(ctrl.getSnapshot().blueprint.inspect, null);

  await importTemplateFile(
    file("notes.txt", new TextEncoder().encode("just a note")),
    ctrl,
    "zh",
    (message) => errors.push(message),
    () => {
      ready += 1;
    },
  );
  assert.deepEqual(errors, [t("zh", "templates.drop.unknown"), t("zh", "templates.drop.unknown")]);
  assert.equal(ready, 0);
});

test("a failure is visible in the first frame and carries no recovery action", async () => {
  const failure = renderToStaticMarkup(React.createElement(TemplatesError, { message: "boom" }));
  assert.ok(failure.includes('role="alert"'));
  assert.ok(failure.includes("boom"));
  assert.equal(failure.includes("opacity:0"), false);
  assert.equal(failure.includes("opacity: 0"), false);

  const ctrl = controller(fakeApi(defaultProduct));
  await ctrl.poll();
  const page = html(ctrl, "import");
  assert.equal(page.includes('data-templates-paste="true"'), false);
  assert.equal(page.includes(t("zh", "blueprints.paste")), false);
});
