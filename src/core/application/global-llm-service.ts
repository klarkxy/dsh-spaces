import {
  LLM_ERROR,
  LlmConfigError,
  compileManagedRouteId,
  createConnectionId,
  emptyCatalog,
  isPinnedProtocol,
  nextCredentialRecordId,
  normalizeConnectionId,
  parseConnection,
  parseManagedRecordKey,
  sanitizeProviderConfig,
  type ConnectionId,
  type GlobalLlmCatalog,
  type SharedAuth,
  type SharedConnection,
  type SharedModelRef,
  type SharedSelection,
  type SpaceLlmPolicy,
} from "../domain/llm-connections";
import { boundConnectionIds, policyBindsConnection } from "../domain/llm-resolution";
import type { LlmCatalogStore, LlmCredentialStore, LlmPolicyStore, SpaceBindingRef } from "../ports/llm-store";

const SECRET_DRAFT_KEYS = ["key", "apiKey", "secret", "credential", "token"] as const;

export type ConnectionDraft = {
  id?: string;
  displayName: string;
  enabled?: boolean;
  providerConfig: Record<string, unknown>;
  auth: SharedAuth;
};

export type ConnectionSecretDraft = Omit<ConnectionDraft, "auth">;

export type RedactedConnection = Omit<SharedConnection, "auth"> & {
  auth: { kind: "none" } | { kind: "api-key"; configured: true };
  routeId: string;
};

export type ChangePreview = {
  catalogRevision: number;
  affectedSpaceIds: string[];
  pendingRestartSpaceIds: string[];
  connectionId: ConnectionId;
};

export type DeletePreview = {
  connectionId: ConnectionId;
  references: SpaceBindingRef[];
};

export class GlobalLlmService {
  constructor(
    private readonly catalogStore: LlmCatalogStore,
    private readonly policyStore: LlmPolicyStore,
    private readonly credentialStore: LlmCredentialStore,
    private readonly listSpaceIds: () => Promise<string[]>,
  ) {}

  async describe(): Promise<{ revision: number; connections: RedactedConnection[]; defaultModel: SharedModelRef | null }> {
    const catalog = await this.catalogStore.read();
    return {
      revision: catalog.revision,
      defaultModel: catalog.defaultModel,
      connections: Object.values(catalog.connections).map(redactConnection),
    };
  }

  async spacePolicy(spaceId: string): Promise<SpaceLlmPolicy> {
    await this.requireKnownSpace(spaceId);
    return this.policyStore.read(spaceId);
  }

  async previewChange(draft: ConnectionDraft, expectedRevision: number): Promise<ChangePreview> {
    assertNoSecretPayload(draft);
    const catalog = await this.requireRevision(expectedRevision);
    const next = this.buildConnection(catalog, draft, { allowNewId: false });
    return {
      catalogRevision: catalog.revision,
      connectionId: next.id,
      affectedSpaceIds: (await this.referencesTo(next.id)).map((item) => item.spaceId),
      pendingRestartSpaceIds: [],
    };
  }

  async saveConnection(draft: ConnectionDraft, expectedRevision: number): Promise<GlobalLlmCatalog> {
    return this.commitConnection(draft, expectedRevision, { allowNewId: false });
  }

  async saveConnectionWithCredential(
    draft: ConnectionSecretDraft,
    secret: string,
    expectedRevision: number,
  ): Promise<GlobalLlmCatalog> {
    assertNoSecretPayload(draft);
    if (typeof secret !== "string" || secret.length === 0) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "saveConnectionWithCredential requires a non-empty secret");
    }
    const catalog = await this.requireRevision(expectedRevision);
    const existing = draft.id ? this.requireExistingConnection(catalog, draft.id) : undefined;
    const id = existing?.id ?? createConnectionId();
    const recordId = nextCredentialRecordId(id, existing?.auth);
    await this.credentialStore.writeRecord({ recordId, secret });
    const info = await this.credentialStore.describe(recordId);
    if (!info.configured) {
      throw new LlmConfigError(LLM_ERROR.CREDENTIAL_WRITE_FAILED, "credential record was not readable after write", {
        leftoverRecordId: recordId,
      });
    }
    try {
      return await this.commitConnection(
        { ...draft, id, auth: { kind: "api-key", credentialRecordId: recordId } },
        expectedRevision,
        { allowNewId: existing == null },
      );
    } catch (error) {
      throw withLeftoverRecord(error, recordId);
    }
  }

  async setDefault(model: SharedModelRef | null, expectedRevision: number): Promise<GlobalLlmCatalog> {
    const catalog = await this.requireRevision(expectedRevision);
    if (model) {
      assertDefaultStillValid(catalog, model);
    }
    return this.catalogStore.write(
      {
        ...catalog,
        defaultModel: model && { connectionId: normalizeConnectionId(model.connectionId), modelId: model.modelId },
        revision: catalog.revision + 1,
      },
      expectedRevision,
    );
  }

  async previewDelete(connectionId: ConnectionId): Promise<DeletePreview> {
    const id = normalizeConnectionId(connectionId);
    return { connectionId: id, references: await this.referencesTo(id) };
  }

  async deleteConnection(connectionId: ConnectionId, expectedRevision: number): Promise<GlobalLlmCatalog> {
    const catalog = await this.requireRevision(expectedRevision);
    const id = normalizeConnectionId(connectionId);
    if (!catalog.connections[id]) {
      throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "connection does not exist", { connectionId: id });
    }
    const references = await this.referencesTo(id);
    if (references.length > 0) {
      throw new LlmConfigError(LLM_ERROR.CONNECTION_IN_USE, "connection is still referenced", {
        connectionId: id,
        count: references.length,
      });
    }
    if (catalog.defaultModel?.connectionId === id) {
      throw new LlmConfigError(LLM_ERROR.CONNECTION_IN_USE, "connection is the global default");
    }
    const connections = { ...catalog.connections };
    delete connections[id];
    return this.catalogStore.write(
      {
        ...catalog,
        connections,
        retiredConnectionIds: [...catalog.retiredConnectionIds, id],
        revision: catalog.revision + 1,
      },
      expectedRevision,
    );
  }

  async updateSpacePolicy(spaceId: string, shared: SharedSelection, expectedRevision: number): Promise<SpaceLlmPolicy> {
    await this.requireKnownSpace(spaceId);
    const catalog = await this.catalogStore.read();
    if (shared.mode === "selected") {
      for (const id of shared.connectionIds) {
        const connection = catalog.connections[normalizeConnectionId(id)];
        if (!connection) {
          throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "policy references an unknown connection", {
            connectionId: id,
          });
        }
      }
    }
    const current = await this.policyStore.read(spaceId);
    return this.policyStore.write(
      spaceId,
      { ...current, shared, revision: current.revision + 1 },
      expectedRevision,
    );
  }

  async referencesTo(connectionId: ConnectionId): Promise<SpaceBindingRef[]> {
    const catalog = await this.catalogStore.read();
    const id = normalizeConnectionId(connectionId);
    const out: SpaceBindingRef[] = [];
    for (const spaceId of await this.listSpaceIds()) {
      const policy = await this.policyStore.read(spaceId);
      if (!policyBindsConnection(policy, id)) continue;
      out.push({
        spaceId,
        connectionIds: boundConnectionIds(catalog, policy),
        mode: policy.shared.mode,
      });
    }
    return out;
  }

  private async commitConnection(
    draft: ConnectionDraft,
    expectedRevision: number,
    options: { allowNewId: boolean },
  ): Promise<GlobalLlmCatalog> {
    assertNoSecretPayload(draft);
    const catalog = await this.requireRevision(expectedRevision);
    const next = this.buildConnection(catalog, draft, options);
    if (next.auth.kind === "api-key") {
      const info = await this.credentialStore.describe(next.auth.credentialRecordId);
      if (!info.configured) {
        throw new LlmConfigError(LLM_ERROR.CREDENTIAL_MISSING, "catalog cannot publish an unreadable credential record", {
          recordId: next.auth.credentialRecordId,
        });
      }
    }
    if (catalog.defaultModel && catalog.defaultModel.connectionId === next.id) {
      assertDefaultStillValid({ ...catalog, connections: { ...catalog.connections, [next.id]: next } }, catalog.defaultModel);
    }
    return this.catalogStore.write(
      {
        ...catalog,
        connections: { ...catalog.connections, [next.id]: next },
        revision: catalog.revision + 1,
      },
      expectedRevision,
    );
  }

  private async requireKnownSpace(spaceId: string): Promise<void> {
    const ids = await this.listSpaceIds();
    if (!ids.includes(spaceId)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "space is not registered in this home", { spaceId });
    }
  }

  private async requireRevision(expectedRevision: number): Promise<GlobalLlmCatalog> {
    const catalog = await this.catalogStore.read();
    if (catalog.revision !== expectedRevision) {
      throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "catalog revision moved", {
        expected: expectedRevision,
        actual: catalog.revision,
      });
    }
    return catalog;
  }

  private requireExistingConnection(catalog: GlobalLlmCatalog, rawId: string): SharedConnection {
    const id = normalizeConnectionId(rawId);
    this.assertNotRetired(catalog, id);
    const existing = catalog.connections[id];
    if (!existing) {
      throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "connection does not exist", { connectionId: id });
    }
    return existing;
  }

  private buildConnection(
    catalog: GlobalLlmCatalog,
    draft: ConnectionDraft,
    options: { allowNewId: boolean },
  ): SharedConnection {
    const now = new Date().toISOString();
    let existing: SharedConnection | undefined;
    let id: ConnectionId;
    if (draft.id) {
      id = normalizeConnectionId(draft.id);
      this.assertNotRetired(catalog, id);
      existing = catalog.connections[id];
      if (!existing && !options.allowNewId) {
        throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "connection does not exist", { connectionId: id });
      }
    } else {
      id = createConnectionId();
      this.assertNotRetired(catalog, id);
    }
    const providerConfig = sanitizeProviderConfig(draft.providerConfig);
    if (typeof providerConfig.api === "string" && !isPinnedProtocol(providerConfig.api)) {
      throw new LlmConfigError(LLM_ERROR.UNSUPPORTED_PROTOCOL, "protocol is not pinned for this runtime", {
        api: String(providerConfig.api),
      });
    }
    if (draft.auth.kind === "api-key" && !parseManagedRecordKey(draft.auth.credentialRecordId)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "saveConnection only accepts a managed credential record id");
    }
    return parseConnection({
      id,
      revision: (existing?.revision ?? 0) + 1,
      displayName: draft.displayName,
      enabled: draft.enabled !== false,
      backend: "llm-pi-ai",
      providerConfig,
      auth: draft.auth,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private assertNotRetired(catalog: GlobalLlmCatalog, id: ConnectionId): void {
    if (catalog.retiredConnectionIds.includes(id)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "retired connection ids cannot be reused", {
        connectionId: id,
      });
    }
  }
}

export function redactConnection(connection: SharedConnection): RedactedConnection {
  return {
    ...connection,
    routeId: compileManagedRouteId(connection.id),
    auth: connection.auth.kind === "none" ? { kind: "none" } : { kind: "api-key", configured: true },
  };
}

export function assertNoSecretPayload(draft: object): void {
  const raw = draft as Record<string, unknown>;
  for (const key of SECRET_DRAFT_KEYS) {
    if (raw[key] != null) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "connection drafts cannot carry secret fields", { field: key });
    }
  }
}

function assertDefaultStillValid(catalog: GlobalLlmCatalog, model: SharedModelRef): void {
  const connection = catalog.connections[normalizeConnectionId(model.connectionId)];
  if (!connection || !connection.enabled) {
    throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "global default must point at an enabled shared connection");
  }
  const models = connection.providerConfig.models;
  const found = Array.isArray(models) && models.some((item) => isRecord(item) && item.id === model.modelId);
  if (!found) {
    throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "global default model is not in the connection catalog", {
      modelId: model.modelId,
    });
  }
}

function withLeftoverRecord(error: unknown, leftoverRecordId: string): LlmConfigError {
  if (error instanceof LlmConfigError) {
    return new LlmConfigError(error.code, error.message, { ...error.details, leftoverRecordId });
  }
  return new LlmConfigError(LLM_ERROR.CREDENTIAL_WRITE_FAILED, "catalog publish failed after credential write", {
    leftoverRecordId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { emptyCatalog };
