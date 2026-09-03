import type { ReactNode } from "react";
import { TITLEBAR_HEIGHT } from "@shared/layout";
import { useI18n } from "../i18n";

export function Overlay({
  children,
  onBackdrop,
}: {
  children: ReactNode;
  onBackdrop?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="fixed right-0 bottom-0 left-0 z-30 flex items-center justify-center"
      style={{ top: TITLEBAR_HEIGHT, background: "var(--bg-overlay)" }}
    >
      <button
        type="button"
        aria-label={t("common.close")}
        className="absolute inset-0 cursor-default"
        onClick={onBackdrop}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

export function Card({
  children,
  className = "",
  wide = false,
}: {
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div
      className={`${wide ? "flex h-[min(720px,calc(100vh-96px))] w-[840px] flex-col" : "w-[420px]"} max-w-[calc(100vw-96px)] rounded-xl p-5 shadow-xl ${className}`}
      style={{ background: "var(--bg-card)", color: "var(--text)", border: "1px solid var(--border)" }}
    >
      {children}
    </div>
  );
}
