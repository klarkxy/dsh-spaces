import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { lstatSync } from "../../../shared/node/filesystem";
import { SPACE_ID_RE } from "../../../shared/types";
import { atomicWrite } from "../atomic";

export const CLEAN_STOP_SPACES_FILE = "clean-stop-spaces.json";
const MAX_CLEAN_STOP_BYTES = 64 * 1024;

export interface CleanStopSpacesRecord {
  schemaVersion: 1;
  previousServiceEpoch: string;
  reason: "service-shutdown" | "host-exit" | "signal";
  /** ISO UTC timestamp. */
  recordedAt: string;
  runningSpaceIds: string[];
}

export function writeCleanStopSpaces(controlDir: string, record: CleanStopSpacesRecord): void {
  const stat = lstatSync(controlDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The clean-stop ledger directory is not a real directory.");
  }
  atomicWrite(join(controlDir, CLEAN_STOP_SPACES_FILE), `${JSON.stringify(record)}\n`);
}

export function consumeCleanStopSpaces(controlDir: string): CleanStopSpacesRecord | null {
  const path = join(controlDir, CLEAN_STOP_SPACES_FILE);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("The clean-stop ledger is not a regular file. Original bytes were left unchanged.");
  }
  if (stat.size > MAX_CLEAN_STOP_BYTES) {
    throw new Error("The clean-stop ledger is too large. Original bytes were left unchanged.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("The clean-stop ledger JSON is invalid. Original bytes were left unchanged.");
  }
  const record = validateCleanStopRecord(parsed);
  unlinkSync(path);
  return record;
}

function validateCleanStopRecord(value: unknown): CleanStopSpacesRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.join(",") !== "previousServiceEpoch,reason,recordedAt,runningSpaceIds,schemaVersion") invalid();
  if (row.schemaVersion !== 1) invalid();
  if (typeof row.previousServiceEpoch !== "string" || !row.previousServiceEpoch || typeof row.recordedAt !== "string") invalid();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.recordedAt) || !Number.isFinite(Date.parse(row.recordedAt))) invalid();
  if (row.reason !== "service-shutdown" && row.reason !== "host-exit" && row.reason !== "signal") invalid();
  if (!Array.isArray(row.runningSpaceIds) || row.runningSpaceIds.some((id) => typeof id !== "string" || !SPACE_ID_RE.test(id))) invalid();
  return value as CleanStopSpacesRecord;
}

function invalid(): never {
  throw new Error("The clean-stop ledger schema is invalid. Original bytes were left unchanged.");
}
