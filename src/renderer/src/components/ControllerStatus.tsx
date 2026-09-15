import React from "react";
import type { DesktopControllerState } from "@shared/desktop-controller";

const COPY = {
  en: {
    readonlyWeb: "Read-only — the web workbench holds this Home",
    readonlyDesktop: "Read-only — another desktop instance holds this Home",
    readonlyFree: "Read-only — take over to make changes",
    recovery: "Fault reported — ownership was not taken",
    heldRecovery: "Holding control; a fault was reported",
    owner: "Desktop controls this Home",
    transferring: "Handing off Home control…",
    takeover: "Take over",
    transfer: "Hand off",
  },
  zh: {
    readonlyWeb: "只读 — Web 工作台正在控制此 Home",
    readonlyDesktop: "只读 — 另一桌面实例正在控制此 Home",
    readonlyFree: "只读 — 接管后才能更改",
    recovery: "已报告故障 — 未取得运行权",
    heldRecovery: "保留控制权；已报告故障",
    owner: "桌面正在控制此 Home",
    transferring: "正在移交 Home 控制权…",
    takeover: "接管",
    transfer: "移交",
  },
} as const;

function summary(state: DesktopControllerState, locale: "zh" | "en"): string {
  const text = COPY[locale];
  if (state.transferPending) return text.transferring;
  if (state.writable) return text.owner;
  if (state.held && state.recoveryRequired) return text.heldRecovery;
  if (state.recoveryRequired) return state.reasons[0] || text.recovery;
  if (state.ownerKind === "web") return text.readonlyWeb;
  if (state.ownerKind === "desktop") return text.readonlyDesktop;
  return text.readonlyFree;
}

export function ControllerStatus({
  state,
  locale,
  busy,
  onAcquire,
  onRelease,
}: {
  state: DesktopControllerState;
  locale: "zh" | "en";
  busy?: boolean;
  onAcquire: () => void;
  onRelease: () => void;
}) {
  const text = COPY[locale];
  const label = summary(state, locale);
  const showTakeover = !state.held && !state.transferPending;
  const showTransfer = state.held;

  return (
    <div
      className="app-no-drag flex max-w-full items-center gap-2 rounded-full px-2 py-0.5 text-[11px] leading-4"
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        color: state.writable && !state.transferPending ? "var(--text-muted)" : "var(--warn)",
      }}
      title={state.reasons.join("\n") || label}
    >
      <span className="min-w-0 truncate">{label}</span>
      {showTakeover ? (
        <button
          type="button"
          className="btn-primary shrink-0 rounded-full px-2 py-0.5 text-[11px]"
          disabled={busy}
          onClick={onAcquire}
        >
          {text.takeover}
        </button>
      ) : null}
      {showTransfer ? (
        <button
          type="button"
          className="btn-ghost shrink-0 rounded-full px-2 py-0.5 text-[11px]"
          disabled={busy || state.transferPending}
          onClick={onRelease}
        >
          {text.transfer}
        </button>
      ) : null}
    </div>
  );
}
