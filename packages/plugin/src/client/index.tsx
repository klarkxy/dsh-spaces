import { createElement, type CSSProperties, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { MotionRoot } from "../../../../src/shared/ui/motion";
import { WorkbenchApp } from "../workbench";
import { WORKBENCH_CSS } from "../workbench/styles";
import { mountStaticClientStyle } from "./client-style";
import { readViewHint } from "../../../view-bridge/src/env";
import { CONTAINED_MANAGEMENT_PARAM } from "../../../../src/shared/space-host";
import { HostShellController } from "./host-shell-state";
import { desktopBrowserBridge, NativeHostController } from "./ui/native-controller";
import { NativeHostShell } from "./ui/native-shell";
import { NATIVE_HOST_CSS, NATIVE_BROWSER_CSS } from "./ui/native-styles";
import { PortableHostShell, HostShellPanel, HOST_SHELL_CSS } from "./host-shell";
import { homeViewUrl, isHomeView } from "./home-view";
import { guideText, inferSpacesLocale, type SpacesLocale } from "./i18n";
import { publicGuideDetail } from "./guide-detail";
import { SpacesPanelIcon } from "./icon";
import { registerSpacesBranding } from "./branding";
import {
  createWorkbenchGuideRemote,
  createWorkbenchRemote,
  readHostHint,
} from "./workbench-remote";
/** Panel identity shared by the sidebar entry and the main panel key. */
export const SPACES_PANEL_ID = "dsh-spaces";
/** English fallback; live sidebar text comes from the label thunk. */
export const SPACES_PANEL_LABEL = "Workbench";

export const inject = ["slots", "connection"];

/**
 * The actual manager owns the management application. Other compatible top-level
 * clients add an in-place rail without replacing their root or gaining manager Remotes.
 * Embedded workspace children retain only their lightweight view bridge.
 */
export function apply(ctx: Context): void {
  const connection: ConnectionHandle = ctx.get("connection");
  const hint = readHostHint();
  // Presentation markers do not grant rights. Manager identity still comes from the Host.
  const embedded = typeof window !== "undefined" && window.parent !== window;
  if (hint?.role === "manager" && !hint.unavailable) registerSpacesBranding(ctx);
  if (typeof window !== "undefined" && isHomeView(window.location.href)) return;
  if (hint?.role !== "manager" && embedded && readViewHint()) return;
  if (hint?.role === "manager" && !hint.unavailable) {
    // The embedded home uses this profile's unmodified DSH root. Do not
    // recursively mount Spaces inside it or change the profile on disk.
    if (typeof window !== "undefined" && window.location && isHomeView(window.location.href)) return;
    // Native plugin styles have an explicit owner and lifetime. Do not depend
    // on resource tags rendered inside the replaceable root slot.
    if (typeof document !== "undefined") {
      for (const [name, css] of [["workbench.css", WORKBENCH_CSS]] as const) {
        ctx.effect(() => mountStaticClientStyle(document, "dsh-spaces", name, css));
      }
    }
    const api = createWorkbenchRemote(connection);
    const homeUrl = typeof window !== "undefined" && window.location ? homeViewUrl(window.location.href) : undefined;
    ctx.slots.inject("root", () =>
      ctx.slots.register({ name: "root", priority: -1 }, () => createElement(WorkbenchApp, { api, homeUrl, surfaceView: readViewHint() ?? undefined,
        contained: embedded && new URL(window.location.href).searchParams.get(CONTAINED_MANAGEMENT_PARAM) === "1" && !!readViewHint(),
        nativeSurface: embedded && new URL(window.location.href).searchParams.get("dsh-spaces-native") === "1" && !!readViewHint(),
      })),
    );
    return;
  }

  const guide = createWorkbenchGuideRemote(connection);
  const nativeBridge = desktopBrowserBridge();
  if (nativeBridge) {
    let active = new NativeHostController(guide, nativeBridge);
    ctx.effect(() => () => active.stop());
    ctx.effect(() => mountStaticClientStyle(document, "dsh-spaces", "host-shell.css", HOST_SHELL_CSS + NATIVE_HOST_CSS + NATIVE_BROWSER_CSS));
    ctx.slots.inject("shell.overlay", () => ctx.slots.register(
      { name: "shell.overlay", id: "dsh-spaces-native-shell" }, () => {
        if (active.disposedBeforeTerminal) active = new NativeHostController(guide, nativeBridge);
        return createElement(MotionRoot, null, createElement(NativeHostShell, {
          controller: active,
          onControllerChange: (next) => { active = next; },
        }));
      },
    ));
    return;
  }
  const host = new HostShellController(guide);
  if (typeof document !== "undefined") ctx.effect(() => mountStaticClientStyle(document, "dsh-spaces", "host-shell.css", HOST_SHELL_CSS));
  // The host keeps its own root, branding, native chrome and live conversation.
  ctx.slots.inject("shell.overlay", () => ctx.slots.register(
    { name: "shell.overlay", id: "dsh-spaces-host-shell" }, () =>
      createElement(MotionRoot, null, createElement(PortableHostShell, { controller: host })),
  ));
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: SPACES_PANEL_ID,
        order: 100,
        label: () => (inferSpacesLocale() === "zh" ? "工作台" : SPACES_PANEL_LABEL),
      },
      SpacesPanelIcon,
    ),
  );
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: SPACES_PANEL_ID }, () =>
      createElement(MotionRoot, null, createElement(ReturnToWorkbenchPanel, { host })),
    ),
  );
}

const panelStyle: CSSProperties = {
  height: "100%",
  padding: "24px",
  color: "var(--dsw-alias-label-primary, #1f2328)",
  background: "var(--dsw-alias-bg-base, #fff)",
  borderRadius: "12px",
  boxShadow: "0 20px 48px -16px rgba(0,0,0,0.28)",
  overflow: "auto",
};
const bodyStyle: CSSProperties = {
  margin: "0 0 16px",
  color: "var(--dsw-alias-label-secondary, #5b6168)",
};
const primaryButtonStyle = (busy: boolean): CSSProperties => ({
  padding: "8px 14px",
  borderRadius: "8px",
  border: "none",
  background: "var(--dsw-alias-button-primary-fill, #5865f2)",
  color: "#fff",
  cursor: busy ? "progress" : "pointer",
  boxShadow: "0 6px 18px -8px rgba(0,0,0,0.45)",
  transition: "transform 120ms cubic-bezier(0.2,0,0,1), box-shadow 200ms cubic-bezier(0.2,0,0,1)",
});
const alertStyle: CSSProperties = {
  color: "var(--dsw-alias-label-error, #d1242f)",
  border: "1px solid var(--dsw-alias-label-error, #d1242f)",
  borderRadius: "8px",
  padding: "8px 10px",
};
const copyButtonStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: "8px",
  border: "1px solid var(--dsw-alias-border-l3, #d0d7de)",
  background: "transparent",
  color: "var(--dsw-alias-label-primary, #1f2328)",
  cursor: "pointer",
  transition: "background-color 120ms cubic-bezier(0.2,0,0,1), transform 120ms cubic-bezier(0.2,0,0,1)",
};

export type GuidePanelMode = "loading" | "failed" | "blocked" | "init" | "init-failed" | "enter" | "enter-failed";

export interface GuidePanelViewProps {
  locale: SpacesLocale;
  mode: GuidePanelMode;
  error: string | null;
  status: string | null;
  busy: "role" | "enter" | "initialize" | null;
  onEnter?: () => void;
  onInitialize?: () => void;
}

/** Pure view for SSR tests. Error cards never include retry or reinitialize actions. */
export function GuidePanelView({
  locale,
  mode,
  error,
  status,
  busy,
  onEnter,
  onInitialize,
}: GuidePanelViewProps): ReactElement {
  const copy = (key: Parameters<typeof guideText>[1]) => guideText(locale, key);
  const detail = error ? publicGuideDetail(error) : null;
  const action =
    mode === "init" || mode === "enter-failed"
      ? {
          name: "initialize" as const,
          label:
            busy === "initialize" ? copy("initBusy") : mode === "enter-failed" ? copy("startAction") : copy("initAction"),
          onClick: onInitialize,
          busy: busy === "initialize",
        }
      : mode === "enter"
        ? {
            name: "enter" as const,
            label: busy === "enter" ? copy("enterBusy") : copy("enterAction"),
            onClick: onEnter,
            busy: busy === "enter",
          }
        : null;
  return createElement(
    "div",
    {
      className: "dsh-spaces-return",
      "data-dsh-spaces-guide": mode,
      style: panelStyle,
    },
    createElement("h1", { style: { fontSize: "20px", margin: "0 0 8px" } }, guideTitle(locale, mode)),
    createElement("p", { style: bodyStyle }, guideBody(locale, mode)),
    mode === "loading" ? createElement("p", { role: "status" }, copy("loading")) : null,
    action
      ? createElement(
          "button",
          {
            type: "button",
            "data-dsh-spaces-action": action.name,
            disabled: busy !== null,
            onClick: action.onClick,
            style: primaryButtonStyle(action.busy),
          },
          action.label,
        )
      : null,
    status ? createElement("p", { role: "status" }, status) : null,
    detail
      ? createElement(
          "div",
          { "data-dsh-spaces-error": mode },
          createElement("p", { role: "alert", style: alertStyle }, detail),
          createElement(
            "button",
            {
              type: "button",
              "data-dsh-spaces-copy": "details",
              style: copyButtonStyle,
              onClick: () => {
                const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
                void clipboard?.writeText(detail);
              },
            },
            copy("copyDetails"),
          ),
        )
      : null,
  );
}

/** In-place panel sharing the rail's presentation client; never navigates the outer document. */
export function ReturnToWorkbenchPanel({ host }: { host: HostShellController }): ReactElement {
  return createElement(HostShellPanel, { controller: host });
}

function guideTitle(locale: SpacesLocale, mode: GuidePanelMode): string {
  if (mode === "blocked" || mode === "enter-failed") return guideText(locale, "blockedTitle");
  if (mode === "enter") return guideText(locale, "enterTitle");
  if (mode === "failed") return guideText(locale, "blockedTitle");
  return guideText(locale, "initTitle");
}

function guideBody(locale: SpacesLocale, mode: GuidePanelMode): string {
  if (mode === "blocked") return guideText(locale, "blockedBody");
  if (mode === "failed") return guideText(locale, "roleFailed");
  if (mode === "init-failed") return guideText(locale, "unavailable");
  if (mode === "enter-failed") return guideText(locale, "enterBody");
  if (mode === "enter") return guideText(locale, "enterBody");
  if (mode === "loading") return guideText(locale, "loading");
  return guideText(locale, "initBody");
}
