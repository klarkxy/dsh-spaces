import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../main/atomic";
import {
  LLM_ERROR,
  LlmConfigError,
  emptyCatalog,
  emptyPolicy,
  isRecord,
  parseCatalog,
  parsePolicy,
  type LlmSharedSnapshot,
} from "../../core/domain/llm-connections";
import { snapshotForSpace } from "../../core/domain/llm-resolution";
import { llmCatalogPath, llmControlDir } from "./llm-paths";
import { llmPolicyPath } from "./llm-policy-store";

export const LLM_LAUNCH_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const LLM_SNAPSHOT_ENV = {
  snapshot: "DSH_SPACES_LLM_SNAPSHOT",
  home: "DSH_SPACES_LLM_HOME",
} as const;
export const PINNED_LLM_ADAPTER_VERSION = "0.1.5-rc.2";

export type LlmLaunchSnapshotFile = {
  schemaVersion: typeof LLM_LAUNCH_SNAPSHOT_SCHEMA_VERSION;
  snapshot: LlmSharedSnapshot | null;
};

export function llmSnapshotPath(home: string, spaceId: string): string {
  return join(llmControlDir(home), "snapshots", `${spaceId}.json`);
}

export function readLaunchSnapshotFile(path: string): LlmLaunchSnapshotFile {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm launch snapshot must be an object");
  }
  if (value.schemaVersion !== LLM_LAUNCH_SNAPSHOT_SCHEMA_VERSION) {
    throw new LlmConfigError(LLM_ERROR.UNSUPPORTED_RUNTIME, "unknown llm launch snapshot schemaVersion", {
      schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : String(value.schemaVersion),
    });
  }
  return {
    schemaVersion: LLM_LAUNCH_SNAPSHOT_SCHEMA_VERSION,
    snapshot: value.snapshot == null ? null : (value.snapshot as LlmSharedSnapshot),
  };
}

export function writeSpaceLlmLaunchSnapshot(home: string, spaceId: string): NodeJS.ProcessEnv {
  const catalog = readCatalogSync(home);
  const policy = readPolicySync(home, spaceId);
  if (policy.shared.mode === "none") return {};
  const snapshot = snapshotForSpace(catalog, policy, PINNED_LLM_ADAPTER_VERSION);
  const path = llmSnapshotPath(home, spaceId);
  const file: LlmLaunchSnapshotFile = { schemaVersion: LLM_LAUNCH_SNAPSHOT_SCHEMA_VERSION, snapshot };
  atomicWrite(path, `${JSON.stringify(file)}\n`);
  return {
    [LLM_SNAPSHOT_ENV.snapshot]: path,
    [LLM_SNAPSHOT_ENV.home]: home,
  };
}

function readCatalogSync(home: string) {
  const path = llmCatalogPath(home);
  if (!existsSync(path)) return emptyCatalog();
  return parseCatalog(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function readPolicySync(home: string, spaceId: string) {
  const path = llmPolicyPath(home, spaceId);
  if (!existsSync(path)) return emptyPolicy();
  return parsePolicy(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
