import type { RestoreSnapshotOptions, SnapshotMeta } from "../../shared/snapshots";
import type { HubSettings } from "../../shared/types";

/** Snapshots taken while the selected runtime was damaged carry data only. */
export function isDataOnlySnapshot(row: SnapshotMeta): boolean {
  return Boolean(row.runtimeMissing);
}

/**
 * Restore normally backs up the current runtime first. When no current runtime
 * resolves, the backup keeps data only — restore must not proceed until the user
 * explicitly acknowledges that. Returns null while the acknowledgement is missing.
 */
export function restoreOptionsFor(
  currentAvailable: boolean,
  dataOnlyAcknowledged: boolean,
): RestoreSnapshotOptions | null | undefined {
  if (currentAvailable) return undefined;
  return dataOnlyAcknowledged ? { allowDataOnlyBackup: true } : null;
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
