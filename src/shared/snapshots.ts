export const MANAGED_HOME_ENTRIES = [
  "profiles",
  "sessions",
  "storages",
  "hub",
  "settings.yaml",
  "cordis.patch.yml",
] as const;

export type ManagedHomeEntry = (typeof MANAGED_HOME_ENTRIES)[number];

export const EXCLUDED_HOME_FILES = [".credentials.yaml", ".anonymous-user-id"] as const;

export const RESTORE_STAGE_DIR = ".dsh-spaces-restore";

export const SNAPSHOT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SnapshotPresence = Record<ManagedHomeEntry, boolean>;

export interface SnapshotRuntime {
  version: string;
  root: string;
  binRelative: string;
}

export interface SnapshotMeta {
  id: string;
  createdAt: string;
  reason?: string;
  home: string;
  runtimeVersion: string;
  binRelative: string;
  profiles: string[];
  size: number;
  presence: SnapshotPresence;
  /** Data was saved without a usable runtime. Missing field means a complete snapshot. */
  runtimeMissing?: boolean;
}

export interface RestoreSnapshotOptions {
  allowDataOnlyBackup?: boolean;
}

export interface PendingRestore {
  snapshotId: string;
  beforeRestoreId: string;
  runtimeVersion: string;
  binRelative: string;
  startedAt: string;
  /** Workbench plan identity. Absent on legacy desktop restores. */
  planId?: string;
}

export interface RestoreRecoveryReceipt extends PendingRestore {
  schemaVersion: 1;
  outcome: "completed" | "rolled-back";
}

export interface RestoreResult {
  restored: SnapshotMeta;
  beforeRestore: SnapshotMeta;
}

export type RestorePhase = "copying" | "swapping" | "swapped";

export interface RestoreJournal {
  phase: RestorePhase;
  snapshotId: string;
  beforeRestoreId: string;
  originalPresence: SnapshotPresence;
  runtimeVersion: string;
  binRelative: string;
  startedAt: string;
  /** Workbench plan identity. Absent on legacy desktop restores. */
  planId?: string;
}
