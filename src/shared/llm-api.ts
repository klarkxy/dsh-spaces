/** Browser-safe global LLM management contract. Never carry secrets, hashes, or credential payloads. */
import type {
  SharedAuth,
  SharedConnection,
  SharedModelRef,
  SharedSelection,
  SpaceLlmPolicy,
} from "../core/domain/llm-connections";
import type { WorkbenchJob, WorkbenchSpace } from "./workbench";

export type RedactedConnection = Omit<SharedConnection, "auth"> & {
  auth: { kind: "none" } | { kind: "api-key"; configured: true };
  routeId: string;
};

export const LLM_API_METHODS = [
  "describe",
  "previewChange",
  "saveConnection",
  "setDefault",
  "previewDelete",
  "deleteConnection",
  "discoverModels",
  "testConnection",
  "spacePolicy",
  "updateSpacePolicy",
  "applyPlan",
  "operationStatus",
] as const;

export type LlmApiMethod = (typeof LLM_API_METHODS)[number];

export const LLM_WRITE_API_METHODS = [
  "saveConnection",
  "setDefault",
  "deleteConnection",
  "discoverModels",
  "testConnection",
  "updateSpacePolicy",
  "applyPlan",
] as const;

export const LLM_CREDENTIAL_METHOD = "saveConnectionWithCredential" as const;

export type LlmConnectionDraft = {
  id?: string;
  displayName: string;
  enabled?: boolean;
  providerConfig: Record<string, unknown>;
  auth: SharedAuth;
};

export type LlmConnectionSecretDraft = Omit<LlmConnectionDraft, "auth">;

export type LlmSpaceObservation = {
  spaceId: string;
  status: WorkbenchSpace["status"];
  generation: number;
  catalogRevision: number | null;
  busy: boolean;
};

export type LlmCapabilities = {
  adapter: "llm-pi-ai";
  adapterVersion: "0.1.5-rc.2";
  protocols: readonly ["openai-completions", "openai-responses", "anthropic-messages"];
  keyless: false;
};

export type LlmDescribeResult = {
  revision: number;
  connections: Array<RedactedConnection & { usedBySpaceIds: string[] }>;
  defaultModel: SharedModelRef | null;
  capabilities: LlmCapabilities;
  pendingRestartSpaceIds: string[];
};

export type LlmChangePreview = {
  catalogRevision: number;
  affectedSpaceIds: string[];
  pendingRestartSpaceIds: string[];
  connectionId: string;
};

export type LlmDeletePreview = {
  connectionId: string;
  references: Array<{ spaceId: string; connectionIds: string[]; mode: SpaceLlmPolicy["shared"]["mode"] }>;
};

export type LlmCatalogResult = {
  revision: number;
  connections: RedactedConnection[];
  defaultModel: SharedModelRef | null;
  connectionId?: string;
};

export type LlmSpacePolicyResult = {
  spaceId: string;
  policy: SpaceLlmPolicy;
  targetCatalogRevision: number;
  runningCatalogRevision: number | null;
  pendingRestart: boolean;
};

export type LlmDiscoverResult = {
  models: Array<{ id: string; name?: string }>;
  truncated: boolean;
  connectionId?: string;
};

export type LlmTestResult = {
  ok: true;
  modelId: string;
  billed: true;
};

export type LlmOperationStatusResult = {
  operationId: string;
  status: "committed" | "not-found" | "unknown";
  catalogRevision?: number;
  connectionId?: string;
  leftoverRecordId?: string;
};

export type LlmApiRequest =
  | { method: "describe" }
  | { method: "previewChange"; draft: LlmConnectionDraft; expectedRevision: number }
  | { method: "saveConnection"; draft: LlmConnectionDraft; expectedRevision: number }
  | { method: "setDefault"; model: SharedModelRef | null; expectedRevision: number }
  | { method: "previewDelete"; connectionId: string }
  | { method: "deleteConnection"; connectionId: string; expectedRevision: number }
  | { method: "discoverModels"; connectionId?: string; draft?: LlmConnectionDraft }
  | { method: "testConnection"; connectionId: string; modelId: string; authorize: true }
  | { method: "spacePolicy"; spaceId: string }
  | { method: "updateSpacePolicy"; spaceId: string; shared: SharedSelection; expectedRevision: number }
  | {
      method: "applyPlan";
      spaceIds: string[];
      catalogRevision: number;
      observations: LlmSpaceObservation[];
      requestId: string;
    }
  | { method: "operationStatus"; operationId: string };

export type LlmCredentialRequest = {
  method: typeof LLM_CREDENTIAL_METHOD;
  draft: LlmConnectionSecretDraft;
  secret: string;
  expectedRevision: number;
  operationId: string;
};

export type LlmApiResult =
  | LlmDescribeResult
  | LlmChangePreview
  | LlmDeletePreview
  | LlmCatalogResult
  | LlmSpacePolicyResult
  | LlmDiscoverResult
  | LlmTestResult
  | LlmOperationStatusResult
  | WorkbenchJob;

export function isLlmWriteMethod(method: string): boolean {
  return (LLM_WRITE_API_METHODS as readonly string[]).includes(method) || method === LLM_CREDENTIAL_METHOD;
}
