import type { ProfileStatus } from "./types";

export type DiagnosticChannel = "stdout" | "stderr" | "lifecycle";

export const MAX_LOG_ENTRIES = 1000;
export const MAX_LOG_BYTES = 256 * 1024;
export const MAX_BACKUP_BYTES = 1024 * 1024;
export const BACKUP_FILE_PREFIX = "cordis.patch.yml.bak-";

export interface DiagnosticLogEntry {
  at: string;
  channel: DiagnosticChannel;
  text: string;
}

export interface ConfigBackupMeta {
  id: string;
  createdAt: string;
  size: number;
  tooLarge: boolean;
}

export interface BackupPreview extends ConfigBackupMeta {
  content?: string;
}

export interface DiagnosticsSnapshot {
  name: string;
  status: ProfileStatus;
  lastError?: string;
  logs: DiagnosticLogEntry[];
  logError?: string;
  backups: ConfigBackupMeta[];
  canRestore: boolean;
}
