import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../main/atomic";
import { LLM_ERROR, LlmConfigError, normalizeConnectionId } from "../../core/domain/llm-connections";
import type { LlmOperationRecord, LlmOperationStore } from "../../core/ports/llm-runtime";
import { withExclusiveDir } from "./llm-file-lock";
import { llmControlDir } from "./llm-paths";

export const LLM_OPERATIONS_FILENAME = "operations.json";
export const LLM_OPERATION_SCHEMA_VERSION = 1;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type OperationFile = {
  schemaVersion: typeof LLM_OPERATION_SCHEMA_VERSION;
  operations: Record<string, LlmOperationRecord>;
};

export function llmOperationsPath(home: string): string {
  return join(llmControlDir(home), LLM_OPERATIONS_FILENAME);
}

export function parseOperationId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID_RE.test(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operation id is not valid");
  }
  return value;
}

export class FileLlmOperationStore implements LlmOperationStore {
  constructor(private readonly home: string) {}

  async get(operationId: string): Promise<LlmOperationRecord | undefined> {
    const id = parseOperationId(operationId);
    return readFile(llmOperationsPath(this.home)).operations[id];
  }

  async begin(operationId: string): Promise<LlmOperationRecord> {
    const id = parseOperationId(operationId);
    return this.mutate((file) => {
      const existing = file.operations[id];
      if (existing) return existing;
      const record: LlmOperationRecord = {
        operationId: id,
        status: "unknown",
        createdAt: new Date().toISOString(),
      };
      file.operations[id] = record;
      return record;
    });
  }

  async commit(
    operationId: string,
    input: { catalogRevision: number; connectionId: string },
  ): Promise<LlmOperationRecord> {
    const id = parseOperationId(operationId);
    return this.mutate((file) => {
      const current = file.operations[id];
      if (!current) {
        throw new LlmConfigError(LLM_ERROR.RESULT_UNKNOWN, "operation record was not started");
      }
      if (current.status === "committed") return current;
      const record: LlmOperationRecord = {
        operationId: id,
        status: "committed",
        catalogRevision: input.catalogRevision,
        connectionId: normalizeConnectionId(input.connectionId),
        createdAt: current.createdAt,
      };
      file.operations[id] = record;
      return record;
    });
  }

  async markUnknown(operationId: string, input: { leftoverRecordId?: string } = {}): Promise<LlmOperationRecord> {
    const id = parseOperationId(operationId);
    return this.mutate((file) => {
      const current = file.operations[id] ?? {
        operationId: id,
        status: "unknown" as const,
        createdAt: new Date().toISOString(),
      };
      if (current.status === "committed") return current;
      const record: LlmOperationRecord = {
        ...current,
        status: "unknown",
        leftoverRecordId: input.leftoverRecordId ?? current.leftoverRecordId,
      };
      file.operations[id] = record;
      return record;
    });
  }

  private mutate(fn: (file: OperationFile) => LlmOperationRecord): LlmOperationRecord {
    const path = llmOperationsPath(this.home);
    return withExclusiveDir(join(llmControlDir(this.home), `${LLM_OPERATIONS_FILENAME}.lock`), () => {
      const file = readFile(path);
      const record = fn(file);
      assertNoSecrets(file);
      atomicWrite(path, `${JSON.stringify(file, null, 2)}\n`);
      return record;
    });
  }
}

function readFile(path: string): OperationFile {
  if (!existsSync(path)) return { schemaVersion: LLM_OPERATION_SCHEMA_VERSION, operations: {} };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operations file is not valid JSON");
  }
  return parseOperationFile(value);
}

function parseOperationFile(value: unknown): OperationFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operations file must be an object");
  }
  const row = value as { schemaVersion?: unknown; operations?: unknown };
  if (row.schemaVersion !== LLM_OPERATION_SCHEMA_VERSION) {
    throw new LlmConfigError(LLM_ERROR.UNSUPPORTED_RUNTIME, "unknown operations schemaVersion");
  }
  if (!row.operations || typeof row.operations !== "object" || Array.isArray(row.operations)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operations map must be an object");
  }
  const operations: Record<string, LlmOperationRecord> = {};
  for (const [key, raw] of Object.entries(row.operations)) {
    const record = parseRecord(raw);
    if (record.operationId !== key) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operation map key must match operation id");
    }
    operations[key] = record;
  }
  return { schemaVersion: LLM_OPERATION_SCHEMA_VERSION, operations };
}

function parseRecord(value: unknown): LlmOperationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operation record must be an object");
  }
  const row = value as Record<string, unknown>;
  const operationId = parseOperationId(row.operationId);
  if (row.status !== "committed" && row.status !== "unknown") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operation status is not valid");
  }
  if (typeof row.createdAt !== "string") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operation createdAt is required");
  }
  const record: LlmOperationRecord = {
    operationId,
    status: row.status,
    createdAt: row.createdAt,
  };
  if (row.catalogRevision !== undefined) {
    if (!Number.isInteger(row.catalogRevision) || Number(row.catalogRevision) < 0) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operation catalogRevision is not valid");
    }
    record.catalogRevision = Number(row.catalogRevision);
  }
  if (row.connectionId !== undefined) {
    if (typeof row.connectionId !== "string") {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operation connectionId is not valid");
    }
    record.connectionId = normalizeConnectionId(row.connectionId);
  }
  if (row.leftoverRecordId !== undefined) {
    if (typeof row.leftoverRecordId !== "string") {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operation leftoverRecordId is not valid");
    }
    record.leftoverRecordId = row.leftoverRecordId;
  }
  assertNoSecrets(record);
  return record;
}

const SECRET_KEYS = new Set(["key", "apiKey", "secret", "credential", "token", "authorization", "hash"]);

function assertNoSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecrets(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "operation records cannot carry secrets");
    }
    assertNoSecrets(nested);
  }
}
