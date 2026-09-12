import {
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../main/atomic";
import { isExactRuntimeVersion } from "../../shared/runtime";
import type {
  JobStatus,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchView,
} from "../../shared/workbench";
import { canonicalHome } from "./home-operation-lock";

export const WORKBENCH_CONTROL_DIR_NAME = ".dsh-spaces-control";
export const WORKBENCH_JOBS_DIR_NAME = "jobs";

export const WORKBENCH_JOB_ERROR = {
  "workbench/invalid-input": "The request is not a valid workbench job.",
  "workbench/conflict": "A job with this request id already exists for a different command.",
  "workbench/not-found": "That job was not found.",
  "workbench/not-cancellable": "This job cannot be cancelled in its current phase.",
  "workbench/persist-failed": "The job could not be saved. The operation was not accepted.",
  "workbench/failed": "The job failed.",
  "workbench/recovery-required": "A previous job did not finish and must be recovered.",
} as const;

export type WorkbenchJobErrorCode = keyof typeof WORKBENCH_JOB_ERROR;

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SCHEMA_VERSION = 1;
const PUBLIC_JOB_KEYS = [
  "id",
  "requestId",
  "kind",
  "status",
  "phase",
  "message",
  "affectedSpaceIds",
  "createdAt",
  "updatedAt",
  "canCancel",
  "result",
  "error",
] as const;

export type WorkbenchJobResult = NonNullable<WorkbenchJob["result"]>;
export type WorkbenchJobsInject = (op: string, detail?: string) => void;
export type WorkbenchJobSettleStatus = "succeeded" | "failed" | "cancelled";

export interface WorkbenchJobSettle {
  status: WorkbenchJobSettleStatus;
  result?: WorkbenchJobResult;
  message?: string;
}

export class WorkbenchJobError extends Error {
  readonly name = "WorkbenchJobError";
  constructor(
    readonly code: WorkbenchJobErrorCode,
    message: string = WORKBENCH_JOB_ERROR[code],
  ) {
    super(WORKBENCH_JOB_ERROR[code] || sanitizeJobText(message));
  }
}

export class WorkbenchJobAbortError extends Error {
  readonly name = "AbortError";
  constructor(message = "The job was aborted.") {
    super(message);
  }
}

export interface WorkbenchJobContext {
  readonly signal: AbortSignal;
  phase(phase: string): void;
  message(message: string): void;
  cancellable(value: boolean): void;
  result(value: WorkbenchJobResult): void;
}

export type WorkbenchJobHandler = (context: WorkbenchJobContext) => Promise<WorkbenchJobResult | void>;

export interface WorkbenchJobsOptions {
  home: string;
  /** Test seam for write failures. Not a general filesystem mock. */
  inject?: WorkbenchJobsInject;
  now?: () => Date;
}

interface StoredJob {
  schemaVersion: 1;
  id: string;
  requestId: string;
  kind: string;
  command: WorkbenchCommand | null;
  commandCanonical: string | null;
  status: JobStatus;
  phase: string;
  message: string;
  affectedSpaceIds: string[];
  createdAt: string;
  updatedAt: string;
  canCancel: boolean;
  result?: WorkbenchJobResult;
  error?: { code: string; message: string };
}

/**
 * Combined job store and single-process serial runner.
 *
 * The constructor caller must already hold exclusive run rights for this
 * canonical Home (supervisor / HomeController). This module does not create a
 * process lock and must not contend with HomeController ownership.
 *
 * Leftover queued/running records and unreadable files are marked
 * recovery-required and are not replayed. Runtime submits `recovery.resume`
 * and settles interrupted jobs with `settleRecovery` after checking the
 * real transaction journal.
 */
export class WorkbenchJobStore {
  readonly home: string;
  readonly jobsDir: string;
  private readonly inject?: WorkbenchJobsInject;
  private readonly now: () => Date;
  private readonly records = new Map<string, StoredJob>();
  private readonly persisted = new Map<string, string>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly pendingResults = new Map<string, WorkbenchJobResult>();
  /** Filenames kept as evidence; not overwritten except by settleRecovery. */
  private readonly evidenceOnly = new Set<string>();
  /** Blocks new non-resume work until every recovery-required job is settled. */
  private recoveryHold = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: WorkbenchJobsOptions) {
    this.home = canonicalHome(options.home);
    this.jobsDir = join(this.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME);
    this.inject = options.inject;
    this.now = options.now ?? (() => new Date());
    this.loadFromDisk();
  }

  submit(
    command: WorkbenchCommand,
    requestId: string,
    handler: WorkbenchJobHandler,
  ): Promise<WorkbenchJob> {
    try {
      return Promise.resolve(this.accept(command, requestId, handler));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  job(id: string): WorkbenchJob {
    return publicJob(this.require(id));
  }

  get(id: string): WorkbenchJob {
    return this.job(id);
  }

  list(): WorkbenchJob[] {
    return [...this.records.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(publicJob);
  }

  cancel(id: string): Promise<WorkbenchJob> {
    try {
      return Promise.resolve(this.cancelSync(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Record the real outcome of an interrupted job after the caller has
   * inspected the transaction journal. Does not replay the original command.
   * Caller must already hold Home run rights.
   */
  settleRecovery(id: string, settlement: WorkbenchJobSettle): Promise<WorkbenchJob> {
    try {
      return Promise.resolve(this.settleRecoverySync(id, settlement));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  whenIdle(): Promise<void> {
    const wait = async (): Promise<void> => {
      let snapshot = this.queue;
      await snapshot;
      while (this.queue !== snapshot) {
        snapshot = this.queue;
        await snapshot;
      }
    };
    return wait();
  }

  private accept(
    command: WorkbenchCommand,
    requestId: string,
    handler: WorkbenchJobHandler,
  ): WorkbenchJob {
    if (typeof handler !== "function") {
      throw new WorkbenchJobError("workbench/invalid-input");
    }
    const id = parseRequestId(requestId);
    const parsed = parseCommand(command);
    const canonical = canonicalize(parsed);
    const existing = this.records.get(id);
    if (existing) {
      if (existing.commandCanonical !== canonical) {
        throw new WorkbenchJobError("workbench/conflict");
      }
      return publicJob(existing);
    }
    if (this.recoveryHold && parsed.kind !== "recovery.resume") {
      throw new WorkbenchJobError("workbench/recovery-required");
    }

    const timestamp = this.isoNow();
    const record: StoredJob = {
      schemaVersion: SCHEMA_VERSION,
      id,
      requestId: id,
      kind: parsed.kind,
      command: parsed,
      commandCanonical: canonical,
      status: "queued",
      phase: "queued",
      message: "",
      affectedSpaceIds: affectedSpaceIds(parsed),
      createdAt: timestamp,
      updatedAt: timestamp,
      canCancel: true,
    };
    this.write(record);
    this.enqueue(() => this.run(id, handler));
    return publicJob(record);
  }

  private cancelSync(id: string): WorkbenchJob {
    const record = this.require(id);
    if (record.status === "queued") {
      this.abandonQueued(record, "");
      return publicJob(this.require(id));
    }
    if (record.status === "running") {
      if (!record.canCancel) {
        throw new WorkbenchJobError("workbench/not-cancellable");
      }
      record.canCancel = false;
      record.updatedAt = this.isoNow();
      this.write(record);
      this.aborts.get(id)?.abort();
      return publicJob(record);
    }
    throw new WorkbenchJobError("workbench/not-cancellable");
  }

  private settleRecoverySync(id: string, settlement: WorkbenchJobSettle): WorkbenchJob {
    const record = this.require(id);
    if (record.status !== "recovery-required") {
      throw new WorkbenchJobError("workbench/invalid-input");
    }
    // An unreadable/unknown record has no transaction identity to settle.
    // Preserve it for doctor/manual recovery rather than manufacturing history.
    if (this.evidenceOnly.has(id) || record.command === null) {
      throw new WorkbenchJobError("workbench/recovery-required");
    }
    if (!isPlainObject(settlement) || !isSettleStatus(settlement.status)) {
      throw new WorkbenchJobError("workbench/invalid-input");
    }
    const extra = Object.keys(settlement).filter((key) => !["status", "result", "message"].includes(key));
    if (extra.length) throw new WorkbenchJobError("workbench/invalid-input");

    let result: WorkbenchJobResult | undefined;
    if (settlement.result !== undefined) {
      result = parseStrictResult(settlement.result);
      if (!result) throw new WorkbenchJobError("workbench/invalid-input");
    }
    const message = settlement.message === undefined ? "" : parseMessage(settlement.message);

    record.status = settlement.status;
    record.phase = settlement.status;
    record.canCancel = false;
    record.updatedAt = this.isoNow();
    record.message = sanitizeJobText(message);
    record.result = undefined;
    record.error = undefined;
    if (settlement.status === "succeeded" && result && Object.keys(result).length) {
      record.result = result;
      if (result.spaceId && !record.affectedSpaceIds.includes(result.spaceId)) {
        record.affectedSpaceIds = [...record.affectedSpaceIds, result.spaceId];
      }
    }
    if (settlement.status === "failed") {
      record.error = {
        code: "workbench/failed",
        message: WORKBENCH_JOB_ERROR["workbench/failed"],
      };
      if (!record.message) record.message = WORKBENCH_JOB_ERROR["workbench/failed"];
    }
    this.evidenceOnly.delete(record.id);
    this.write(record);
    this.releaseHoldIfClear();
    return publicJob(record);
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task, task);
  }

  private async run(id: string, handler: WorkbenchJobHandler): Promise<void> {
    try {
      const record = this.records.get(id);
      if (!record || record.status !== "queued") return;
      if (this.recoveryHold && record.kind !== "recovery.resume") {
        this.abandonQueued(record, "Cancelled because another job needs recovery.");
        return;
      }

      record.status = "running";
      record.phase = record.phase === "queued" ? "running" : record.phase;
      record.canCancel = false;
      record.updatedAt = this.isoNow();
      try {
        this.write(record);
      } catch {
        this.markRecovery(id);
        return;
      }

      const abort = new AbortController();
      this.aborts.set(id, abort);
      const context = this.createContext(id, abort.signal);

      try {
        const returned = await handler(context);
        const current = this.records.get(id);
        if (!current || current.status !== "running") return;
        const result = returned === undefined ? this.pendingResults.get(id) : publicResult(returned);
        current.status = "succeeded";
        current.phase = current.phase === "running" ? "succeeded" : current.phase;
        current.message = sanitizeJobText(current.message);
        current.canCancel = false;
        current.updatedAt = this.isoNow();
        current.error = undefined;
        if (result && Object.keys(result).length) {
          current.result = result;
          if (result.spaceId && !current.affectedSpaceIds.includes(result.spaceId)) {
            current.affectedSpaceIds = [...current.affectedSpaceIds, result.spaceId];
          }
        }
        this.write(current);
      } catch (error) {
        if (error instanceof WorkbenchJobError && error.code === "workbench/persist-failed") {
          this.markRecovery(id);
          return;
        }
        const current = this.records.get(id);
        if (!current || current.status !== "running") return;
        if (isAbortError(error) && abort.signal.aborted) {
          current.status = "cancelled";
          current.phase = "cancelled";
          current.message = sanitizeJobText(current.message);
          current.canCancel = false;
          current.updatedAt = this.isoNow();
          current.result = undefined;
          current.error = undefined;
          this.write(current);
          return;
        }
        current.status = "failed";
        current.phase = current.phase === "running" ? "failed" : current.phase;
        current.canCancel = false;
        current.updatedAt = this.isoNow();
        current.result = undefined;
        current.error = publicErrorFromUnknown(error);
        if (!current.message) current.message = current.error.message;
        this.write(current);
      } finally {
        this.aborts.delete(id);
        this.pendingResults.delete(id);
      }
    } catch (error) {
      if (error instanceof WorkbenchJobError && error.code === "workbench/persist-failed") {
        this.markRecovery(id);
        return;
      }
      this.markRecovery(id);
    }
  }

  private createContext(id: string, signal: AbortSignal): WorkbenchJobContext {
    return {
      signal,
      phase: (phase: string) => {
        this.patch(id, { phase: parsePhase(phase) });
      },
      message: (message: string) => {
        this.patch(id, { message: parseMessage(message) });
      },
      cancellable: (value: boolean) => {
        if (typeof value !== "boolean") {
          throw new WorkbenchJobError("workbench/invalid-input");
        }
        this.patch(id, { canCancel: value });
      },
      result: (value: WorkbenchJobResult) => {
        const current = this.records.get(id);
        if (!current || current.status !== "running") {
          throw new WorkbenchJobError("workbench/invalid-input");
        }
        this.pendingResults.set(id, publicResult(value) ?? {});
      },
    };
  }

  private patch(id: string, patch: Partial<Pick<StoredJob, "phase" | "message" | "canCancel">>): void {
    const record = this.records.get(id);
    if (!record || record.status !== "running") {
      throw new WorkbenchJobError("workbench/invalid-input");
    }
    if (patch.phase !== undefined) record.phase = patch.phase;
    if (patch.message !== undefined) record.message = sanitizeJobText(patch.message);
    if (patch.canCancel !== undefined) record.canCancel = patch.canCancel;
    record.updatedAt = this.isoNow();
    this.write(record);
  }

  private require(id: string): StoredJob {
    const key = parseRequestId(id);
    const record = this.records.get(key);
    if (!record) throw new WorkbenchJobError("workbench/not-found");
    return record;
  }

  private loadFromDisk(): void {
    const names = this.listJobFilenames();
    if (!names) return;
    for (const name of names) {
      const filenameId = name.slice(0, -".json".length);
      const path = join(this.jobsDir, name);
      this.loadOne(path, filenameId);
    }
    if (this.hasUnresolvedRecovery()) this.enterRecoveryHold();
  }

  private listJobFilenames(): string[] | undefined {
    let st;
    try {
      st = lstatSync(this.jobsDir);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw new WorkbenchJobError("workbench/recovery-required");
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new WorkbenchJobError("workbench/recovery-required");
    }
    try {
      return readdirSync(this.jobsDir).filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"));
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw new WorkbenchJobError("workbench/recovery-required");
    }
  }

  private loadOne(path: string, filenameId: string): void {
    let st;
    try {
      st = lstatSync(path);
    } catch (error) {
      if (isEnoent(error)) return;
      this.rememberUnreadable(filenameId, "unknown");
      return;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      this.rememberUnreadable(filenameId, "unknown");
      return;
    }

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (isEnoent(error)) return;
      this.rememberUnreadable(filenameId, "unknown");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.rememberUnreadable(filenameId, "unknown");
      return;
    }

    const record = parseStoredJob(parsed, filenameId);
    if (!record) {
      const phase = isPlainObject(parsed) && typeof parsed.phase === "string" && parsed.phase.trim()
        ? parsed.phase
        : "unknown";
      this.rememberUnreadable(filenameId, phase);
      return;
    }

    this.records.set(record.id, record);
    this.persisted.set(record.id, stableRecordJson(record));
    if (record.status === "queued" || record.status === "running") {
      const phase = record.phase;
      record.status = "recovery-required";
      record.phase = phase;
      record.canCancel = false;
      record.updatedAt = this.isoNow();
      try {
        this.write(record);
      } catch {
        record.status = "recovery-required";
        record.phase = phase;
        record.canCancel = false;
        this.records.set(record.id, record);
      }
    }
  }

  private rememberUnreadable(filenameId: string, phase: string): void {
    const id = this.unreadableId(filenameId);
    if (this.records.has(id)) return;
    const record = recoveryStub(id, phase, this.isoNow());
    this.records.set(id, record);
    this.evidenceOnly.add(id);
  }

  private unreadableId(filenameId: string): string {
    if (REQUEST_ID_RE.test(filenameId) && !this.records.has(filenameId)) return filenameId;
    let n = 1;
    while (this.records.has(`unreadable-${n}`) || this.jobFileExists(`unreadable-${n}`)) n += 1;
    return `unreadable-${n}`;
  }

  private jobFileExists(id: string): boolean {
    try {
      lstatSync(join(this.jobsDir, `${id}.json`));
      return true;
    } catch (error) {
      return !isEnoent(error);
    }
  }

  private write(record: StoredJob): void {
    if (this.evidenceOnly.has(record.id)) {
      throw new WorkbenchJobError("workbench/persist-failed");
    }
    try {
      this.inject?.("write", record.id);
      atomicWrite(join(this.jobsDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
      this.persisted.set(record.id, stableRecordJson(record));
      this.records.set(record.id, record);
    } catch (error) {
      if (error instanceof WorkbenchJobError) throw error;
      const snapshot = this.persisted.get(record.id);
      if (snapshot) this.records.set(record.id, JSON.parse(snapshot) as StoredJob);
      else this.records.delete(record.id);
      throw new WorkbenchJobError("workbench/persist-failed");
    }
  }

  private markRecovery(id: string): void {
    const persistedJson = this.persisted.get(id);
    const record = persistedJson
      ? (JSON.parse(persistedJson) as StoredJob)
      : this.records.get(id);
    if (!record) return;
    const phase = record.phase;
    record.status = "recovery-required";
    record.phase = phase;
    record.canCancel = false;
    record.updatedAt = this.isoNow();
    this.records.set(id, record);
    if (!this.evidenceOnly.has(id)) {
      try {
        this.inject?.("write", record.id);
        atomicWrite(join(this.jobsDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
        this.persisted.set(record.id, stableRecordJson(record));
      } catch {
        // Keep the in-memory recovery mark. Public APIs still must not claim success.
      }
    }
    this.enterRecoveryHold();
  }

  private enterRecoveryHold(): void {
    this.recoveryHold = true;
    for (const record of [...this.records.values()]) {
      if (record.status !== "queued") continue;
      if (record.kind === "recovery.resume") continue;
      this.abandonQueued(record, "Cancelled because another job needs recovery.");
    }
  }

  private abandonQueued(record: StoredJob, message: string): void {
    record.status = "cancelled";
    record.phase = "cancelled";
    record.canCancel = false;
    record.updatedAt = this.isoNow();
    if (message) record.message = message;
    try {
      this.write(record);
    } catch {
      const current = this.records.get(record.id) ?? record;
      current.status = "cancelled";
      current.phase = "cancelled";
      current.canCancel = false;
      current.updatedAt = this.isoNow();
      if (message) current.message = message;
      this.records.set(record.id, current);
    }
  }

  private hasUnresolvedRecovery(): boolean {
    for (const record of this.records.values()) {
      if (record.status === "recovery-required") return true;
    }
    return false;
  }

  private releaseHoldIfClear(): void {
    if (this.hasUnresolvedRecovery()) return;
    this.recoveryHold = false;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

function publicJob(record: StoredJob): WorkbenchJob {
  const job: WorkbenchJob = {
    id: record.id,
    requestId: record.requestId,
    kind: record.kind,
    status: record.status,
    phase: record.phase,
    message: sanitizeJobText(record.message),
    affectedSpaceIds: [...record.affectedSpaceIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    canCancel: record.canCancel,
  };
  if (record.result) job.result = publicResult(record.result);
  if (record.error) {
    const code = isJobErrorCode(record.error.code) ? record.error.code : "workbench/failed";
    job.error = { code, message: WORKBENCH_JOB_ERROR[code] };
  }
  return job;
}

function publicResult(value: unknown): WorkbenchJobResult | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: WorkbenchJobResult = {};
  if (typeof value.spaceId === "string" && ENTITY_ID_RE.test(value.spaceId)) result.spaceId = value.spaceId;
  if (typeof value.snapshotId === "string" && ENTITY_ID_RE.test(value.snapshotId)) {
    result.snapshotId = value.snapshotId;
  }
  if (typeof value.runtimeVersion === "string" && isExactRuntimeVersion(value.runtimeVersion)) {
    result.runtimeVersion = value.runtimeVersion;
  }
  if (value.view !== undefined) {
    const view = publicView(value.view);
    if (view) result.view = view;
  }
  return result;
}

function parseStrictResult(value: unknown): WorkbenchJobResult | undefined {
  if (!isPlainObject(value)) return undefined;
  const allowed = new Set(["spaceId", "snapshotId", "runtimeVersion", "view"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (value.spaceId !== undefined && (typeof value.spaceId !== "string" || !ENTITY_ID_RE.test(value.spaceId))) {
    return undefined;
  }
  if (value.snapshotId !== undefined && (typeof value.snapshotId !== "string" || !ENTITY_ID_RE.test(value.snapshotId))) {
    return undefined;
  }
  if (value.runtimeVersion !== undefined) {
    if (typeof value.runtimeVersion !== "string" || !isExactRuntimeVersion(value.runtimeVersion)) return undefined;
  }
  if (value.view !== undefined && !publicView(value.view)) return undefined;
  return publicResult(value) ?? {};
}

function publicView(value: unknown): WorkbenchView | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.spaceId !== "string" || !ENTITY_ID_RE.test(value.spaceId)) return undefined;
  if (typeof value.generation !== "number" || !Number.isInteger(value.generation) || value.generation < 0) {
    return undefined;
  }
  if (typeof value.origin !== "string" || !isLoopbackOrigin(value.origin)) return undefined;
  if (typeof value.entryOrigin !== "string" || !isLoopbackOrigin(value.entryOrigin)) return undefined;
  if (typeof value.entryPath !== "string" || !isSupervisorEntryPath(value.entryPath)) return undefined;
  if (typeof value.channel !== "string" || !ENTITY_ID_RE.test(value.channel)) return undefined;
  return {
    spaceId: value.spaceId,
    generation: value.generation,
    origin: value.origin,
    entryOrigin: value.entryOrigin,
    entryPath: value.entryPath,
    channel: value.channel,
  };
}

function publicErrorFromUnknown(error: unknown): { code: string; message: string } {
  if (error instanceof WorkbenchJobError) {
    return { code: error.code, message: WORKBENCH_JOB_ERROR[error.code] };
  }
  return {
    code: "workbench/failed",
    message: WORKBENCH_JOB_ERROR["workbench/failed"],
  };
}

function parseStoredJob(value: unknown, filenameId: string): StoredJob | null {
  if (!REQUEST_ID_RE.test(filenameId) || !isPlainObject(value)) return null;
  if (value.schemaVersion !== SCHEMA_VERSION) return null;
  if (value.id !== filenameId || value.requestId !== filenameId) return null;
  if (typeof value.kind !== "string" || !value.kind.trim()) return null;
  if (typeof value.status !== "string") return null;
  const status = parseStatus(value.status);
  if (!status) return null;
  if (typeof value.phase !== "string" || !value.phase.trim() || value.phase.length > 120) return null;
  if (typeof value.message !== "string" || value.message.length > 2000) return null;
  if (typeof value.canCancel !== "boolean") return null;
  if (typeof value.createdAt !== "string" || !ISO_DATE_RE.test(value.createdAt)) return null;
  if (typeof value.updatedAt !== "string" || !ISO_DATE_RE.test(value.updatedAt)) return null;
  const spaceIds = parseStringArray(value.affectedSpaceIds);
  if (!spaceIds || spaceIds.some((item) => !ENTITY_ID_RE.test(item))) return null;

  let command: WorkbenchCommand;
  try {
    command = parseCommand(value.command);
  } catch {
    return null;
  }
  if (command.kind !== value.kind) return null;

  if (value.result !== undefined && parseStrictResult(value.result) === undefined) return null;
  if (value.error !== undefined) {
    if (!isPlainObject(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
      return null;
    }
  }
  if (status === "succeeded" && value.error !== undefined) return null;
  if (status === "failed" && value.error === undefined) return null;
  if (status === "cancelled" && (value.result !== undefined || value.error !== undefined)) return null;

  const result = value.result !== undefined ? publicResult(value.result) : undefined;
  const error = isPlainObject(value.error) && typeof value.error.code === "string"
    ? {
        code: isJobErrorCode(value.error.code) ? value.error.code : "workbench/failed",
        message: WORKBENCH_JOB_ERROR[isJobErrorCode(value.error.code) ? value.error.code : "workbench/failed"],
      }
    : undefined;

  return {
    schemaVersion: SCHEMA_VERSION,
    id: filenameId,
    requestId: filenameId,
    kind: command.kind,
    command,
    commandCanonical: canonicalize(command),
    status,
    phase: value.phase,
    message: value.message,
    affectedSpaceIds: spaceIds,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    canCancel: status === "queued" || status === "running" ? value.canCancel : false,
    result,
    error,
  };
}

function recoveryStub(id: string, phase: string, timestamp: string): StoredJob {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    requestId: id,
    kind: "unknown",
    command: null,
    commandCanonical: null,
    status: "recovery-required",
    phase,
    message: "",
    affectedSpaceIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    canCancel: false,
  };
}

function parseCommand(input: unknown): WorkbenchCommand {
  if (!isPlainObject(input)) throw new WorkbenchJobError("workbench/invalid-input");
  const kind = input.kind;
  switch (kind) {
    case "space.create": {
      expectKeys(input, ["kind", "input"]);
      return { kind, input: parseCreateInput(input.input) };
    }
    case "space.update": {
      expectKeys(input, ["kind", "spaceId"], ["displayName", "icon"]);
      return {
        kind,
        spaceId: parseEntityId(input.spaceId),
        ...(input.displayName !== undefined ? { displayName: parseOptionalString(input.displayName) } : {}),
        ...(input.icon !== undefined ? { icon: parseOptionalString(input.icon) } : {}),
      };
    }
    case "space.reorder": {
      expectKeys(input, ["kind", "spaceIds"]);
      const spaceIds = parseStringArray(input.spaceIds);
      if (!spaceIds) throw new WorkbenchJobError("workbench/invalid-input");
      for (const spaceId of spaceIds) parseEntityId(spaceId);
      return { kind, spaceIds };
    }
    case "space.start":
    case "space.verify": {
      expectKeys(input, ["kind", "spaceId"]);
      return { kind, spaceId: parseEntityId(input.spaceId) };
    }
    case "plan.execute": {
      expectKeys(input, ["kind", "planId"]);
      return { kind, planId: parseEntityId(input.planId) };
    }
    case "controller.acquire":
    case "recovery.resume": {
      expectKeys(input, ["kind"]);
      return { kind };
    }
    default:
      throw new WorkbenchJobError("workbench/invalid-input");
  }
}

function parseCreateInput(input: unknown): { name: string; displayName?: string; icon?: string } {
  if (!isPlainObject(input)) throw new WorkbenchJobError("workbench/invalid-input");
  expectKeys(input, ["name"], ["displayName", "icon"]);
  const name = parseOptionalString(input.name);
  if (!name) throw new WorkbenchJobError("workbench/invalid-input");
  const parsed: { name: string; displayName?: string; icon?: string } = { name };
  if (input.displayName !== undefined) parsed.displayName = parseOptionalString(input.displayName);
  if (input.icon !== undefined) parsed.icon = parseOptionalString(input.icon);
  return parsed;
}

function parseRequestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID_RE.test(value)) {
    throw new WorkbenchJobError("workbench/invalid-input");
  }
  return value;
}

function parseEntityId(value: unknown): string {
  if (typeof value !== "string" || !ENTITY_ID_RE.test(value)) {
    throw new WorkbenchJobError("workbench/invalid-input");
  }
  return value;
}

function parseOptionalString(value: unknown): string {
  if (typeof value !== "string") throw new WorkbenchJobError("workbench/invalid-input");
  return value;
}

function parsePhase(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    throw new WorkbenchJobError("workbench/invalid-input");
  }
  return value;
}

function parseMessage(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) {
    throw new WorkbenchJobError("workbench/invalid-input");
  }
  return value;
}

function parseStatus(value: unknown): JobStatus | undefined {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "recovery-required"
  ) {
    return value;
  }
  return undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return [...value];
}

function expectKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new WorkbenchJobError("workbench/invalid-input");
  }
  for (const key of required) {
    if (!(key in value)) throw new WorkbenchJobError("workbench/invalid-input");
  }
}

function affectedSpaceIds(command: WorkbenchCommand): string[] {
  switch (command.kind) {
    case "space.update":
    case "space.start":
    case "space.verify":
      return [command.spaceId];
    case "space.reorder":
      return [...command.spaceIds];
    case "space.create":
    case "plan.execute":
    case "controller.acquire":
    case "recovery.resume":
      return [];
  }
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name: unknown }).name === "AbortError",
  );
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}

function isSettleStatus(value: unknown): value is WorkbenchJobSettleStatus {
  return value === "succeeded" || value === "failed" || value === "cancelled";
}

function isJobErrorCode(value: string): value is WorkbenchJobErrorCode {
  return Object.prototype.hasOwnProperty.call(WORKBENCH_JOB_ERROR, value);
}

function isLoopbackOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.hostname !== "127.0.0.1") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  if (url.port === "") return false;
  return value === `http://127.0.0.1:${url.port}`;
}

function isSupervisorEntryPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || value.includes("://") || value.includes("..")) return false;
  let url: URL;
  try {
    url = new URL(value, "http://127.0.0.1");
  } catch {
    return false;
  }
  if (url.origin !== "http://127.0.0.1") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  return value === url.pathname;
}

function stableRecordJson(record: StoredJob): string {
  return JSON.stringify(record);
}

export function sanitizeJobText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\b(authorization|cookie|set-cookie|token)\s*[:=]\s*[^\s;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/file:\/+[^\s"'\\]+/gi, "[path]")
    .replace(/\b[A-Za-z]:\\[^\s"'`]+/g, "[path]")
    .replace(/\\\\[^\s"'`]+/g, "[path]")
    .replace(/(?:^|[\s"'`(])(\/(?:[\w.+-]+\/)+[\w.+-]+)/g, (full, path: string) =>
      full.replace(path, "[path]"),
    );
}

export function publicJobKeys(): readonly string[] {
  return PUBLIC_JOB_KEYS;
}
