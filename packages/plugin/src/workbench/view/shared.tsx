/**
 * Workbench view helpers.
 *
 * The props contract, the copy button, the status label mapping and the
 * creation notice live here so that every view module under `view/` can
 * share them without importing the root component back (which would create a
 * cycle).
 */

import React, { useRef, useState, type ReactElement } from "react";
import type { WorkbenchSpace } from "../../../../../src/shared/workbench";
import { t, type WorkbenchLocale } from "../i18n";
import type { WorkbenchController, WorkbenchUiState } from "../store";

export interface WorkbenchViewProps {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  /** Native Home URL, shown in the workbench Home stage. */
  homeUrl?: string;
  contained?: boolean;
  nativeSurface?: boolean;
  requestServiceStop?: () => void;
  systemPage?: "settings" | null;
}

/**
 * A copy button with inline feedback.
 *
 * A copy never leaks anything the caller did not pass in: the text is a
 * string or a callback evaluated at click time. The result is announced next
 * to the button; a success clears itself, a failure stays readable.
 */
export function CopyButton({
  locale,
  text,
  label,
  disabled,
  className,
}: {
  locale: WorkbenchLocale;
  text: string | (() => string);
  label: string;
  disabled?: boolean;
  className?: string;
}): ReactElement {
  const [status, setStatus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = async (): Promise<void> => {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    const fail = (cause: unknown): void => {
      if (timer.current) clearTimeout(timer.current);
      const reason = cause instanceof Error ? cause.message : String(cause ?? "");
      setStatus(t(locale, "app.copyFailed", { reason: reason || t(locale, "app.unavailable") }));
    };
    if (!clipboard?.writeText) {
      fail(new Error("clipboard"));
      return;
    }
    try {
      await clipboard.writeText(typeof text === "function" ? text() : text);
    } catch (cause) {
      fail(cause);
      return;
    }
    setStatus(t(locale, "app.copied"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), 2000);
  };
  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => void copy()}>
        {label}
      </button>
      {status ? <span role="status">{status}</span> : null}
    </>
  );
}

/** Label key for a space status. */
export function statusKey(status: WorkbenchSpace["status"]): "app.status.running" | "app.status.starting" | "app.status.stopping" | "app.status.stopped" | "app.status.crashed" | "app.status.unknown" {
  if (status === "running") return "app.status.running";
  if (status === "starting") return "app.status.starting";
  if (status === "stopping") return "app.status.stopping";
  if (status === "stopped") return "app.status.stopped";
  if (status === "crashed") return "app.status.crashed";
  return "app.status.unknown";
}

/**
 * The "space created" notice.
 *
 * The inline variant belongs to the native settings page; the banner variant
 * belongs to the stage. Both keep the same classes and attributes so the
 * existing assertions stay valid.
 */
export function CreatedNotice({ ui, controller, inline = false }: WorkbenchViewProps & { inline?: boolean }): ReactElement | null {
  if (!ui.createdNotice) return null;
  return <div className={inline ? "dsh-wb-notice dsh-wb-row" : "dsh-wb-banner"} role="status" data-created={ui.createdNotice.spaceId}>
    {t(ui.locale, "create.done")}
    <button type="button" className="dsh-wb-btn primary" onClick={controller.enterCreated}>{t(ui.locale, "create.enter")}</button>
  </div>;
}
