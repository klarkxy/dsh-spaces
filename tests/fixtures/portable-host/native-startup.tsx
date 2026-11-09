import React from "react";
import { createRoot } from "react-dom/client";
import { NativeHostController } from "../../../packages/plugin/src/client/ui/native-controller";
import { NativeHostShell } from "../../../packages/plugin/src/client/ui/native-shell";
import { NATIVE_HOST_CSS } from "../../../packages/plugin/src/client/ui/native-styles";
import { HOST_SHELL_CSS } from "../../../packages/plugin/src/client/host-shell";

const readyLaunch = {
  operationId: "launch-one", phase: "ready" as const, serviceEpoch: "aa".repeat(32), managerId: "hub", reasons: [] as string[], failure: null,
};
const controller = new NativeHostController({
  role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
  beginDesktopLaunch: async () => readyLaunch,
  desktopLaunchState: async () => readyLaunch,
  presentationSnapshot: async () => {
    const response = await fetch("/directory");
    if (!response.ok) throw Error(await response.text());
    return response.json();
  },
  initialize: async () => { throw Error("Unexpected launch"); },
  spaceActivity: async () => ({ activity: "idle", generation: 1 }),
  spaceAction: async request => {
    const response = await fetch("/space-action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  },
  previewServiceRestart: async () => {
    const response = await fetch("/restart-preview", { method: "POST" });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  },
  restartService: async confirmationId => {
    const response = await fetch("/restart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationId }) });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  },
  bootstrap: async () => { throw Error("Unexpected bootstrap"); },
  portalTarget: async () => ({ available: false, unavailable: false, origin: null, path: null, reasons: [] }),
  returnTarget: async () => { throw Error("Unexpected navigation"); },
}, { acquire: async () => { throw Error("Unexpected guest"); }, release: async () => {} });
const style = document.createElement("style");
style.textContent = HOST_SHELL_CSS + NATIVE_HOST_CSS;
document.head.append(style);
createRoot(document.querySelector("[data-shell-overlay]")!).render(<NativeHostShell controller={controller} />);
