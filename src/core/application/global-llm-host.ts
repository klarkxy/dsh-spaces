import { runBatch } from "../../shared/batch";
import type {
  LlmApiRequest,
  LlmCatalogResult,
  LlmConnectionDraft,
  LlmConnectionSecretDraft,
  LlmCredentialRequest,
  LlmDescribeResult,
  LlmDiscoverResult,
  LlmLocalCandidatesResult,
  LlmOperationStatusResult,
  LlmSpaceDefaultResult,
  LlmSpaceObservation,
  LlmSpacePolicyResult,
} from "../../shared/llm-api";
import {
  isLlmWriteMethod,
  LLM_CREDENTIAL_ADOPT_METHOD,
  LLM_CREDENTIAL_DISCOVER_METHOD,
  LLM_CREDENTIAL_METHOD,
} from "../../shared/llm-api";
import type { WorkbenchCommand, WorkbenchJob } from "../../shared/workbench";
import {
  createConnectionId,
  LLM_ERROR,
  LlmConfigError,
  compileManagedRouteId,
  normalizeConnectionId,
  PINNED_LLM_PI_AI_PROTOCOLS,
  type ConnectionId,
  type SharedModelRef,
} from "../domain/llm-connections";
import { policyBindsConnection } from "../domain/llm-resolution";
import type { LlmInstanceStatusPort, LlmOperationStore, LlmProbePort, LlmSpaceSettingsPort } from "../ports/llm-runtime";
import {
  assertNoSecretPayload,
  GlobalLlmService,
  redactConnection,
  type ConnectionDraft,
} from "./global-llm-service";

export const LLM_CAPABILITIES = {
  adapter: "llm-pi-ai",
  adapterVersion: "0.1.5-rc.2",
  protocols: PINNED_LLM_PI_AI_PROTOCOLS,
  keyless: false,
} as const;

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SPACE_ID_RE = /^(?:web|[a-z0-9][a-z0-9-]{0,38})$/;

export type LlmApplyCommand = Extract<WorkbenchCommand, { kind: "llm.apply" }>;

export type GlobalLlmHostOptions = {
  service: GlobalLlmService;
  operations: LlmOperationStore;
  instances: LlmInstanceStatusPort;
  probe: LlmProbePort;
  spaceSettings: LlmSpaceSettingsPort;
  assertWritable: () => void;
  submitApply: (command: LlmApplyCommand, requestId: string) => Promise<WorkbenchJob>;
  readSecret: (recordId: string) => Promise<string | undefined>;
};

export class GlobalLlmHost {
  constructor(private readonly options: GlobalLlmHostOptions) {}

  async catalogRevision(): Promise<number> {
    return (await this.options.service.describe()).revision;
  }

  async dispatch(payload: unknown): Promise<unknown> {
    const request = parseLlmApiRequest(payload);
    if (isLlmWriteMethod(request.method)) this.options.assertWritable();
    switch (request.method) {
      case "describe":
        return this.describe();
      case "previewChange":
        return this.previewChange(request.draft, request.expectedRevision);
      case "saveConnection":
        return this.saveConnection(request.draft, request.expectedRevision);
      case "setDefault":
        return this.setDefault(request.model, request.expectedRevision);
      case "previewDelete":
        return this.options.service.previewDelete(request.connectionId);
      case "deleteConnection":
        return this.catalogResult(
          await this.options.service.deleteConnection(request.connectionId, request.expectedRevision),
          request.connectionId,
        );
      case "discoverModels":
        return this.discoverModels(request.connectionId, request.draft);
      case "testConnection":
        return this.testConnection(request.connectionId, request.modelId);
      case "spacePolicy":
        return this.spacePolicy(request.spaceId);
      case "updateSpacePolicy":
        await this.options.service.updateSpacePolicy(request.spaceId, request.shared, request.expectedRevision);
        return this.spacePolicy(request.spaceId);
      case "spaceDefault":
        return this.spaceDefault(request.spaceId);
      case "updateSpaceDefault":
        this.options.assertWritable();
        return this.updateSpaceDefault(request.spaceId, request.model);
      case "listLocalCandidates":
        return this.listLocalCandidates(request.spaceId);
      case "adoptLocal":
        return this.adoptLocal(request.spaceId, request.routeId, request.displayName, request.expectedRevision, {
          copyCredential: true,
        });
      case "applyPlan":
        return this.applyPlan(request);
      case "operationStatus":
        return this.operationStatus(request.operationId);
    }
  }

  async dispatchCredential(payload: unknown): Promise<unknown> {
    const request = parseCredentialRequest(payload);
    this.options.assertWritable();
    if (request.method === LLM_CREDENTIAL_DISCOVER_METHOD) {
      return this.discoverModelsWithSecret(request.draft, request.secret);
    }
    if (request.method === LLM_CREDENTIAL_ADOPT_METHOD) {
      return this.adoptLocal(request.spaceId, request.routeId, request.displayName, request.expectedRevision, {
        secret: request.secret,
        operationId: request.operationId,
      });
    }
    return this.saveConnectionWithCredential(request);
  }

  async describe(): Promise<LlmDescribeResult> {
    const catalog = await this.options.service.describe();
    const pendingRestartSpaceIds = await this.pendingRestartSpaceIds();
    const connections = [];
    for (const connection of catalog.connections) {
      connections.push({
        ...connection,
        usedBySpaceIds: (await this.options.service.referencesTo(connection.id)).map((item) => item.spaceId),
      });
    }
    return {
      revision: catalog.revision,
      connections,
      defaultModel: catalog.defaultModel,
      capabilities: LLM_CAPABILITIES,
      pendingRestartSpaceIds,
    };
  }

  async previewChange(draft: LlmConnectionDraft, expectedRevision: number) {
    const preview = await this.options.service.previewChange(asServiceDraft(draft), expectedRevision);
    return {
      ...preview,
      pendingRestartSpaceIds: await this.pendingRestartSpaceIds(preview.connectionId),
    };
  }

  async saveConnection(draft: LlmConnectionDraft, expectedRevision: number): Promise<LlmCatalogResult> {
    const catalog = await this.options.service.saveConnection(asServiceDraft(draft), expectedRevision);
    return this.catalogResult(catalog, draft.id);
  }

  async setDefault(model: SharedModelRef | null, expectedRevision: number): Promise<LlmCatalogResult> {
    const catalog = await this.options.service.setDefault(model, expectedRevision);
    return this.catalogResult(catalog, model?.connectionId);
  }

  async saveConnectionWithCredential(
    request: Extract<LlmCredentialRequest, { method: typeof LLM_CREDENTIAL_METHOD }>,
  ): Promise<LlmCatalogResult> {
    assertNoSecretPayload(request.draft);
    const existing = await this.options.operations.get(request.operationId);
    if (existing?.status === "committed") {
      const catalog = await this.options.service.describe();
      return {
        revision: catalog.revision,
        connections: catalog.connections,
        defaultModel: catalog.defaultModel,
        connectionId: existing.connectionId,
      };
    }
    if (existing?.status === "unknown") {
      throw new LlmConfigError(LLM_ERROR.RESULT_UNKNOWN, "this operation already started; it was not replayed", {
        operationId: request.operationId,
      });
    }
    await this.options.operations.begin(request.operationId);
    const draftId = request.draft.id ?? createConnectionId();
    try {
      const catalog = await this.options.service.saveConnectionWithCredential(
        { ...request.draft, id: draftId },
        request.secret,
        request.expectedRevision,
      );
      await this.options.operations.commit(request.operationId, {
        catalogRevision: catalog.revision,
        connectionId: draftId,
      });
      return this.catalogResult(catalog, draftId);
    } catch (error) {
      const leftover =
        error instanceof LlmConfigError && typeof error.details.leftoverRecordId === "string"
          ? error.details.leftoverRecordId
          : undefined;
      await this.options.operations.markUnknown(request.operationId, leftover ? { leftoverRecordId: leftover } : {});
      throw error;
    }
  }

  async operationStatus(operationId: string): Promise<LlmOperationStatusResult> {
    const record = await this.options.operations.get(operationId);
    if (!record) return { operationId, status: "not-found" };
    return {
      operationId: record.operationId,
      status: record.status,
      ...(record.catalogRevision !== undefined ? { catalogRevision: record.catalogRevision } : {}),
      ...(record.connectionId ? { connectionId: record.connectionId } : {}),
      ...(record.leftoverRecordId ? { leftoverRecordId: record.leftoverRecordId } : {}),
    };
  }

  async applyPlan(request: Extract<LlmApiRequest, { method: "applyPlan" }>): Promise<WorkbenchJob> {
    await this.assertApplyReady(request.spaceIds, request.catalogRevision, request.observations);
    return this.options.submitApply(
      {
        kind: "llm.apply",
        spaceIds: request.spaceIds,
        catalogRevision: request.catalogRevision,
        observations: request.observations,
      },
      request.requestId,
    );
  }

  async executeApply(command: LlmApplyCommand, restart: (spaceId: string) => Promise<void>): Promise<void> {
    const catalog = await this.options.service.describe();
    if (catalog.revision !== command.catalogRevision) {
      throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "catalog revision moved before apply", {
        expected: command.catalogRevision,
        actual: catalog.revision,
      });
    }
    const result = await runBatch(command.spaceIds, async (spaceId) => {
      const current = await this.requireKnownIdle(spaceId);
      if (current.status === "stopped" || current.status === "crashed") {
        await this.options.instances.markApplied(spaceId, command.catalogRevision);
        return;
      }
      await restart(spaceId);
      await this.options.instances.markApplied(spaceId, command.catalogRevision);
    });
    if (result.failed) {
      throw new LlmConfigError(LLM_ERROR.APPLY_FAILED, result.failed.error, {
        spaceId: result.failed.item,
        succeeded: result.succeeded.length,
        skipped: result.skipped.length,
      });
    }
  }

  private async discoverModels(connectionId: string | undefined, draft: LlmConnectionDraft | undefined): Promise<LlmDiscoverResult> {
    const resolved = await this.resolveProbeTarget(connectionId, draft);
    const result = await this.options.probe.discover(resolved);
    return {
      ...result,
      ...(resolved.connectionId ? { connectionId: resolved.connectionId } : {}),
    };
  }

  private async testConnection(connectionId: string, modelId: string) {
    const resolved = await this.resolveProbeTarget(connectionId, undefined);
    const listed = resolved.models;
    if (listed && !listed.includes(modelId)) {
      throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "model is not in the saved connection catalog", { modelId });
    }
    await this.options.probe.test({ ...resolved, modelId });
    return { ok: true as const, modelId, billed: true as const };
  }

  private async spaceDefault(spaceId: string): Promise<LlmSpaceDefaultResult> {
    await this.options.service.spacePolicy(spaceId);
    const catalog = await this.options.service.readCatalog();
    const local = await this.options.spaceSettings.readDefault(spaceId);
    const global = catalog.defaultModel;
    if (local) {
      return {
        spaceId,
        source: "local",
        inheritGlobal: false,
        local,
        global,
        effective: { provider: local.provider, model: local.model, origin: "local" },
      };
    }
    if (global) {
      const policy = await this.options.service.spacePolicy(spaceId);
      if (policyBindsConnection(policy, global.connectionId)) {
        return {
          spaceId,
          source: "global",
          inheritGlobal: true,
          local: null,
          global,
          effective: {
            provider: compileManagedRouteId(global.connectionId),
            model: global.modelId,
            origin: "global",
          },
        };
      }
    }
    return { spaceId, source: "none", inheritGlobal: true, local: null, global, effective: null };
  }

  private async updateSpaceDefault(spaceId: string, model: SharedModelRef | null): Promise<LlmSpaceDefaultResult> {
    await this.options.service.spacePolicy(spaceId);
    if (model === null) {
      await this.options.spaceSettings.writeDefault(spaceId, null);
      return this.spaceDefault(spaceId);
    }
    const connection = await this.options.service.requireConnection(model.connectionId);
    const models = Array.isArray(connection.providerConfig.models)
      ? connection.providerConfig.models.flatMap((item) =>
          item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : [],
        )
      : [];
    if (!models.includes(model.modelId)) {
      throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "space default model is not in the connection catalog", {
        modelId: model.modelId,
      });
    }
    await this.options.spaceSettings.writeDefault(spaceId, {
      provider: compileManagedRouteId(model.connectionId),
      model: model.modelId,
    });
    return this.spaceDefault(spaceId);
  }

  private async listLocalCandidates(spaceId: string): Promise<LlmLocalCandidatesResult> {
    await this.options.service.spacePolicy(spaceId);
    return {
      spaceId,
      candidates: await this.options.spaceSettings.listLocal(spaceId),
    };
  }

  private async adoptLocal(
    spaceId: string,
    routeId: string,
    displayName: string,
    expectedRevision: number,
    options: { copyCredential?: boolean; secret?: string; operationId?: string },
  ): Promise<LlmCatalogResult> {
    await this.options.service.spacePolicy(spaceId);
    const providerConfig = await this.options.spaceSettings.readLocalProvider(spaceId, routeId);
    const secret =
      options.secret ??
      (options.copyCredential ? await this.options.spaceSettings.readCopyableSecret(spaceId, routeId) : undefined);
    if (!secret) {
      throw new LlmConfigError(LLM_ERROR.CREDENTIAL_MISSING, "local credential cannot be copied; re-enter the key", {
        spaceId,
      });
    }
    const operationId = options.operationId ?? createConnectionId();
    return this.saveConnectionWithCredential({
      method: LLM_CREDENTIAL_METHOD,
      draft: { displayName, providerConfig },
      secret,
      expectedRevision,
      operationId,
    });
  }

  private async discoverModelsWithSecret(draft: LlmConnectionSecretDraft, secret: string): Promise<LlmDiscoverResult> {
    assertNoSecretPayload(draft);
    const api = typeof draft.providerConfig.api === "string" ? draft.providerConfig.api : "";
    const baseURL = typeof draft.providerConfig.baseURL === "string" ? draft.providerConfig.baseURL : "";
    const result = await this.options.probe.discover({ api, baseURL, apiKey: secret });
    return result;
  }

  private async spacePolicy(spaceId: string): Promise<LlmSpacePolicyResult> {
    const policy = await this.options.service.spacePolicy(spaceId);
    const catalog = await this.options.service.describe();
    const instance = await this.options.instances.get(spaceId);
    const runningCatalogRevision = instance?.catalogRevision ?? null;
    return {
      spaceId,
      policy,
      targetCatalogRevision: catalog.revision,
      runningCatalogRevision,
      pendingRestart: instance?.status === "running" && runningCatalogRevision !== catalog.revision,
    };
  }

  private async pendingRestartSpaceIds(connectionId?: ConnectionId): Promise<string[]> {
    const catalog = await this.options.service.describe();
    const pending: string[] = [];
    for (const instance of await this.options.instances.list()) {
      if (instance.status !== "running") continue;
      if (instance.catalogRevision === catalog.revision) continue;
      if (connectionId) {
        const policy = await this.options.service.spacePolicy(instance.spaceId).catch(() => undefined);
        if (!policy || !policyBindsConnection(policy, connectionId)) continue;
      }
      pending.push(instance.spaceId);
    }
    return pending;
  }

  private async assertApplyReady(
    spaceIds: string[],
    catalogRevision: number,
    observations: LlmSpaceObservation[],
  ): Promise<void> {
    const catalog = await this.options.service.describe();
    if (catalog.revision !== catalogRevision) {
      throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "catalog revision moved", {
        expected: catalogRevision,
        actual: catalog.revision,
      });
    }
    if (new Set(spaceIds).size !== spaceIds.length) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "applyPlan space ids must be unique");
    }
    const observed = new Map(observations.map((row) => [row.spaceId, row]));
    for (const spaceId of spaceIds) {
      const row = observed.get(spaceId);
      if (!row) {
        throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "applyPlan is missing an observation", { spaceId });
      }
      const current = await this.requireKnownIdle(spaceId);
      if (
        current.status !== row.status ||
        current.generation !== row.generation ||
        current.busy !== row.busy ||
        current.catalogRevision !== row.catalogRevision
      ) {
        throw new LlmConfigError(LLM_ERROR.APPLY_FAILED, "observed space state no longer matches", { spaceId });
      }
    }
  }

  private async requireKnownIdle(spaceId: string): Promise<LlmSpaceObservation> {
    const current = await this.options.instances.get(spaceId);
    if (!current || current.status === "unknown") {
      throw new LlmConfigError(LLM_ERROR.APPLY_FAILED, "space state is unknown; apply was not started", { spaceId });
    }
    if (current.busy || current.status === "starting" || current.status === "stopping") {
      throw new LlmConfigError(LLM_ERROR.SPACE_BUSY, "space is busy; it was not force-stopped", { spaceId });
    }
    return current;
  }

  private async resolveProbeTarget(connectionId: string | undefined, draft: LlmConnectionDraft | undefined): Promise<{
    api: string;
    baseURL: string;
    apiKey?: string;
    connectionId?: ConnectionId;
    models?: string[];
  }> {
    if (draft) assertNoSecretPayload(draft);
    if (connectionId) {
      return this.connectionForProbe(normalizeConnectionId(connectionId));
    }
    if (!draft) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "discoverModels requires a connection id or a draft");
    }
    return this.draftForProbe(draft);
  }

  private async connectionForProbe(connectionId: ConnectionId) {
    const connection = await this.options.service.requireConnection(connectionId);
    const api = typeof connection.providerConfig.api === "string" ? connection.providerConfig.api : "";
    const baseURL = typeof connection.providerConfig.baseURL === "string" ? connection.providerConfig.baseURL : "";
    const models = Array.isArray(connection.providerConfig.models)
      ? connection.providerConfig.models.flatMap((item) =>
          item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : [],
        )
      : undefined;
    let apiKey: string | undefined;
    if (connection.auth.kind === "api-key") {
      apiKey = await this.options.readSecret(connection.auth.credentialRecordId);
      if (!apiKey) {
        throw new LlmConfigError(LLM_ERROR.CREDENTIAL_MISSING, "shared credential record is not readable", {
          connectionId,
        });
      }
    }
    return { api, baseURL, apiKey, connectionId, models };
  }

  private async draftForProbe(draft: LlmConnectionDraft) {
    const api = typeof draft.providerConfig.api === "string" ? draft.providerConfig.api : "";
    const baseURL = typeof draft.providerConfig.baseURL === "string" ? draft.providerConfig.baseURL : "";
    let apiKey: string | undefined;
    if (draft.auth?.kind === "api-key") {
      apiKey = await this.options.readSecret(draft.auth.credentialRecordId);
      if (!apiKey) {
        throw new LlmConfigError(LLM_ERROR.CREDENTIAL_MISSING, "draft credential record is not readable");
      }
    }
    return { api, baseURL, apiKey };
  }


  private catalogResult(
    catalog: { revision: number; connections: Record<string, unknown> | unknown; defaultModel: SharedModelRef | null },
    connectionId?: string,
  ): LlmCatalogResult {
    const connections = Array.isArray(catalog.connections)
      ? catalog.connections
      : Object.values(catalog.connections as Record<string, Parameters<typeof redactConnection>[0]>).map(redactConnection);
    return {
      revision: catalog.revision,
      connections: connections as LlmCatalogResult["connections"],
      defaultModel: catalog.defaultModel,
      ...(connectionId ? { connectionId: normalizeConnectionId(connectionId) } : {}),
    };
  }
}

function asServiceDraft(draft: LlmConnectionDraft): ConnectionDraft {
  assertNoSecretPayload(draft);
  return draft;
}

export function parseLlmApiRequest(payload: unknown): LlmApiRequest {
  const body = expectObject(payload);
  const method = body.method;
  if (typeof method !== "string") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm request method is required");
  }
  switch (method) {
    case "describe":
      expectKeys(body, ["method"]);
      return { method };
    case "previewChange":
    case "saveConnection":
      expectKeys(body, ["method", "draft", "expectedRevision"]);
      return {
        method,
        draft: parseDraft(body.draft),
        expectedRevision: parseRevision(body.expectedRevision),
      };
    case "setDefault":
      expectKeys(body, ["method", "model", "expectedRevision"]);
      return {
        method,
        model: parseModel(body.model),
        expectedRevision: parseRevision(body.expectedRevision),
      };
    case "previewDelete":
      expectKeys(body, ["method", "connectionId"]);
      return { method, connectionId: normalizeConnectionId(String(body.connectionId)) };
    case "deleteConnection":
      expectKeys(body, ["method", "connectionId", "expectedRevision"]);
      return {
        method,
        connectionId: normalizeConnectionId(String(body.connectionId)),
        expectedRevision: parseRevision(body.expectedRevision),
      };
    case "discoverModels":
      expectKeys(body, ["method"], ["connectionId", "draft"]);
      return {
        method,
        ...(body.connectionId !== undefined ? { connectionId: String(body.connectionId) } : {}),
        ...(body.draft !== undefined ? { draft: parseDraft(body.draft) } : {}),
      };
    case "testConnection":
      expectKeys(body, ["method", "connectionId", "modelId", "authorize"]);
      if (body.authorize !== true) {
        throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "testConnection requires explicit authorize: true");
      }
      return {
        method,
        connectionId: String(body.connectionId),
        modelId: String(body.modelId),
        authorize: true,
      };
    case "spacePolicy":
      expectKeys(body, ["method", "spaceId"]);
      return { method, spaceId: parseSpaceId(body.spaceId) };
    case "updateSpacePolicy":
      expectKeys(body, ["method", "spaceId", "shared", "expectedRevision"]);
      return {
        method,
        spaceId: parseSpaceId(body.spaceId),
        shared: parseShared(body.shared),
        expectedRevision: parseRevision(body.expectedRevision),
      };
    case "applyPlan":
      expectKeys(body, ["method", "spaceIds", "catalogRevision", "observations", "requestId"]);
      return {
        method,
        spaceIds: parseSpaceIds(body.spaceIds),
        catalogRevision: parseRevision(body.catalogRevision),
        observations: parseObservations(body.observations),
        requestId: parseRequestId(body.requestId),
      };
    case "operationStatus":
      expectKeys(body, ["method", "operationId"]);
      return { method, operationId: parseRequestId(body.operationId) };
    case "spaceDefault":
    case "listLocalCandidates":
      expectKeys(body, ["method", "spaceId"]);
      return { method, spaceId: parseSpaceId(body.spaceId) };
    case "updateSpaceDefault":
      expectKeys(body, ["method", "spaceId", "model"]);
      return { method, spaceId: parseSpaceId(body.spaceId), model: parseModel(body.model) };
    case "adoptLocal":
      expectKeys(body, ["method", "spaceId", "routeId", "displayName", "expectedRevision", "copyCredential"]);
      if (body.copyCredential !== true) {
        throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "adoptLocal requires explicit copyCredential: true");
      }
      if (typeof body.routeId !== "string" || typeof body.displayName !== "string") {
        throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "adoptLocal requires routeId and displayName");
      }
      return {
        method,
        spaceId: parseSpaceId(body.spaceId),
        routeId: body.routeId,
        displayName: body.displayName,
        expectedRevision: parseRevision(body.expectedRevision),
        copyCredential: true,
      };
    default:
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "unknown llm method");
  }
}

export function parseCredentialRequest(payload: unknown): LlmCredentialRequest {
  const body = expectObject(payload);
  if (typeof body.secret !== "string" || body.secret.length === 0) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "credential secret must be a non-empty string");
  }
  if (body.method === LLM_CREDENTIAL_DISCOVER_METHOD) {
    expectKeys(body, ["method", "draft", "secret"]);
    return { method: LLM_CREDENTIAL_DISCOVER_METHOD, draft: parseSecretDraft(body.draft), secret: body.secret };
  }
  if (body.method === LLM_CREDENTIAL_ADOPT_METHOD) {
    expectKeys(body, ["method", "spaceId", "routeId", "displayName", "secret", "expectedRevision", "operationId"]);
    if (typeof body.routeId !== "string" || typeof body.displayName !== "string") {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "adoptLocal requires routeId and displayName");
    }
    return {
      method: LLM_CREDENTIAL_ADOPT_METHOD,
      spaceId: parseSpaceId(body.spaceId),
      routeId: body.routeId,
      displayName: body.displayName,
      secret: body.secret,
      expectedRevision: parseRevision(body.expectedRevision),
      operationId: parseRequestId(body.operationId),
    };
  }
  expectKeys(body, ["method", "draft", "secret", "expectedRevision", "operationId"]);
  if (body.method !== LLM_CREDENTIAL_METHOD) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llmCredential method is not supported");
  }
  return {
    method: LLM_CREDENTIAL_METHOD,
    draft: parseSecretDraft(body.draft),
    secret: body.secret,
    expectedRevision: parseRevision(body.expectedRevision),
    operationId: parseRequestId(body.operationId),
  };
}

function parseDraft(value: unknown): LlmConnectionDraft {
  const draft = expectObject(value);
  expectKeys(draft, ["displayName", "providerConfig"], ["id", "enabled", "auth"]);
  assertNoSecretPayload(draft);
  if (typeof draft.displayName !== "string" || draft.displayName === "") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "displayName is required");
  }
  if (!draft.providerConfig || typeof draft.providerConfig !== "object" || Array.isArray(draft.providerConfig)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "providerConfig must be an object");
  }
  return {
    ...(typeof draft.id === "string" ? { id: draft.id } : {}),
    displayName: draft.displayName,
    ...(typeof draft.enabled === "boolean" ? { enabled: draft.enabled } : {}),
    providerConfig: draft.providerConfig as Record<string, unknown>,
    ...(draft.auth !== undefined ? { auth: parseAuth(draft.auth) } : {}),
  };
}

function parseSecretDraft(value: unknown): LlmConnectionSecretDraft {
  const draft = expectObject(value);
  expectKeys(draft, ["displayName", "providerConfig"], ["id", "enabled", "auth"]);
  assertNoSecretPayload(draft);
  if (typeof draft.displayName !== "string" || draft.displayName === "") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "displayName is required");
  }
  if (!draft.providerConfig || typeof draft.providerConfig !== "object" || Array.isArray(draft.providerConfig)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "providerConfig must be an object");
  }
  return {
    ...(typeof draft.id === "string" ? { id: draft.id } : {}),
    displayName: draft.displayName,
    ...(typeof draft.enabled === "boolean" ? { enabled: draft.enabled } : {}),
    providerConfig: draft.providerConfig as Record<string, unknown>,
  };
}

function parseAuth(value: unknown): LlmConnectionDraft["auth"] {
  const auth = expectObject(value);
  if (auth.kind === "none") {
    expectKeys(auth, ["kind"]);
    return { kind: "none" };
  }
  if (auth.kind === "api-key") {
    expectKeys(auth, ["kind", "credentialRecordId"]);
    if (typeof auth.credentialRecordId !== "string") {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "credentialRecordId is required");
    }
    return { kind: "api-key", credentialRecordId: auth.credentialRecordId };
  }
  throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "auth kind is not supported");
}

function parseModel(value: unknown): SharedModelRef | null {
  if (value === null) return null;
  const model = expectObject(value);
  expectKeys(model, ["connectionId", "modelId"]);
  if (typeof model.connectionId !== "string" || typeof model.modelId !== "string") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "model ref is not valid");
  }
  return { connectionId: model.connectionId, modelId: model.modelId };
}

function parseShared(value: unknown): LlmApiRequest extends { shared: infer S } ? S : never {
  const shared = expectObject(value);
  if (shared.mode === "none" || shared.mode === "all") {
    expectKeys(shared, ["mode"]);
    return { mode: shared.mode } as never;
  }
  if (shared.mode === "selected") {
    expectKeys(shared, ["mode", "connectionIds"]);
    if (!Array.isArray(shared.connectionIds) || shared.connectionIds.some((id) => typeof id !== "string")) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "selected connection ids are not valid");
    }
    return { mode: "selected", connectionIds: shared.connectionIds as string[] } as never;
  }
  throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "policy mode is not valid");
}

function parseObservations(value: unknown): LlmSpaceObservation[] {
  if (!Array.isArray(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "observations must be an array");
  }
  return value.map((item) => {
    const row = expectObject(item);
    expectKeys(row, ["spaceId", "status", "generation", "catalogRevision", "busy"]);
    const status = row.status;
    if (
      status !== "running" &&
      status !== "starting" &&
      status !== "stopping" &&
      status !== "stopped" &&
      status !== "crashed" &&
      status !== "unknown"
    ) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "observation status is not valid");
    }
    if (typeof row.busy !== "boolean" || !Number.isInteger(row.generation)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "observation generation or busy flag is not valid");
    }
    if (row.catalogRevision !== null && (!Number.isInteger(row.catalogRevision) || Number(row.catalogRevision) < 0)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "observation catalogRevision is not valid");
    }
    return {
      spaceId: parseSpaceId(row.spaceId),
      status,
      generation: Number(row.generation),
      catalogRevision: row.catalogRevision === null ? null : Number(row.catalogRevision),
      busy: row.busy,
    };
  });
}

function parseSpaceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "applyPlan requires an explicit space id list");
  }
  return value.map(parseSpaceId);
}

function parseSpaceId(value: unknown): string {
  if (typeof value !== "string" || !SPACE_ID_RE.test(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "space id is not allowed");
  }
  return value;
}

function parseRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "revision must be a non-negative integer");
  }
  return Number(value);
}

function parseRequestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID_RE.test(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "request id is not valid");
  }
  return value;
}

function expectObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "request must be an object");
  }
  return value as Record<string, unknown>;
}

function expectKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "request has an unexpected field", { field: key });
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "request is missing a required field", { field: key });
    }
  }
}
