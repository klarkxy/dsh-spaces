import { useEffect, useState, type ReactNode } from "react";
import { TITLEBAR_HEIGHT } from "@shared/layout";

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
      <path d="M0.5 2.5h7v7h-7z" fill="#111214" stroke="currentColor" />
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
      className={`app-no-drag flex h-full w-[46px] items-center justify-center text-white/70 transition-colors ${
        danger
          ? "hover:bg-[#e81123] hover:text-white"
          : "hover:bg-white/10 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

export function TitleBar({
  busy,
  queueText,
}: {
  busy?: string;
  queueText?: string;
}) {
  const isMac = window.dshSpaces.platform === "darwin";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (isMac) return;
    void window.dshSpaces.windowIsMaximized().then(setMaximized);
    return window.dshSpaces.onWindowMaximized(setMaximized);
  }, [isMac]);

  return (
    <header
      className="app-drag relative z-50 flex shrink-0 select-none items-center border-b border-white/10 bg-[#111214]"
      style={{ height: TITLEBAR_HEIGHT }}
      onDoubleClick={(event) => {
        if (isMac) return;
        if ((event.target as HTMLElement).closest("button")) return;
        void window.dshSpaces.windowToggleMaximize().then(setMaximized);
      }}
    >
      <div className={`flex min-w-0 flex-1 items-center gap-3 px-3 ${isMac ? "pl-[76px]" : ""}`}>
        {busy ? <p className="truncate text-xs text-amber-200">{busy}…</p> : null}
        {queueText ? <p className="truncate text-xs text-amber-200">{queueText}</p> : null}
      </div>
      {isMac ? null : (
        <div className="flex h-full">
          <CaptionButton
            label="Minimize"
            onClick={() => void window.dshSpaces.windowMinimize()}
          >
            <MinimizeGlyph />
          </CaptionButton>
          <CaptionButton
            label={maximized ? "Restore" : "Maximize"}
            onClick={() => void window.dshSpaces.windowToggleMaximize().then(setMaximized)}
          >
            {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
          </CaptionButton>
          <CaptionButton label="Close" danger onClick={() => void window.dshSpaces.windowClose()}>
            <CloseGlyph />
          </CaptionButton>
        </div>
      )}
    </header>
  );
}
