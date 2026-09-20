import { createElement, useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { WorkbenchApp } from "../workbench";
import { guideText, inferSpacesLocale, type SpacesLocale } from "./i18n";
import { SpacesPanelIcon } from "./icon";
import {
  createWorkbenchGuideRemote,
  createWorkbenchRemote,
  displayWorkbenchMessage,
  isTrustedLoopbackHref,
  readHostHint,
} from "./workbench-remote";
import type { WorkbenchGuideApi, WorkbenchGuideRole } from "../types";

/** Panel identity shared by the sidebar entry and the main panel key. */
export const SPACES_PANEL_ID = "dsh-spaces";
/** English fallback; live sidebar text comes from the label thunk. */
export const SPACES_PANEL_LABEL = "Workbench";

export const inject = ["slots", "connection"];

/**
 * Manager profiles replace the DSH root with WorkbenchApp.
 * Ordinary / uninitialized / identity-blocked profiles only add a guide panel
 * (initialize or enter). No second rail, no management write UI.
 */
export function apply(ctx: Context): void {
  const connection: ConnectionHandle = ctx.get("connection");
  const hint = readHostHint();
  if (hint?.role === "manager" && !hint.unavailable) {
    const api = createWorkbenchRemote(connection);
    ctx.slots.inject("root", () =>
      ctx.slots.register({ name: "root", priority: -1 }, () => createElement(WorkbenchApp, { api })),
    );
    return;
  }

  const guide = createWorkbenchGuideRemote(connection);
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
      createElement(ReturnToWorkbenchPanel, { guide }),
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

export function ReturnToWorkbenchPanel({ guide }: { guide: WorkbenchGuideApi }): ReactElement {
  const locale = inferSpacesLocale();
  const [role, setRole] = useState<WorkbenchGuideRole | null>(null);
  const [busy, setBusy] = useState<"role" | "enter" | "initialize" | null>("role");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadRole = useCallback(async () => {
    setBusy("role");
    setError(null);
    setStatus(null);
    try {
      const next = await guide.role();
      setRole(next);
      if (next.unavailable) setError(next.reasons[0] || guideText(locale, "blockedBody"));
    } catch (caught) {
      setError(displayWorkbenchMessage(caught));
    } finally {
      setBusy(null);
    }
  }, [guide, locale]);

  useEffect(() => {
    void loadRole();
  }, [loadRole]);

  const navigateTo = useCallback(
    (origin: string | null, path: string | null, reasons: string[]): boolean => {
      if (!origin || !path) {
        setError(reasons[0] || guideText(locale, "unavailable"));
        return false;
      }
      const href = isTrustedLoopbackHref(origin, path);
      if (!href) {
        setError(guideText(locale, "untrusted"));
        return false;
      }
      if (typeof window !== "undefined") window.location.assign(href);
      return true;
    },
    [locale],
  );

  const onEnter = useCallback(() => {
    if (busy) return;
    setBusy("enter");
    setError(null);
    setStatus(guideText(locale, "enterProgress"));
    void (async () => {
      try {
        const boot = await guide.bootstrap();
        if (boot.unavailable) {
          setError(boot.reasons[0] || guideText(locale, "blockedBody"));
          return;
        }
        const target = await guide.returnTarget();
        navigateTo(target.origin, target.path, target.reasons);
      } catch (caught) {
        setError(displayWorkbenchMessage(caught));
      } finally {
        setBusy(null);
        setStatus(null);
      }
    })();
  }, [busy, guide, locale, navigateTo]);

  const onInitialize = useCallback(() => {
    if (busy) return;
    setBusy("initialize");
    setError(null);
    setStatus(guideText(locale, "initProgress"));
    void (async () => {
      try {
        const result = await guide.initialize();
        if (result.unavailable) {
          setError(result.reasons[0] || guideText(locale, "blockedBody"));
          return;
        }
        if (result.managerId && role) {
          setRole({ ...role, managerId: result.managerId });
        }
        if (!result.ok) {
          setError(result.reasons[0] || guideText(locale, "unavailable"));
        } else {
          navigateTo(result.origin, result.path, result.reasons);
        }
      } catch (caught) {
        setError(displayWorkbenchMessage(caught));
      } finally {
        setBusy(null);
        setStatus(null);
      }
    })();
  }, [busy, guide, locale, navigateTo, role]);

  return createElement(GuidePanelView, {
    locale,
    mode: guideMode(role, busy, error),
    error,
    status,
    busy,
    onEnter,
    onInitialize,
  });
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
