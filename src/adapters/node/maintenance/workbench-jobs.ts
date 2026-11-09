import { lstatSync } from "../../../shared/node/filesystem";
/** Job records never persist local paths, credentials, blueprint content or raw config. Transient blueprint product responses are not jobs. */
import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../atomic";
import type {
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchJobErrorInfo,
} from "../../../shared/workbench";
import { canonicalHome } from "../home/home-operation-lock";
import {
  INTERRUPTED_JOB_MESSAGE,
  WORKBENCH_CONTROL_DIR_NAME,
  WORKBENCH_JOB_ERROR,
  WORKBENCH_JOBS_DIR_NAME,
  WorkbenchJobError,
  type WorkbenchJobContext,
  type WorkbenchJobErrorCode,
  type WorkbenchJobHandler,
  type WorkbenchJobResult,
  type WorkbenchJobSettle,
  type WorkbenchJobsInject,
  type WorkbenchJobsOptions,
} from "./workbench-jobs/contract";
import { affectedSpaceIds, parseCommand } from "./workbench-jobs/command";
import {
  SCHEMA_VERSION,
  publicErrorFromUnknown,
  publicJob,
  publicResult,
  parseStoredJob,
  stableRecordJson,
  unreadableStub,
  type StoredJob,
} from "./workbench-jobs/record";
import { REQUEST_ID_RE, canonicalize, isPlainObject, sanitizeJobText } from "./workbench-jobs/util";

export {
  WORKBENCH_CONTROL_DIR_NAME,
  WORKBENCH_JOBS_DIR_NAME,
  WORKBENCH_JOB_ERROR,
  INTERRUPTED_JOB_MESSAGE,
  WorkbenchJobError,
  WorkbenchJobAbortError,
} from "./workbench-jobs/contract";
export { publicJobKeys } from "./workbench-jobs/record";
export { sanitizeJobText } from "./workbench-jobs/util";
export type {
  WorkbenchJobErrorCode,
  WorkbenchJobResult,
  WorkbenchJobsInject,
  WorkbenchJobSettleStatus,
  WorkbenchJobSettle,
  WorkbenchJobContext,
  WorkbenchJobHandler,
  WorkbenchJobsOptions,
} from "./workbench-jobs/contract";

type ExclusiveAdmission = { store: WorkbenchJobStore; active: boolean };
/** Per-execution token. ALS store identity alone is not admission: late timer descendants stay bound after the callback ends. */
const exclusiveContext = new AsyncLocalStorage<ExclusiveAdmission>();


/**
 * Combined job store and single-process serial runner.
 *
 * The constructor caller must already hold exclusive run rights for this
 * canonical Home (supervisor / HomeLease). This module does not create a
 * process lock and must not contend with HomeLease ownership.
 *
 * Leftover queued/running records become failed (interrupted, unconfirmed)
 * and are not replayed. Unreadable files stay as original bytes.
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
  /** Filenames kept as evidence; never overwritten. */
  private readonly evidenceOnly = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: WorkbenchJobsOptions) {
    this.home = canonicalHome(options.home);
    this.jobsDir = join(this.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME);
    this.inject = options.inject;
    this.now = options.now ?? (() => new Date());
    this.loadFromDisk();
  }

  private markFailed(id: string, code: WorkbenchJobErrorCode, error?: WorkbenchJobErrorInfo): void {
    const persistedJson = this.persisted.get(id);
    const record = persistedJson
      ? (JSON.parse(persistedJson) as StoredJob)
      : this.records.get(id);
    if (!record) return;
    const phase = record.phase;
    record.status = "failed";
    record.phase = phase === "queued" || phase === "running" ? "failed" : phase;
    record.canCancel = false;
    record.updatedAt = this.isoNow();
    record.error = error ?? {
      code,
      message: WORKBENCH_JOB_ERROR[code] ?? WORKBENCH_JOB_ERROR["workbench/failed"],
    };
    if (!record.message) record.message = record.error.message;
    this.records.set(id, record);
    if (!this.evidenceOnly.has(id)) {
      try {
        this.inject?.("write", record.id);
        atomicWrite(join(this.jobsDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
        this.persisted.set(record.id, stableRecordJson(record));
      } catch {
        // Keep the in-memory failure. Public APIs still must not claim success.
      }
    }
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

  /** Stored parsed command for internal dispatch use; never serialized back out. */
  commandOf(id: string): WorkbenchCommand | null {
    const record = this.records.get(id);
    return record?.command ?? null;
  }

  get(id: string): WorkbenchJob {
    return this.job(id);
  }

  list(): WorkbenchJob[] {
    return [...this.records.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(publicJob);
  }

  hasUnfinishedPlan(planId: string): boolean {
    return [...this.records.values()].some(job =>
      ["queued", "running"].includes(job.status) &&
      job.command?.kind === "plan.execute" && job.command.planId === planId);
  }

  unfinishedPlanIds(): string[] {
    return [...new Set([...this.records.values()].flatMap(job =>
      ["queued", "running"].includes(job.status) && job.command?.kind === "plan.execute"
        ? [job.command.planId] : []))];
  }

  cancel(id: string): Promise<WorkbenchJob> {
    try {
      return Promise.resolve(this.cancelSync(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Recovery settlement is not supported. Interrupted jobs stay failed.
   */
  settleRecovery(_id: string, _settlement: WorkbenchJobSettle): Promise<WorkbenchJob> {
    return Promise.reject(new WorkbenchJobError("workbench/unsupported"));
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

  /** Serialize a direct mutation on the same tail as jobs. Never persist the callback payload. */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.enqueue(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Run inline only while this store's current exclusive/job callback is still
   * active. Detached timer/promise descendants keep the ALS binding after
   * that callback returns, so they must wait on the tail.
   */
  runAdmitted<T>(task: () => Promise<T>): Promise<T> {
    const ctx = exclusiveContext.getStore();
    if (ctx?.store === this && ctx.active) return Promise.resolve().then(task);
    return this.runExclusive(task);
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

  private enqueue(task: () => Promise<void>): void {
    const gated = async (): Promise<void> => {
      const token: ExclusiveAdmission = { store: this, active: true };
      try {
        await exclusiveContext.run(token, task);
      } finally {
        token.active = false;
      }
    };
    this.queue = this.queue.then(gated, gated);
  }

  private async run(id: string, handler: WorkbenchJobHandler): Promise<void> {
    try {
      const record = this.records.get(id);
      if (!record || record.status !== "queued") return;
      record.status = "running";
      record.phase = record.phase === "queued" ? "running" : record.phase;
      record.canCancel = false;
      record.updatedAt = this.isoNow();
      try {
        this.write(record);
      } catch {
        this.markFailed(id, "workbench/persist-failed");
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
        try {
          this.write(current);
        } catch {
          this.markFailed(id, "workbench/persist-failed", {
            code: "workbench/persist-failed",
            message: "The operation ran, but its result could not be saved. Changes may already have happened; the result is unconfirmed.",
          });
        }
      } catch (error) {
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
        const partial = this.pendingResults.get(id);
        current.result = partial && Object.keys(partial).length ? partial : undefined;
        current.error = publicErrorFromUnknown(error);
        if (!current.message) current.message = current.error.message;
        try {
          this.write(current);
        } catch {
          this.markFailed(id, "workbench/persist-failed", {
            ...current.error,
            message: `${current.error.message} The operation ran, but its failure record could not be saved. Changes may already have happened.`,
          });
        }
      } finally {
        this.aborts.delete(id);
        this.pendingResults.delete(id);
      }
    } catch (error) {
      this.markFailed(id, error instanceof WorkbenchJobError ? error.code : "workbench/failed");
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
  }

  private listJobFilenames(): string[] | undefined {
    let st;
    try {
      st = lstatSync(this.jobsDir);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw new WorkbenchJobError("workbench/unreadable");
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new WorkbenchJobError("workbench/unreadable");
    }
    try {
      return readdirSync(this.jobsDir).filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"));
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw new WorkbenchJobError("workbench/unreadable");
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
      record.status = "failed";
      record.phase = phase;
      record.canCancel = false;
      record.updatedAt = this.isoNow();
      record.message = INTERRUPTED_JOB_MESSAGE;
      record.error = {
        code: "workbench/failed",
        message: INTERRUPTED_JOB_MESSAGE,
        pluginAttribution: "unknown",
        stage: phase,
        spaceId: record.affectedSpaceIds[0],
      };
      try {
        this.write(record);
      } catch {
        this.records.set(record.id, record);
      }
    }
  }

  private rememberUnreadable(filenameId: string, phase: string): void {
    const id = this.unreadableId(filenameId);
    if (this.records.has(id)) return;
    const record = unreadableStub(id, phase, this.isoNow());
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
      const cause = error instanceof Error ? error.message : "";
      throw new WorkbenchJobError("workbench/persist-failed", cause || WORKBENCH_JOB_ERROR["workbench/persist-failed"]);
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

  private isoNow(): string {
    return this.now().toISOString();
  }
}


function parseRequestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID_RE.test(value)) {
    throw new WorkbenchJobError("workbench/invalid-input");
  }
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

