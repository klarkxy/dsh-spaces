import React from "react";
import { createRoot } from "react-dom/client";
import { NativeHostController, NativeHostShell, NATIVE_HOST_CSS } from "../../../packages/plugin/src/client/native-host";
import { HOST_SHELL_CSS } from "../../../packages/plugin/src/client/host-shell";

const controller = new NativeHostController({
  role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
  presentationSnapshot: async () => {
    const response = await fetch("/directory");
    if (!response.ok) throw Error(await response.text());
    return response.json();
  },
  initialize: async () => { throw Error("Unexpected launch"); },
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
  returnTarget: async () => { throw Error("Unexpected navigation"); },
}, { acquire: async () => { throw Error("Unexpected guest"); }, release: async () => {} });
const style = document.createElement("style");
style.textContent = HOST_SHELL_CSS + NATIVE_HOST_CSS;
document.head.append(style);
createRoot(document.querySelector("[data-shell-overlay]")!).render(<NativeHostShell controller={controller} />);
