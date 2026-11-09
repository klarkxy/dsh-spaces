import type {
  JobStatus,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchJobErrorInfo,
  WorkbenchJobStep,
  WorkbenchView,
} from "../../../../shared/workbench";
import { isExactRuntimeVersion } from "../../../../shared/runtime";
import { LLM_ERROR, LlmConfigError, type LlmErrorCode } from "../../../../shared/llm-connections";
import { parseWorkbenchProductOutcome } from "../../../../shared/workbench-product-schemas";
import { WORKBENCH_JOB_ERROR, WorkbenchJobError, isJobErrorCode, visibleJobMessage, type WorkbenchJobResult } from "./contract";
import { parseCommand } from "./command";
import { ENTITY_ID_RE, REQUEST_ID_RE, canonicalize, isPlainObject, parseStringArray, sanitizeJobText } from "./util";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const SCHEMA_VERSION = 1;

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
  "subject",
] as const;


export interface StoredJob {
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
  error?: WorkbenchJobErrorInfo;
}


export function publicJob(record: StoredJob): WorkbenchJob {
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
  if (record.command?.kind === "space.create" || record.command?.kind === "creator.create") {
    const input = record.command.kind === "space.create" ? record.command.input : record.command;
    const displayName = sanitizeJobText(
      (typeof input.displayName === "string" && input.displayName.trim()) ||
      (typeof input.name === "string" ? input.name : ""),
    );
    if (displayName) {
      job.subject = { displayName };
      if ((record.status === "queued" || record.status === "running") &&
          typeof input.icon === "string" && input.icon) {
        job.subject.icon = input.icon;
      }
    }
  }
  if (record.error) {
    job.error = publicErrorFromStored(record.error as unknown as Record<string, unknown>);
    if (record.error.spaceId) job.error.spaceId = record.error.spaceId;
    if (record.error.stage) job.error.stage = record.error.stage;
    if (record.error.packageName) job.error.packageName = record.error.packageName;
    if (record.error.pluginAttribution) job.error.pluginAttribution = record.error.pluginAttribution;
    if (record.error.exitCode !== undefined) job.error.exitCode = record.error.exitCode;
    if (record.error.signal !== undefined) job.error.signal = record.error.signal;
  }
  return job;
}

export function publicResult(value: unknown): WorkbenchJobResult | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: WorkbenchJobResult = {};
  if (typeof value.spaceId === "string" && ENTITY_ID_RE.test(value.spaceId)) result.spaceId = value.spaceId;
  if (typeof value.snapshotId === "string" && ENTITY_ID_RE.test(value.snapshotId)) {
    result.snapshotId = value.snapshotId;
  }
  if (typeof value.runtimeVersion === "string" && isExactRuntimeVersion(value.runtimeVersion)) {
    result.runtimeVersion = value.runtimeVersion;
  }
  if (typeof value.dshVersion === "string" && isExactRuntimeVersion(value.dshVersion)) {
    result.dshVersion = value.dshVersion;
  }
  if (value.view !== undefined) {
    const view = publicView(value.view);
    if (view) result.view = view;
  }
  if (value.product !== undefined) {
    try {
      result.product = parseWorkbenchProductOutcome(value.product);
    } catch {
      /* drop unsafe product payloads instead of persisting them */
    }
  }
  const steps = publicSteps(value.steps);
  if (steps) result.steps = steps;
  return result;
}

function parseStrictResult(value: unknown): WorkbenchJobResult | undefined {
  if (!isPlainObject(value)) return undefined;
  const allowed = new Set(["spaceId", "snapshotId", "runtimeVersion", "dshVersion", "view", "product", "steps"]);
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
  if (value.dshVersion !== undefined) {
    if (typeof value.dshVersion !== "string" || !isExactRuntimeVersion(value.dshVersion)) return undefined;
  }
  if (value.view !== undefined && !publicView(value.view)) return undefined;
  if (value.steps !== undefined && !publicSteps(value.steps)) return undefined;
  if (value.product !== undefined) {
    try {
      parseWorkbenchProductOutcome(value.product);
    } catch {
      return undefined;
    }
  }
  return publicResult(value) ?? {};
}

const JOB_STEP_STATUSES = new Set(["done", "failed", "not-run"]);

function publicSteps(value: unknown): WorkbenchJobStep[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const steps: WorkbenchJobStep[] = [];
  for (const row of value) {
    if (!isPlainObject(row)) return undefined;
    if (typeof row.step !== "string" || !row.step.trim() || row.step.length > 40) return undefined;
    if (typeof row.status !== "string" || !JOB_STEP_STATUSES.has(row.status)) return undefined;
    if (row.packageName !== undefined && (typeof row.packageName !== "string" || row.packageName.length > 214)) {
      return undefined;
    }
    if (row.detail !== undefined && (typeof row.detail !== "string" || row.detail.length > 300)) return undefined;
    steps.push({
      step: row.step,
      status: row.status as JobStepStatus,
      ...(typeof row.packageName === "string" ? { packageName: row.packageName } : {}),
      ...(typeof row.detail === "string" ? { detail: row.detail } : {}),
    });
  }
  return steps;
}

type JobStepStatus = WorkbenchJobStep["status"];

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
  if (typeof value.serviceEpoch !== "string" || !/^[a-f0-9]{64}$/.test(value.serviceEpoch)) return undefined;
  return {
    serviceEpoch: value.serviceEpoch,
    spaceId: value.spaceId,
    generation: value.generation,
    origin: value.origin,
    entryOrigin: value.entryOrigin,
    entryPath: value.entryPath,
    channel: value.channel,
  };
}

export function publicErrorFromUnknown(error: unknown): WorkbenchJobErrorInfo {
  if (error instanceof LlmConfigError) {
    return {
      code: error.code,
      message: sanitizeJobText(error.message),
      ...(typeof error.details.spaceId === "string" ? { spaceId: error.details.spaceId, stage: "apply" } : { stage: "apply" }),
    };
  }
  if (error instanceof WorkbenchJobError) {
    const code = isJobErrorCode(error.code) ? error.code : "workbench/failed";
    const info: WorkbenchJobErrorInfo = {
      code,
      message: sanitizeJobText(error.message).trim().slice(0, 500) || WORKBENCH_JOB_ERROR[code] || "The job failed.",
    };
    if (error.context) {
      if (error.context.spaceId) info.spaceId = error.context.spaceId;
      if (error.context.stage) info.stage = error.context.stage;
      if (error.context.packageName) info.packageName = error.context.packageName;
      if (error.context.pluginAttribution) info.pluginAttribution = error.context.pluginAttribution;
      if (error.context.exitCode !== undefined) info.exitCode = error.context.exitCode;
      if (error.context.signal !== undefined) info.signal = error.context.signal;
    }
    return info;
  }
  if (error && typeof error === "object") {
    const reported = error as { code?: unknown; message?: unknown };
    const code = typeof reported.code === "string" && isJobErrorCode(reported.code) ? reported.code : "workbench/failed";
    if (typeof reported.message === "string" || (typeof reported.code === "string" && isJobErrorCode(reported.code))) {
      return {
        code,
        message: visibleJobMessage(code, typeof reported.message === "string" ? reported.message : ""),
        ...(code === "workbench/failed" ? { pluginAttribution: "unknown" as const } : {}),
      };
    }
  }
  return {
    code: "workbench/failed",
    message: WORKBENCH_JOB_ERROR["workbench/failed"],
    pluginAttribution: "unknown",
  };
}

export function parseStoredJob(value: unknown, filenameId: string): StoredJob | null {
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
    ? publicErrorFromStored(value.error)
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

function publicErrorFromStored(value: Record<string, unknown>): WorkbenchJobErrorInfo {
  const code = typeof value.code === "string" && (isJobErrorCode(value.code) || isLlmErrorCode(value.code))
    ? value.code : "workbench/failed";
  const info: WorkbenchJobErrorInfo = {
    code,
    message: typeof value.message === "string" ? visibleJobMessage(code, value.message) : "The job failed.",
  };
  if (typeof value.spaceId === "string" && ENTITY_ID_RE.test(value.spaceId)) info.spaceId = value.spaceId;
  if (typeof value.stage === "string" && value.stage.trim()) info.stage = value.stage.slice(0, 120);
  if (typeof value.packageName === "string" && value.packageName.trim()) info.packageName = value.packageName.slice(0, 200);
  if (value.pluginAttribution === "known" || value.pluginAttribution === "unknown") {
    info.pluginAttribution = value.pluginAttribution;
  }
  if (typeof value.exitCode === "number" && Number.isInteger(value.exitCode)) info.exitCode = value.exitCode;
  if (typeof value.signal === "string" && value.signal.trim()) info.signal = value.signal.slice(0, 32);
  return info;
}

export function unreadableStub(id: string, phase: string, timestamp: string): StoredJob {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    requestId: id,
    kind: "unknown",
    command: null,
    commandCanonical: null,
    status: "failed",
    phase,
    message: WORKBENCH_JOB_ERROR["workbench/unreadable"],
    affectedSpaceIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    canCancel: false,
    error: {
      code: "workbench/unreadable",
      message: WORKBENCH_JOB_ERROR["workbench/unreadable"],
      pluginAttribution: "unknown",
      stage: phase,
    },
  };
}


function parseStatus(value: unknown): JobStatus | undefined {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return undefined;
}


function isLlmErrorCode(value: string): value is LlmErrorCode {
  return Object.values(LLM_ERROR).some(code => code === value);
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


export function stableRecordJson(record: StoredJob): string {
  return JSON.stringify(record);
}


export function publicJobKeys(): readonly string[] {
  return PUBLIC_JOB_KEYS;
}
