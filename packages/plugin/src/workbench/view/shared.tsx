/**
 * Workbench view helpers.
 *
 * The props contract, the redacted-copy helper, the status label mapping and
 * the creation notice live here so that every view module under `view/` can
 * share them without importing the root component back (which would create a
 * cycle).
 */

import React, { type ReactElement, type ReactNode } from "react";
import type { WorkbenchSpace } from "../../../../../src/shared/workbench";
import { t } from "../i18n";
import type { WorkbenchController, WorkbenchUiState } from "../store";

export interface WorkbenchViewProps {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  /** Native chat URL, retained separately from the composable Home surface. */
  homeUrl?: string;
  homeContent?: ReactNode;
  chatActive?: boolean;
  contained?: boolean;
  nativeSurface?: boolean;
  systemPage?: "dashboard" | "settings" | null;
}

/** Copy text to the clipboard without leaking anything the caller did not pass in. */
export function copyRedacted(text: string): void {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) void clipboard.writeText(text);
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
