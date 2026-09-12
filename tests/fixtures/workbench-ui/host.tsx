import React from "react";
import { createRoot } from "react-dom/client";
import type {
  WorkbenchApi,
  WorkbenchJob,
  WorkbenchSpace,
  WorkbenchState,
  WorkbenchView,
} from "../../../src/shared/workbench";
import { WorkbenchApp } from "../../../packages/plugin/src/workbench/app";

declare global {
  interface Window {
    __WB?: { supervisor: string; child: string };
    __iframe?: Element | null;
  }
}

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
    role: "manager",
    managerId: "hub",
    owner: { kind: "web", since: "2026-09-12T00:00:00.000Z" },
    writable: true,
    mode: "verified-full",
    dshVersion: "0.1.5-rc.1",
    maintenance: false,
    recoveryRequired: false,
    reasons: [],
    spaces,
    jobs: [],
  };
  const view = (spaceId: string): WorkbenchView => ({
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
    submit: async (command, requestId) => job(command.kind, requestId),
    job: async (id) => job("job", id),
    cancel: async (id) => job("cancel", id),
    view: async (spaceId) => view(spaceId),
    preview: async (request) => ({
      id: "plan-1",
      kind: request.kind,
      title: request.kind,
      scope: "space",
      affectedSpaceIds: [],
      runningSpaceIds: [],
      changes: ["x"],
      destructive: false,
      expiresAt: new Date().toISOString(),
    }),
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
createRoot(root).render(React.createElement(WorkbenchApp, { api: makeApi(cfg.supervisor, cfg.child) }));
