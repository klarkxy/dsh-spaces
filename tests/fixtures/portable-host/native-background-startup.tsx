import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NativeHostController } from "../../../packages/plugin/src/client/ui/native-controller";
import { NativeHostShell } from "../../../packages/plugin/src/client/ui/native-shell";
import { NATIVE_HOST_CSS } from "../../../packages/plugin/src/client/ui/native-styles";
import { HOST_SHELL_CSS } from "../../../packages/plugin/src/client/host-shell";
import type { DesktopLaunchPhase, DesktopLaunchState } from "../../../packages/plugin/src/types";

const epoch = "a".repeat(64);
const requested = new URLSearchParams(location.search).get("phase");
let launch: DesktopLaunchState = {
  operationId: "controlled-one",
  phase: requested === "stopped" ? "stopped" : "preparing",
  serviceEpoch: epoch,
  managerId: "hub",
  reasons: [],
  failure: null,
};
const counts = { begin: 0, status: 0, directory: 0, oldInitialize: 0, child: 0, acquire: 0, focus: 0, urls: [] as string[] };
const baseCreate = document.createElement.bind(document);
(document as unknown as { createElement: (tag: string, options?: ElementCreationOptions) => HTMLElement }).createElement = (tag, options) => {
  const element = baseCreate(tag, options);
  if (tag !== "webview") return element;
  const guest = element as HTMLElement & { url: string; getURL: () => string; loadURL: (value: string) => Promise<void> };
  guest.url = "about:blank";
  guest.getURL = () => guest.url;
  guest.focus = () => { counts.focus += 1; };
  guest.loadURL = async value => {
    counts.urls.push(value);
    const parsed = new URL(value);
    if (parsed.pathname.startsWith("/bootstrap/")) {
      guest.url = parsed.origin + "/native/" + parsed.searchParams.get("native");
      return;
    }
    guest.url = value;
    if (parsed.hash.startsWith("#select/")) {
      guest.url = value.replace("#select/", "#selected/");
      queueMicrotask(() => guest.dispatchEvent(new Event("did-navigate-in-page")));
    }
  };
  setTimeout(() => {
    guest.dispatchEvent(new Event("dom-ready"));
    guest.dispatchEvent(new Event("did-finish-load"));
    guest.dispatchEvent(new Event("did-stop-loading"));
  }, 0);
  return guest;
};

const api = {
  role: async () => ({ role: "workspace" as const, profileId: "desktop", managerId: null, unavailable: false, reasons: [] as string[] }),
  beginDesktopLaunch: async () => { counts.begin += 1; return structuredClone(launch); },
  desktopLaunchState: async () => { counts.status += 1; return structuredClone(launch); },
  presentationSnapshot: async () => {
    counts.directory += 1;
    return { serviceEpoch: epoch, managerId: "hub", spaces: [{ id: "coding", displayName: "Coding", status: "stopped", generation: 0 }] };
  },
  initialize: async () => { counts.oldInitialize += 1; throw Error("must not initialize"); },
  bootstrap: async () => { throw Error("must not bootstrap"); },
  spaceAction: async () => { counts.child += 1; throw Error("must not autostart a child"); },
  returnTarget: async () => ({ available: true, unavailable: false, origin: "http://127.0.0.1:3333", path: "/bootstrap/" + "b".repeat(32), reasons: [] as string[] }),
};
const bridge = { acquire: async () => { counts.acquire += 1; return { lease: "owned", partition: "isolated" }; }, release: async () => {} };
let controller: NativeHostController | undefined;
let root: Root = createRoot(document.querySelector("[data-shell-overlay]")!);
const mount = () => {
  controller?.stop();
  controller = new NativeHostController(api, bridge);
  root.render(<NativeHostShell controller={controller} />);
};
const style = document.createElement("style");
style.textContent = HOST_SHELL_CSS + NATIVE_HOST_CSS;
document.head.append(style);
window.__fixture = {
  counts,
  state: () => controller!.getSnapshot(),
  phase: (phase: DesktopLaunchPhase) => { launch = { ...launch, phase }; },
  fail: () => {
    launch = {
      ...launch, phase: "failed", reasons: ["CONTROLLED_PRIMARY", "CONTROLLED_CLEANUP"],
      failure: { stage: "endpoint", primaryReason: "CONTROLLED_PRIMARY", cleanupReason: "CONTROLLED_CLEANUP", instanceRetained: true },
    };
  },
  remount: () => {
    controller?.stop();
    root.unmount();
    root = createRoot(document.querySelector("[data-shell-overlay]")!);
    mount();
  },
};
mount();

declare global {
  interface Window {
    __fixture: {
      counts: { begin: number; status: number; directory: number; oldInitialize: number; child: number; acquire: number; focus: number; urls: string[] };
      state: () => { phase: string; selected: string; guide: boolean };
      phase: (phase: DesktopLaunchPhase) => void;
      fail: () => void;
      remount: () => void;
    };
  }
}
