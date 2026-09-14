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
 * Ordinary / uninitialized / recovery profiles only add a guide panel
 * (initialize or enter). No second rail, no management write UI.
 */
export function apply(ctx: Context): void {
  const connection: ConnectionHandle = ctx.get("connection");
  const hint = readHostHint();
  if (hint?.role === "manager" && !hint.recoveryRequired) {
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
const secondaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
  marginLeft: "8px",
  borderRadius: "8px",
  border: "1px solid var(--dsw-alias-border-primary, #d0d7de)",
  background: "transparent",
  color: "var(--dsw-alias-label-primary, #1f2328)",
  cursor: "pointer",
};
const alertStyle: CSSProperties = { color: "var(--dsw-alias-danger, #d1242f)" };

export function ReturnToWorkbenchPanel({ guide }: { guide: WorkbenchGuideApi }): ReactElement {
  const locale = inferSpacesLocale();
  const [role, setRole] = useState<WorkbenchGuideRole | null>(null);
  const [busy, setBusy] = useState<"role" | "enter" | "initialize" | null>("role");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [enterFailed, setEnterFailed] = useState(false);

  const loadRole = useCallback(async () => {
    setBusy("role");
    setError(null);
    setStatus(null);
    try {
      const next = await guide.role();
      setRole(next);
      if (next.recoveryRequired) setEnterFailed(false);
    } catch (caught) {
      setError(displayWorkbenchMessage(caught));
    } finally {
      setBusy(null);
    }
  }, [guide]);

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
    setEnterFailed(false);
    setStatus(guideText(locale, "enterProgress"));
    void (async () => {
      try {
        const boot = await guide.bootstrap();
        if (boot.recoveryRequired) {
          setError(guideText(locale, "recoveryBody"));
          setEnterFailed(false);
          return;
        }
        const target = await guide.returnTarget();
        if (!navigateTo(target.origin, target.path, target.reasons)) setEnterFailed(true);
      } catch (caught) {
        setError(displayWorkbenchMessage(caught));
        setEnterFailed(true);
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
        if (result.recoveryRequired) {
          setError(result.reasons[0] || guideText(locale, "recoveryBody"));
          setEnterFailed(false);
          return;
        }
        if (result.managerId && role) {
          setRole({ ...role, managerId: result.managerId });
        }
        if (!result.ok) {
          setError(result.reasons[0] || guideText(locale, "unavailable"));
          setEnterFailed(true);
        } else if (!navigateTo(result.origin, result.path, result.reasons)) {
          setEnterFailed(true);
        }
      } catch (caught) {
        setError(displayWorkbenchMessage(caught));
        setEnterFailed(true);
      } finally {
        setBusy(null);
        setStatus(null);
      }
    })();
  }, [busy, guide, locale, navigateTo, role]);

  const mode = guideMode(role, busy, error);
  const copy = (key: Parameters<typeof guideText>[1]) => guideText(locale, key);
  const disabled = busy !== null;
  const primaryLabel =
    mode === "enter"
      ? busy === "enter"
        ? copy("enterBusy")
        : copy("enterAction")
      : busy === "initialize"
        ? copy("initBusy")
        : error
          ? copy("retry")
          : copy("initAction");

  return createElement(
    "div",
    {
      className: "dsh-spaces-return",
      "data-dsh-spaces-guide": mode,
      style: panelStyle,
    },
    createElement("h1", { style: { fontSize: "20px", margin: "0 0 8px" } }, guideTitle(locale, mode)),
    createElement("p", { style: bodyStyle }, guideBody(locale, mode, !role && Boolean(error))),
    mode === "loading"
      ? createElement("p", { role: "status" }, copy("loading"))
      : mode === "recovery"
        ? createElement(
            "button",
            { type: "button", disabled, onClick: loadRole, style: primaryButtonStyle(false) },
            copy("retry"),
          )
        : mode === "failed"
          ? createElement(
              "button",
              { type: "button", disabled, onClick: loadRole, style: primaryButtonStyle(false) },
              copy("retry"),
            )
          : createElement(
              "div",
              null,
              createElement(
                "button",
                {
                  type: "button",
                  disabled,
                  onClick: mode === "enter" ? onEnter : onInitialize,
                  style: primaryButtonStyle(busy === "enter" || busy === "initialize"),
                },
                primaryLabel,
              ),
              mode === "enter" && enterFailed
                ? createElement(
                    "button",
                    {
                      type: "button",
                      disabled,
                      onClick: onInitialize,
                      style: secondaryButtonStyle,
                    },
                    busy === "initialize" ? copy("initBusy") : copy("startAction"),
                  )
                : null,
            ),
    status ? createElement("p", { role: "status" }, status) : null,
    error ? createElement("p", { role: "alert", style: alertStyle }, error) : null,
  );
}

function guideMode(
  role: WorkbenchGuideRole | null,
  busy: "role" | "enter" | "initialize" | null,
  error: string | null,
): "loading" | "failed" | "recovery" | "init" | "enter" {
  if (role) {
    if (role.recoveryRequired) return "recovery";
    return role.managerId ? "enter" : "init";
  }
  if (error && busy !== "role") return "failed";
  return "loading";
}

function guideTitle(locale: SpacesLocale, mode: ReturnType<typeof guideMode>): string {
  if (mode === "recovery") return guideText(locale, "recoveryTitle");
  if (mode === "enter") return guideText(locale, "enterTitle");
  return guideText(locale, "initTitle");
}

function guideBody(locale: SpacesLocale, mode: ReturnType<typeof guideMode>, roleFailed: boolean): string {
  if (mode === "recovery") return guideText(locale, "recoveryBody");
  if (mode === "failed" || roleFailed) return guideText(locale, "roleFailed");
  if (mode === "enter") return guideText(locale, "enterBody");
  if (mode === "loading") return guideText(locale, "loading");
  return guideText(locale, "initBody");
}
