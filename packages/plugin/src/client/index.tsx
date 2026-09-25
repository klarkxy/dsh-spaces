import { createElement, type CSSProperties, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { WorkbenchApp } from "../workbench";
import { WORKBENCH_CSS } from "../workbench/styles";
import { HOME_CSS } from "../workbench/dashboard-home";
import { DASHBOARD_CSS } from "../../../dashboard/src/view";
import { mountStaticClientStyle } from "../../../dashboard/src/client-style";
import { readViewHint } from "../../../view-bridge/src/env";
import { CONTAINED_MANAGEMENT_PARAM } from "../../../../src/shared/space-host";
import { HostShellController } from "./host-shell-state";
import { PortableHostShell, HostShellPanel, HOST_SHELL_CSS } from "./host-shell";
import { homeViewUrl, isHomeView } from "./home-view";
import { guideText, inferSpacesLocale, type SpacesLocale } from "./i18n";
import { SpacesPanelIcon } from "./icon";
import { registerSpacesBranding } from "./branding";
import {
  createWorkbenchGuideRemote,
  createWorkbenchRemote,
  readHostHint,
} from "./workbench-remote";
import type { WorkbenchGuideRole } from "../types";

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
      for (const [name, css] of [["workbench.css", WORKBENCH_CSS], ["home.css", HOME_CSS], ["dashboard.css", DASHBOARD_CSS]] as const) {
        ctx.effect(() => mountStaticClientStyle(document, "@dsh-spaces/plugin", name, css));
      }
    }
    const api = createWorkbenchRemote(connection);
    const homeUrl = typeof window !== "undefined" && window.location ? homeViewUrl(window.location.href) : undefined;
    ctx.slots.inject("root", () =>
      ctx.slots.register({ name: "root", priority: -1 }, () => createElement(WorkbenchApp, { api, homeUrl, surfaceView: readViewHint() ?? undefined,
        contained: embedded && new URL(window.location.href).searchParams.get(CONTAINED_MANAGEMENT_PARAM) === "1" && !!readViewHint(),
      })),
    );
    return;
  }

  const guide = createWorkbenchGuideRemote(connection);
  const host = new HostShellController(guide);
  if (typeof document !== "undefined") ctx.effect(() => mountStaticClientStyle(document, "@dsh-spaces/plugin", "host-shell.css", HOST_SHELL_CSS));
  // The host keeps its own root, branding, native chrome and live conversation.
  ctx.slots.inject("shell.overlay", () => ctx.slots.register(
    { name: "shell.overlay", id: "dsh-spaces-host-shell" }, () => createElement(PortableHostShell, { controller: host }),
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
      createElement(ReturnToWorkbenchPanel, { host }),
    ),
  );
}

const panelStyle: CSSProperties = {
  height: "100%",
  padding: "24px",
  color: "var(--dsw-alias-label-primary, #1f2328)",
  background: "var(--dsw-alias-app-bg, #fff)",
};
const bodyStyle: CSSProperties = {
  margin: "0 0 16px",
  color: "var(--dsw-alias-label-secondary, #5b6168)",
};
const primaryButtonStyle = (busy: boolean): CSSProperties => ({
  padding: "8px 14px",
  borderRadius: "8px",
  border: "none",
  background: "var(--dsw-alias-interactive-primary, #5865f2)",
  color: "#fff",
  cursor: busy ? "progress" : "pointer",
});
const alertStyle: CSSProperties = { color: "var(--dsw-alias-danger, #d1242f)" };
const copyButtonStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: "8px",
  border: "1px solid var(--dsw-alias-border-primary, #d0d7de)",
  background: "transparent",
  color: "var(--dsw-alias-label-primary, #1f2328)",
  cursor: "pointer",
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
    mode === "init"
      ? {
          name: "initialize" as const,
          label: busy === "initialize" ? copy("initBusy") : copy("initAction"),
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

export function guideMode(
  role: WorkbenchGuideRole | null,
  busy: "role" | "enter" | "initialize" | null,
  error: string | null,
): GuidePanelMode {
  if (busy === "role" && !role) return "loading";
  if (role?.unavailable) return "blocked";
  if (!role && error) return "failed";
  if (role && error) return role.managerId ? "enter-failed" : "init-failed";
  if (role?.managerId) return "enter";
  if (role) return "init";
  return "loading";
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
  if (mode === "init-failed" || mode === "enter-failed") return guideText(locale, "unavailable");
  if (mode === "enter") return guideText(locale, "enterBody");
  if (mode === "loading") return guideText(locale, "loading");
  return guideText(locale, "initBody");
}

function publicGuideDetail(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]{16,}/g, "Bearer [redacted]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'`<>]+/g, "[path]");
}
