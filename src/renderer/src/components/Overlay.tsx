import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
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
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className="fixed right-0 bottom-0 left-0 z-30 flex items-center justify-center"
      style={{ top: TITLEBAR_HEIGHT, background: "var(--bg-overlay)" }}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16 }}
    >
      <button
        type="button"
        aria-label={t("common.close")}
        className="absolute inset-0 cursor-default"
        onClick={onBackdrop}
      />
      <motion.div
        className="relative z-10"
        initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
      >
        {children}
      </motion.div>
    </motion.div>
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
      className={`ui-card ui-card--dialog ${wide ? "flex h-[min(800px,calc(100vh-72px))] w-[min(980px,calc(100vw-64px))] flex-col" : /\bw-/.test(className) ? "" : "w-[420px]"} max-w-[calc(100vw-64px)] p-5 ${className}`}
    >
      {children}
    </div>
  );
}
