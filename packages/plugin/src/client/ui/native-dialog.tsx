import React, { useEffect, useRef, type ReactNode } from "react";

/** Keeps keyboard focus in a confirmation and returns it to the triggering control. */
export function NativeDialog({ label, onCancel, children }: { label: string; onCancel?: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="dsh-native-confirm-backdrop"><section ref={panel} tabIndex={-1} className="dsh-native-confirm" role="dialog" aria-modal="true" aria-label={label}
    onKeyDown={event => {
      if (event.key === "Escape" && onCancel) { event.preventDefault(); onCancel(); }
      if (event.key !== "Tab") return;
      const items = [...panel.current!.querySelectorAll<HTMLElement>("button:not(:disabled),summary,[href],input:not(:disabled),[tabindex='0']")];
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }}>{children}</section></div>;
}
