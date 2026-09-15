import type { RestoreSnapshotOptions, SnapshotMeta } from "../../shared/snapshots";
import type { HubSettings } from "../../shared/types";

/** Snapshots taken while the selected runtime was damaged carry data only. */
export function isDataOnlySnapshot(row: SnapshotMeta): boolean {
  return Boolean(row.runtimeMissing);
}

/**
 * Snapshot restore is not a product path. Restore options are never offered.
 */
export function restoreOptionsFor(
  _currentAvailable: boolean,
  _dataOnlyAcknowledged: boolean,
): RestoreSnapshotOptions | null | undefined {
  return undefined;
}

/**
 * Serialized key of every field SettingsDialog edits as a draft. When a
 * maintenance action (e.g. snapshot restore) rewrites settings on disk, the key
 * changes and the dialog re-syncs its draft; identical values keep user edits.
 */
export function settingsFormKey(settings: HubSettings): string {
  return JSON.stringify([
    settings.portStart,
    settings.portEnd,
    settings.packageSource,
    settings.locale,
    settings.theme,
    settings.catalogUrl,
  ]);
}
