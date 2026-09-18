import type { ConnectionId } from "../domain/llm-connections";
import type { LlmLocalCandidate, LlmSpaceObservation } from "../../shared/llm-api";

export type LlmInstanceRecord = LlmSpaceObservation & {
  policyRevision: number | null;
};

export interface LlmInstanceStatusPort {
  list(): Promise<LlmInstanceRecord[]>;
  get(spaceId: string): Promise<LlmInstanceRecord | undefined>;
  markApplied(spaceId: string, catalogRevision: number): Promise<void>;
}

export type LlmOperationRecord = {
  operationId: string;
  status: "committed" | "unknown";
  catalogRevision?: number;
  connectionId?: string;
  leftoverRecordId?: string;
  createdAt: string;
};

export interface LlmOperationStore {
  get(operationId: string): Promise<LlmOperationRecord | undefined>;
  begin(operationId: string): Promise<LlmOperationRecord>;
  commit(
    operationId: string,
    input: { catalogRevision: number; connectionId: ConnectionId },
  ): Promise<LlmOperationRecord>;
  markUnknown(operationId: string, input?: { leftoverRecordId?: string }): Promise<LlmOperationRecord>;
}

export type LlmProbeDiscoverInput = {
  api: string;
  baseURL: string;
  apiKey?: string;
};

export type LlmProbeTestInput = LlmProbeDiscoverInput & {
  modelId: string;
};

export interface LlmProbePort {
  discover(input: LlmProbeDiscoverInput): Promise<{ models: Array<{ id: string; name?: string }>; truncated: boolean }>;
  test(input: LlmProbeTestInput): Promise<{ ok: true; modelId: string }>;
}

export type SpaceDefaultModel = {
  provider: string;
  model: string;
};

export interface LlmSpaceSettingsPort {
  readDefault(spaceId: string): Promise<SpaceDefaultModel | null>;
  writeDefault(spaceId: string, value: SpaceDefaultModel | null): Promise<void>;
  listLocal(spaceId: string): Promise<LlmLocalCandidate[]>;
  readLocalProvider(spaceId: string, routeId: string): Promise<Record<string, unknown>>;
  readCopyableSecret(spaceId: string, routeId: string): Promise<string | undefined>;
}
