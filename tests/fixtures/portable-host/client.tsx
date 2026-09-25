/** Browser integration fixture. Real production shell, WorkbenchApp and view handshake; synthetic Host API. */
import React from "react";
import { createRoot } from "react-dom/client";
import { HostShellController } from "../../../packages/plugin/src/client/host-shell-state";
import { PortableHostShell, HOST_SHELL_CSS } from "../../../packages/plugin/src/client/host-shell";
import { WorkbenchApp } from "../../../packages/plugin/src/workbench/app";
import { startViewBridge } from "../../../packages/view-bridge/src/client";
import { readViewHint } from "../../../packages/view-bridge/src/env";
import type { WorkbenchApi } from "../../../src/shared/workbench";

const config = (window as any).__PORTABLE_FIXTURE__ as { role: string };
const root = document.querySelector<HTMLElement>("#root")!;
const json = async (path: string, body: unknown) => {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("fixture-api-failed");
  return response.json();
};
if (config.role === "parent") {
  const guide = {
    role: () => json("/guide/role", {}), portalTarget: (audience: unknown) => json("/guide/portal", audience),
    initialize: () => { throw new Error("Initialization is not expected in this fixture"); },
    bootstrap: () => { throw new Error("No renderer bootstrap"); }, returnTarget: () => { throw new Error("No navigation"); },
  };
  const controller = new HostShellController(guide);
  (window as any).__portableController = controller;
  const native = root.querySelector<HTMLElement>("#native")!;
  const overlay = root.querySelector<HTMLElement>("[data-shell-overlay]")!;
  const style = document.createElement("style"); style.textContent = HOST_SHELL_CSS; document.head.append(style);
  const reactRoot = createRoot(overlay);
  reactRoot.render(<PortableHostShell controller={controller} />);
  (window as any).__nativeIdentity = native;
  (window as any).__disposePortable = () => reactRoot.unmount();
} else {
  const view = readViewHint()!;
  startViewBridge({ slots: { inject(_name, effect) { return effect(); } } }, view, {
    document, connection: { state: { getSnapshot: () => "connected", subscribe: () => () => {} } },
  });
  if (config.role === "manager") {
    const api = new Proxy({}, { get: (_target, method) => async (...args: unknown[]) => {
      const body = method === "view" ? { spaceId: args[0] } : method === "product" ? { request: args[0] } : {};
      return json("/fixture-api/" + String(method), body);
    } }) as WorkbenchApi;
    createRoot(root).render(<WorkbenchApp api={api} contained surfaceView={view} />);
  } else createRoot(root).render(<main><h1>Alpha workspace</h1><textarea aria-label="Space draft" /></main>);
}
