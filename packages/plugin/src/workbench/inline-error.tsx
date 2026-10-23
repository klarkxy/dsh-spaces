/**
 * The failure line of one surface.
 *
 * A failure belongs to the control that caused it: it is rendered next to that
 * control instead of in the banner at the top of the settings. The line has no
 * entrance animation, so the reason is readable in the first frame it exists,
 * and it offers no retry or repair.
 */
import React, { type ReactElement } from "react";
import type { WorkbenchUiState } from "./store";

/**
 * The failures of the surface that owns them.
 *
 * The store records which surface started the last command or preview. Only
 * that surface shows the reason; every other surface stays quiet.
 */
export function surfaceErrors(ui: WorkbenchUiState, origin: string): string[] {
  if (ui.requestOrigin !== origin) return [];
  const errors: string[] = [];
  if (ui.commandError) errors.push(ui.commandError);
  if (ui.planError) errors.push(ui.planError);
  return errors;
}

/** One failure line. It carries the origin so a test can tell them apart. */
export function InlineError({ message, origin }: { message: string; origin: string }): ReactElement {
  return (
    <p className="dsh-wb-alert" role="alert" data-inline-error={origin}>
      {message}
    </p>
  );
}

/** The failures of one surface, one line each. */
export function InlineErrors({ ui, origin }: { ui: WorkbenchUiState; origin: string }): ReactElement | null {
  const errors = surfaceErrors(ui, origin);
  if (errors.length === 0) return null;
  return (
    <>
      {errors.map((message) => (
        <InlineError key={message} message={message} origin={origin} />
      ))}
    </>
  );
}
