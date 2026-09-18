import { GlobalLlmHost, type GlobalLlmHostOptions } from "../../core/application/global-llm-host";
import { GlobalLlmService } from "../../core/application/global-llm-service";
import type { LlmInstanceRecord, LlmInstanceStatusPort } from "../../core/ports/llm-runtime";
import { FileLlmCatalogStore } from "./llm-catalog-store";
import { FileLlmCredentialStore } from "./llm-credential-store";
import { FileLlmOperationStore } from "./llm-operation-store";
import { FileLlmPolicyStore } from "./llm-policy-store";
import { OfficialLlmProbe } from "./llm-probe";
import { FileLlmSpaceSettings } from "./llm-space-settings";

export function createHomeLlmHost(
  home: string,
  options: Omit<GlobalLlmHostOptions, "service" | "operations" | "probe" | "readSecret" | "spaceSettings"> & {
    listSpaceIds: () => Promise<string[]>;
    probe?: GlobalLlmHostOptions["probe"];
    spaceSettings?: GlobalLlmHostOptions["spaceSettings"];
  },
): GlobalLlmHost {
  const catalogStore = new FileLlmCatalogStore(home);
  const policyStore = new FileLlmPolicyStore(home);
  const credentialStore = new FileLlmCredentialStore(home);
  const service = new GlobalLlmService(catalogStore, policyStore, credentialStore, options.listSpaceIds);
  return new GlobalLlmHost({
    service,
    operations: new FileLlmOperationStore(home),
    instances: options.instances,
    probe: options.probe ?? new OfficialLlmProbe(),
    spaceSettings: options.spaceSettings ?? new FileLlmSpaceSettings(home),
    assertWritable: options.assertWritable,
    submitApply: options.submitApply,
    readSecret: (recordId) => credentialStore.readSecret(recordId),
  });
}

export class MapLlmInstanceStatus implements LlmInstanceStatusPort {
  constructor(private readonly rows: Map<string, LlmInstanceRecord>) {}

  async list(): Promise<LlmInstanceRecord[]> {
    return [...this.rows.values()];
  }

  async get(spaceId: string): Promise<LlmInstanceRecord | undefined> {
    return this.rows.get(spaceId);
  }

  async markApplied(spaceId: string, catalogRevision: number): Promise<void> {
    const current = this.rows.get(spaceId);
    if (!current) return;
    this.rows.set(spaceId, { ...current, catalogRevision });
  }
}
