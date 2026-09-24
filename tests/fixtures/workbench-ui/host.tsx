import React from "react";
import { createRoot } from "react-dom/client";
import type {
  WorkbenchApi,
  WorkbenchJob,
  WorkbenchSpace,
  WorkbenchState,
  WorkbenchView,
} from "../../../src/shared/workbench";
import type { WorkbenchProductRequest, WorkbenchProductResult } from "../../../src/shared/workbench-product";
import type { SpaceSharePreview } from "../../../src/shared/space-share";
import type { Blueprint } from "../../../src/shared/blueprint";
import { WorkbenchApp } from "../../../packages/plugin/src/workbench/app";

declare global {
  interface Window {
    __WB?: { supervisor: string; child: string };
    __iframe?: Element | null;
    __WB_CALLS?: Array<{ method: string; arg?: unknown }>;
    __WB_DOWNLOADS?: Array<{ fileName: string }>;
  }
}

const EPOCH = "aa".repeat(32);
const REVISION = "bb".repeat(32);
const OBSERVATION = { serviceEpoch: EPOCH, expectedRevision: REVISION };

function space(id: string, displayName: string): WorkbenchSpace {
  return {
    id,
    displayName,
    isHost: false,
    hasWebApp: true,
    isolation: "verified",
    icon: "",
    status: "running",
    generation: 1,
    managed: true,
    needsIsolation: false,
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
          version: null,
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
        logs: [{ at: "2026-09-12T00:00:00.000Z", channel: "stderr", text: "redacted" }],
        backups: [],
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
  const emptyBlueprint: Blueprint = {
    kind: "dsh-blueprint",
    formatVersion: 1,
    metadata: { name: "空白 Web 工作台", version: "1.0.0" },
    packages: [],
    profile: { base: "web", bundles: [], patch: [], settings: {} },
    inputs: [],
    bindings: [],
    relations: [],
  };
  if (request.method === "blueprint.inspect") {
    return { method: "blueprint.inspect", blueprint: emptyBlueprint, diagnostics: [], observation: OBSERVATION };
  }
  if (request.method === "blueprint.preview") {
    return {
      method: "blueprint.preview",
      blueprint: emptyBlueprint,
      packages: [],
      inputs: [],
      host: {
        dsh: "0.1.5-rc.2",
        spaces: "0.3.1",
        node: "22.0.0",
        os: "win32",
        arch: "x64",
        base: "0.1.5-rc.2",
        webApp: "0.1.5-rc.2",
      },
      planId: "plan-blueprint-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      diagnostics: [],
      missingInputs: [],
      observation: OBSERVATION,
    };
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
      host: {
        dsh: "0.1.5-rc.2",
        spaces: "0.3.1",
        node: "22.0.0",
        os: "win32",
        arch: "x64",
        base: "0.1.5-rc.2",
        webApp: "0.1.5-rc.2",
      },
      observation: OBSERVATION,
    };
  }
  if (request.method === "blueprint.generate") {
    return {
      method: "blueprint.generate",
      fileName: "demo.dsh-blueprint.json",
      json: JSON.stringify(emptyBlueprint),
      shareCode: "DSHBP1:J:e30",
      blueprint: emptyBlueprint,
      diagnostics: [],
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

function makeApi(supervisor: string, child: string): WorkbenchApi {
  const spaces: WorkbenchSpace[] = [
    {
      id: "hub",
      displayName: "Hub",
      isHost: true,
      hasWebApp: true,
      isolation: "verified",
      icon: "",
      status: "running",
      generation: 1,
      managed: true,
      needsIsolation: false,
    },
    space("alpha", "Alpha"),
    space("beta", "Beta"),
  ];
  const state: WorkbenchState = {
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
    spaces,
    jobs: [],
  };
  const view = (spaceId: string): WorkbenchView => ({
    serviceEpoch: EPOCH,
    spaceId,
    generation: 1,
    origin: child,
    entryOrigin: supervisor,
    entryPath: `/view/${spaceId}`,
    channel: `ch-${spaceId}-1`,
  });
  const job = (kind: string, requestId: string): WorkbenchJob => ({
    id: requestId,
    requestId,
    kind,
    status: "succeeded",
    phase: "done",
    message: "ok",
    affectedSpaceIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canCancel: false,
  });
  const calls = (window.__WB_CALLS ??= []);
  return {
    state: async () => state,
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
    submit: async (command, requestId) => {
      calls.push({ method: "submit", arg: command });
      return job(command.kind, requestId);
    },
    job: async (id) => job("job", id),
    cancel: async (id) => job("cancel", id),
    view: async (spaceId) => view(spaceId),
    preview: async (request) => {
      calls.push({ method: "preview", arg: request });
      return {
        id: "plan-1",
        kind: request.kind,
        title: request.kind,
        scope: request.kind === "service.shutdown" ? "controller" : "space",
        affectedSpaceIds: [],
        runningSpaceIds: [],
        changes: ["x"],
        destructive: request.kind === "service.shutdown",
        expiresAt: new Date().toISOString(),
        serviceEpoch: EPOCH,
        stateRevision: REVISION,
      };
    },
    product: async (request) => {
      calls.push({ method: "product", arg: request });
      return productResult(request);
    },
    plugins: async () => [],
    snapshots: async () => [],
    snapshot: async (id) => ({
      id,
      createdAt: new Date().toISOString(),
      runtimeVersion: "0",
      spaceIds: [],
      bytes: 0,
      restorable: false,
    }),
    runtimes: async () => [],
    backups: async () => [],
  };
}

const cfg = window.__WB;
if (!cfg) throw new Error("missing __WB");
const root = document.getElementById("root");
if (!root) throw new Error("missing root");
createRoot(root).render(
  React.createElement(WorkbenchApp, {
    api: makeApi(cfg.supervisor, cfg.child),
    homeUrl: `${cfg.child}/home`,
    env: {
      downloadFile: (fileName) => {
        (window.__WB_DOWNLOADS ??= []).push({ fileName });
      },
      writeClipboard: async (text) => {
        const clipboard = navigator.clipboard;
        if (!clipboard?.writeText) throw new Error("clipboard");
        await clipboard.writeText(text);
      },
    },
  }),
);
