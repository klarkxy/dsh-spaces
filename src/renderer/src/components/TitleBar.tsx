import { useEffect, useState, type ReactNode } from "react";
import { TITLEBAR_HEIGHT } from "@shared/layout";
import { useI18n } from "../i18n";

function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" />
      <path d="M0.5 2.5h7v7h-7z" fill="var(--bg-rail)" stroke="currentColor" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function CaptionButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      className="app-no-drag flex h-full w-[46px] items-center justify-center transition-colors"
      style={
        danger
          ? undefined
          : { color: "var(--text-muted)" }
      }
      onMouseEnter={(event) => {
        if (danger) {
          event.currentTarget.style.background = "var(--danger)";
          event.currentTarget.style.color = "#fff";
        } else {
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "transparent";
        event.currentTarget.style.color = danger ? "" : "var(--text-muted)";
      }}
    >
      {children}
    </button>
  );
}

export function TitleBar({
  busy,
  queueText,
  error,
  onDismissError,
}: {
  busy?: string;
  queueText?: string;
  error?: string;
  onDismissError?: () => void;
}) {
  const { t } = useI18n();
  const isMac = window.dshSpaces.platform === "darwin";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (isMac) return;
    void window.dshSpaces.windowIsMaximized().then(setMaximized);
    return window.dshSpaces.onWindowMaximized(setMaximized);
  }, [isMac]);

  return (
    <header
      className="app-drag relative z-50 flex shrink-0 select-none items-center border-b"
      style={{
        height: TITLEBAR_HEIGHT,
        background: "var(--bg-rail)",
        borderColor: "var(--border)",
        color: "var(--text)",
        boxShadow: "inset 0 -1px 0 var(--accent-ring)",
      }}
      onDoubleClick={(event) => {
        if (isMac) return;
        if ((event.target as HTMLElement).closest("button")) return;
        void window.dshSpaces.windowToggleMaximize().then(setMaximized);
      }}
    >
      <div className={`flex min-w-0 flex-1 items-center gap-3 px-3 ${isMac ? "pl-[76px]" : ""}`}>
        <p className="ui-kicker shrink-0">{t("cli.brand")}</p>
        {error ? (
          <div className="app-no-drag flex min-w-0 flex-1 items-center gap-2">
            <p className="min-w-0 truncate text-xs text-red-500" title={error}>
              {error}
            </p>
            {onDismissError ? (
              <button
                type="button"
                className="shrink-0 rounded px-1.5 py-0.5 text-xs"
                style={{ color: "var(--text-muted)" }}
                aria-label={t("common.close")}
                onClick={onDismissError}
              >
                {t("common.close")}
              </button>
            ) : null}
          </div>
        ) : busy ? (
          <p className="truncate text-xs" style={{ color: "var(--warn)" }}>
            {busy}…
          </p>
        ) : null}
        {queueText && !error ? (
          <p className="truncate text-xs" style={{ color: "var(--warn)" }}>
            {queueText}
          </p>
        ) : null}
      </div>
      {isMac ? null : (
        <div className="flex h-full">
          <CaptionButton
            label={t("window.minimize")}
            onClick={() => void window.dshSpaces.windowMinimize()}
          >
            <MinimizeGlyph />
          </CaptionButton>
          <CaptionButton
            label={maximized ? t("window.restore") : t("window.maximize")}
            onClick={() => void window.dshSpaces.windowToggleMaximize().then(setMaximized)}
          >
            {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
          </CaptionButton>
          <CaptionButton label={t("window.close")} danger onClick={() => void window.dshSpaces.windowClose()}>
            <CloseGlyph />
          </CaptionButton>
        </div>
      )}
    </header>
  );
}
