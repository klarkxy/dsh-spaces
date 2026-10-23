import type { SpaceSummary, SpacesMode } from "../../../../../src/shared/spaces-control";
import { t, type SpacesLocale, type SpacesMessageKey } from "../i18n";

/**
 * Shared labels of the Spaces panel.
 *
 * The list and the detail pane describe the same space, so the wording lives
 * in one place instead of being repeated per view.
 */

/** Message key of every space mode. */
const MODE_KEY: Record<SpacesMode, SpacesMessageKey> = {
  "verified-full": "mode.verified-full",
  "verified-limited": "mode.verified-limited",
  "unknown-readonly": "mode.unknown-readonly",
  "recovery-only": "mode.recovery-only",
};

/** Message key of every space status. */
const STATUS_KEY: Record<SpaceSummary["status"], SpacesMessageKey> = {
  running: "status.running",
  stopped: "status.stopped",
  unknown: "status.unknown",
};

/** Human label of a verification mode. */
export function modeLabel(locale: SpacesLocale, mode: SpacesMode): string {
  return t(locale, MODE_KEY[mode]);
}

/** Human label of a space status. */
export function statusLabel(locale: SpacesLocale, status: SpaceSummary["status"]): string {
  return t(locale, STATUS_KEY[status]);
}
