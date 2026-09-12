import { createElement, useCallback, useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { WorkbenchApp } from "../workbench";
import { inferSpacesLocale } from "./i18n";
import { SpacesPanelIcon } from "./icon";
import {
  createWorkbenchGuideRemote,
  createWorkbenchRemote,
  displayWorkbenchMessage,
  isTrustedLoopbackHref,
  readHostHint,
} from "./workbench-remote";
import type { WorkbenchGuideApi } from "../types";

/** Panel identity shared by the sidebar entry and the main panel key. */
export const SPACES_PANEL_ID = "dsh-spaces";
/** English fallback; live sidebar text comes from the label thunk. */
export const SPACES_PANEL_LABEL = "Workbench";

export const inject = ["slots", "connection"];

/**
 * Manager profiles replace the DSH root with WorkbenchApp.
 * Ordinary / uninitialized / recovery profiles only add a return-to-workbench
 * entry — no second rail, no management write UI.
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

export function ReturnToWorkbenchPanel({ guide }: { guide: WorkbenchGuideApi }): ReactElement {
  const locale = inferSpacesLocale();
  const zh = locale === "zh";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const onReturn = useCallback(() => {
    setBusy(true);
    setError(null);
    setStatus(zh ? "正在连接工作台…" : "Connecting to the workbench…");
    void (async () => {
      try {
        const boot = await guide.bootstrap();
        if (boot.recoveryRequired) {
          setError(zh ? "管理工作台身份已损坏，需要恢复。未清除锁。" : "Workbench identity is damaged. Recovery is required. Locks were not cleared.");
          return;
        }
        const target = await guide.returnTarget();
        if (!target.available || !target.origin || !target.path) {
          setError(target.reasons[0] || (zh ? "工作台入口暂不可用。" : "The workbench entry is not available yet."));
          return;
        }
        const href = isTrustedLoopbackHref(target.origin, target.path);
        if (!href) {
          setError(zh ? "工作台入口不是已授权的本机地址。" : "The workbench entry is not an authorized local address.");
          return;
        }
        if (typeof window !== "undefined") window.location.assign(href);
      } catch (caught) {
        setError(displayWorkbenchMessage(caught));
      } finally {
        setBusy(false);
        setStatus(null);
      }
    })();
  }, [guide, zh]);

  return createElement(
    "div",
    {
      className: "dsh-spaces-return",
      style: {
        height: "100%",
        padding: "24px",
        color: "var(--dsw-alias-label-primary, #1f2328)",
        background: "var(--dsw-alias-app-bg, #fff)",
      },
    },
    createElement("h1", { style: { fontSize: "20px", margin: "0 0 8px" } }, zh ? "返回工作台" : "Return to workbench"),
    createElement(
      "p",
      { style: { margin: "0 0 16px", color: "var(--dsw-alias-label-secondary, #5b6168)" } },
      zh
        ? "当前空间没有管理工作台。这里只会带你回到已认证的工作台入口，不会在本空间提供管理能力。"
        : "This space is not the manager. This entry only returns you to the authenticated workbench. It does not expose management actions here.",
    ),
    createElement(
      "button",
      {
        type: "button",
        disabled: busy,
        onClick: onReturn,
        style: {
          padding: "8px 14px",
          borderRadius: "8px",
          border: "none",
          background: "var(--dsw-alias-interactive-primary, #5865f2)",
          color: "#fff",
          cursor: busy ? "progress" : "pointer",
        },
      },
      busy ? (zh ? "正在连接…" : "Connecting…") : zh ? "返回工作台" : "Return to workbench",
    ),
    status ? createElement("p", { role: "status" }, status) : null,
    error ? createElement("p", { role: "alert", style: { color: "var(--dsw-alias-danger, #d1242f)" } }, error) : null,
  );
}
