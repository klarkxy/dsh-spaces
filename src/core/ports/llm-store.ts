import type { ConnectionId, GlobalLlmCatalog, SpaceLlmPolicy } from "../domain/llm-connections";

export interface LlmCatalogStore {
  read(): Promise<GlobalLlmCatalog>;
  write(next: GlobalLlmCatalog, expectedRevision: number): Promise<GlobalLlmCatalog>;
}

export interface LlmPolicyStore {
  read(spaceId: string): Promise<SpaceLlmPolicy>;
  write(spaceId: string, next: SpaceLlmPolicy, expectedRevision: number): Promise<SpaceLlmPolicy>;
}

export interface LlmCredentialWrite {
  recordId: string;
  secret: string;
}

export interface LlmCredentialRecordInfo {
  recordId: string;
  configured: boolean;
  writable: boolean;
  source: "spaces-global";
}

export interface LlmCredentialStore {
  writeRecord(input: LlmCredentialWrite): Promise<LlmCredentialRecordInfo>;
  readSecret(recordId: string): Promise<string | undefined>;
  describe(recordId: string): Promise<LlmCredentialRecordInfo>;
}

export interface SpaceBindingRef {
  spaceId: string;
  connectionIds: ConnectionId[];
  mode: SpaceLlmPolicy["shared"]["mode"];
}
