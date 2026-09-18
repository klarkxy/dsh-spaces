import {
  compileManagedCredentialRef,
  compileManagedRouteId,
  credentialRevisionOf,
  isManagedRouteId,
  LLM_ERROR,
  LlmConfigError,
  parseManagedRecordKey,
  type GlobalLlmCatalog,
  type LlmSharedSnapshot,
  type SharedConnection,
  type SharedModelRef,
  type SpaceLlmPolicy,
} from "./llm-connections";

export type ModelChoice = {
  provider: string;
  model: string;
};

export type ResolvedDefaultModel = ModelChoice & {
  source: "session" | "space" | "global" | "composition";
};

export function selectSharedConnections(
  catalog: GlobalLlmCatalog,
  policy: SpaceLlmPolicy,
): SharedConnection[] {
  if (policy.shared.mode === "none") return [];
  const selected =
    policy.shared.mode === "all"
      ? Object.values(catalog.connections)
      : policy.shared.connectionIds.map((id) => {
          const connection = catalog.connections[id];
          if (!connection) {
            throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "policy references an unknown connection", {
              connectionId: id,
            });
          }
          return connection;
        });
  return selected.filter((connection) => connection.enabled);
}

export function snapshotForSpace(
  catalog: GlobalLlmCatalog,
  policy: SpaceLlmPolicy,
  adapterVersion: string,
): LlmSharedSnapshot {
  return {
    catalogRevision: catalog.revision,
    policyRevision: policy.revision,
    connections: selectSharedConnections(catalog, policy),
    defaultModel: catalog.defaultModel,
    adapterVersion,
  };
}

export function compileSharedProviderProfile(connection: SharedConnection): Record<string, unknown> {
  const profile: Record<string, unknown> = {
    ...connection.providerConfig,
    displayName: connection.displayName,
  };
  if (connection.auth.kind === "api-key") {
    const parsed = parseManagedRecordKey(connection.auth.credentialRecordId);
    if (!parsed) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "shared connection has an invalid credential record id");
    }
    profile.apiKeyEnv = compileManagedCredentialRef(connection.id, parsed.credentialRevision);
  } else {
    delete profile.apiKeyEnv;
  }
  return profile;
}

export function mergeSharedProvidersIntoBase(
  entry: Record<string, unknown> | undefined,
  connections: readonly SharedConnection[],
): Record<string, unknown> {
  const providers = isPlainObject(entry?.providers) ? { ...entry.providers } : {};
  for (const key of Object.keys(providers)) {
    if (isManagedRouteId(key)) {
      delete providers[key];
    }
  }
  for (const connection of connections) {
    providers[compileManagedRouteId(connection.id)] = compileSharedProviderProfile(connection);
  }
  return { ...entry, providers };
}

export function mergeGlobalDefaultIntoBase(
  entry: Record<string, unknown> | undefined,
  snapshot: LlmSharedSnapshot,
): Record<string, unknown> {
  const available = availableSharedModels(snapshot);
  if (!snapshot.defaultModel || !modelAvailable(snapshot.defaultModel, available)) {
    return { ...entry };
  }
  return {
    ...entry,
    provider: compileManagedRouteId(snapshot.defaultModel.connectionId),
    model: snapshot.defaultModel.modelId,
  };
}

export function availableSharedModels(snapshot: LlmSharedSnapshot): SharedModelRef[] {
  const out: SharedModelRef[] = [];
  for (const connection of snapshot.connections) {
    const models = connection.providerConfig.models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (!isPlainObject(model) || typeof model.id !== "string" || model.id === "") continue;
      out.push({ connectionId: connection.id, modelId: model.id });
    }
  }
  return out;
}

export function resolveDefaultModel(input: {
  session?: ModelChoice | null;
  spaceUser?: ModelChoice | null;
  globalDefault?: SharedModelRef | null;
  composition?: ModelChoice | null;
  available: readonly ModelChoice[];
}): ResolvedDefaultModel {
  if (input.session) {
    assertAvailable(input.session, input.available, "session");
    return { ...input.session, source: "session" };
  }
  if (input.spaceUser) {
    assertAvailable(input.spaceUser, input.available, "space");
    return { ...input.spaceUser, source: "space" };
  }
  if (input.globalDefault) {
    const target = {
      provider: compileManagedRouteId(input.globalDefault.connectionId),
      model: input.globalDefault.modelId,
    };
    if (!choiceAvailable(target, input.available)) {
      throw new LlmConfigError(
        LLM_ERROR.MODEL_NOT_FOUND,
        "global default is not bound in this space; choose a space default",
        { connectionId: input.globalDefault.connectionId, modelId: input.globalDefault.modelId },
      );
    }
    return { ...target, source: "global" };
  }
  if (input.composition) {
    return { ...input.composition, source: "composition" };
  }
  throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "no default model is configured");
}

export function userSectionHasManagedRoutes(section: unknown): boolean {
  if (!isPlainObject(section)) return false;
  const providers = section.providers;
  if (!isPlainObject(providers)) return false;
  return Object.keys(providers).some((key) => isManagedRouteId(key));
}

export function stripManagedRoutesFromUserSection(section: Record<string, unknown>): Record<string, unknown> {
  const providers = isPlainObject(section.providers) ? { ...section.providers } : undefined;
  if (!providers) return { ...section };
  for (const key of Object.keys(providers)) {
    if (isManagedRouteId(key)) delete providers[key];
  }
  return { ...section, providers };
}

export function collectManagedWritePaths(section: unknown): string[] {
  if (!isPlainObject(section)) return [];
  const providers = section.providers;
  if (!isPlainObject(providers)) return [];
  return Object.keys(providers).filter((key) => isManagedRouteId(key));
}

export function snapshotCredentialRef(connection: SharedConnection): string | null {
  const revision = credentialRevisionOf(connection.auth);
  return revision == null ? null : compileManagedCredentialRef(connection.id, revision);
}

function assertAvailable(choice: ModelChoice, available: readonly ModelChoice[], source: string): void {
  if (!choiceAvailable(choice, available)) {
    throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, `${source} model is not available`, {
      provider: choice.provider,
      model: choice.model,
    });
  }
}

function modelAvailable(ref: SharedModelRef, available: readonly SharedModelRef[]): boolean {
  return available.some((item) => item.connectionId === ref.connectionId && item.modelId === ref.modelId);
}

function choiceAvailable(choice: ModelChoice, available: readonly ModelChoice[]): boolean {
  return available.some((item) => item.provider === choice.provider && item.model === choice.model);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
