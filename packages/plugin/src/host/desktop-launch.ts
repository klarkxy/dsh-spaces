import { randomUUID } from "node:crypto";
import type { WorkbenchStartupFailure } from "../../../../src/shared/workbench-startup";
import type { DesktopLaunchPhase, DesktopLaunchState } from "../types";

/** One in-process launch. Idle is only the read-only view before a record exists. */
export type ActiveDesktopLaunchPhase = Exclude<DesktopLaunchPhase, "idle">;

const BUSY: ReadonlySet<ActiveDesktopLaunchPhase> = new Set([
  "discovering",
  "preparing",
  "launching",
  "starting",
  "connecting",
]);

export interface DesktopLaunchRecord {
  readonly operationId: string;
  readonly homeKey: string;
  readonly done: Promise<void>;
  phase: ActiveDesktopLaunchPhase;
  serviceEpoch: string | null;
  managerId: string | null;
  reasons: string[];
  failure: WorkbenchStartupFailure | null;
  settle: () => void;
}

const records = new Map<string, DesktopLaunchRecord>();

export function readLaunch(homeKey: string): DesktopLaunchRecord | undefined {
  return records.get(homeKey);
}

export function isCurrentLaunch(record: DesktopLaunchRecord): boolean {
  return records.get(record.homeKey) === record;
}

export function launchIsBusy(homeKey: string): boolean {
  const record = records.get(homeKey);
  return record ? BUSY.has(record.phase) : false;
}

/** First call creates the process record. Later calls join it, including after failure or stop. */
export function joinLaunch(homeKey: string): { record: DesktopLaunchRecord; created: boolean } {
  const existing = records.get(homeKey);
  if (existing) return { record: existing, created: false };
  return { record: insertLaunch(homeKey), created: true };
}

/** Only a confirmed manual launch callback may replace a latched record. */
export function replaceLaunch(homeKey: string): DesktopLaunchRecord {
  return insertLaunch(homeKey);
}

export function updateLaunch(record: DesktopLaunchRecord, mutate: (record: DesktopLaunchRecord) => void): boolean {
  if (!isCurrentLaunch(record)) return false;
  mutate(record);
  return true;
}

export function snapshotLaunch(record: DesktopLaunchRecord | undefined): DesktopLaunchState {
  if (!record) {
    return { operationId: null, phase: "idle", serviceEpoch: null, managerId: null, reasons: [], failure: null };
  }
  return {
    operationId: record.operationId,
    phase: record.phase,
    serviceEpoch: record.serviceEpoch,
    managerId: record.managerId,
    reasons: record.reasons.slice(0, 32),
    failure: copyFailure(record.failure),
  };
}

export function copyFailure(failure: WorkbenchStartupFailure | null): WorkbenchStartupFailure | null {
  if (!failure) return null;
  return {
    stage: failure.stage,
    primaryReason: failure.primaryReason,
    ...(failure.cleanupReason ? { cleanupReason: failure.cleanupReason } : {}),
    instanceRetained: failure.instanceRetained === true,
  };
}

function insertLaunch(homeKey: string): DesktopLaunchRecord {
  let settle = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  const record: DesktopLaunchRecord = {
    operationId: randomUUID(),
    homeKey,
    done,
    phase: "discovering",
    serviceEpoch: null,
    managerId: null,
    reasons: [],
    failure: null,
    settle,
  };
  records.set(homeKey, record);
  return record;
}
