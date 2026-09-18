/** Shared LLM connection identity, catalog, and managed-route grammar. */

export const LLM_CATALOG_SCHEMA_VERSION = 1;
export const LLM_POLICY_SCHEMA_VERSION = 1;
export const LLM_MANAGED_ROUTE_PREFIX = "spaces-llm-";
export const LLM_MANAGED_CREDENTIAL_REF_PREFIX = "SPACES_LLM_";
export const LLM_MANAGED_RECORD_SCOPE = "spaces-llm";
export const LLM_SHARED_BACKEND = "llm-pi-ai";

/** Protocols `llm-pi-ai@0.1.5-rc.2` `supportedProtocols()` actually constructs. */
export const PINNED_LLM_PI_AI_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

export type PinnedLlmPiAiProtocol = (typeof PINNED_LLM_PI_AI_PROTOCOLS)[number];

export const LLM_ERROR = {
  REVISION_CONFLICT: "LLM_REVISION_CONFLICT",
  WRITE_OWNER_REQUIRED: "LLM_WRITE_OWNER_REQUIRED",
  CONFIG_INVALID: "LLM_CONFIG_INVALID",
  UNSUPPORTED_RUNTIME: "LLM_UNSUPPORTED_RUNTIME",
  UNSUPPORTED_PROTOCOL: "LLM_UNSUPPORTED_PROTOCOL",
  ADAPTER_MISSING: "LLM_ADAPTER_MISSING",
  MODEL_NOT_FOUND: "LLM_MODEL_NOT_FOUND",
  CONNECTION_IN_USE: "LLM_CONNECTION_IN_USE",
  SHARED_CONNECTION_READ_ONLY: "LLM_SHARED_CONNECTION_READ_ONLY",
  MANAGED_ROUTE_CONFLICT: "LLM_MANAGED_ROUTE_CONFLICT",
  CREDENTIAL_MISSING: "LLM_CREDENTIAL_MISSING",
  CREDENTIAL_WRITE_FAILED: "LLM_CREDENTIAL_WRITE_FAILED",
  DISCOVERY_FAILED: "LLM_DISCOVERY_FAILED",
  SPACE_BUSY: "LLM_SPACE_BUSY",
  APPLY_FAILED: "LLM_APPLY_FAILED",
  RESULT_UNKNOWN: "LLM_RESULT_UNKNOWN",
} as const;

export type LlmErrorCode = (typeof LLM_ERROR)[keyof typeof LLM_ERROR];

export class LlmConfigError extends Error {
  readonly name = "LlmConfigError";
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly details: Record<string, string | number | undefined> = {},
  ) {
    super(message);
  }
}

export type ConnectionId = string;

export type SharedModelRef = {
  connectionId: ConnectionId;
  modelId: string;
};

export type SharedAuth =
  | { kind: "api-key"; credentialRecordId: string }
  | { kind: "none" };

export interface SharedConnection {
  id: ConnectionId;
  revision: number;
  displayName: string;
  enabled: boolean;
  backend: typeof LLM_SHARED_BACKEND;
  providerConfig: Record<string, unknown>;
  auth: SharedAuth;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalLlmCatalog {
  schemaVersion: typeof LLM_CATALOG_SCHEMA_VERSION;
  revision: number;
  connections: Record<ConnectionId, SharedConnection>;
  defaultModel: SharedModelRef | null;
  retiredConnectionIds: ConnectionId[];
}

export type SharedSelection =
  | { mode: "none" }
  | { mode: "all" }
  | { mode: "selected"; connectionIds: ConnectionId[] };

export interface SpaceLlmPolicy {
  schemaVersion: typeof LLM_POLICY_SCHEMA_VERSION;
  revision: number;
  shared: SharedSelection;
}

export interface LlmSharedSnapshot {
  catalogRevision: number;
  policyRevision: number;
  connections: SharedConnection[];
  defaultModel: SharedModelRef | null;
  adapterVersion: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/;
const CREDENTIAL_RECORD_RE = /^spaces-llm\/conn-([0-9a-f]{32})-rev-([1-9][0-9]*)$/;
const CREDENTIAL_REF_RE = /^SPACES_LLM_([0-9A-F]{32})_R([1-9][0-9]*)_API_KEY$/;
const MANAGED_ROUTE_RE = /^spaces-llm-([0-9a-f]{32})$/;

/** Fields official `PiAiProviderProfile` accepts that a shared connection may store. */
export const SHARED_PROVIDER_CONFIG_KEYS = [
  "displayName",
  "api",
  "baseURL",
  "models",
  "modelOverrides",
  "compat",
  "defaultContextWindow",
  "defaultMaxTokens",
  "defaultInput",
  "reasoning",
  "thinkingBudgets",
  "cacheRetention",
  "transport",
  "timeoutMs",
  "websocketConnectTimeoutMs",
  "streamIdleTimeoutMs",
  "maxRequestImageBytes",
  "requestImagePixelBudget",
  "requestImageMaxBytes",
  "retryPolicy",
] as const;

const FORBIDDEN_PROVIDER_CONFIG_KEYS = [
  "apiKeyEnv",
  "headers",
  "provider",
  "routeId",
  "credentialRecordId",
  "id",
] as const;

export function createConnectionId(): string {
  return crypto.randomUUID().toLowerCase();
}

export function normalizeConnectionId(id: string): ConnectionId {
  if (!UUID_RE.test(id)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "connection id must be a UUID");
  }
  return id.toLowerCase();
}

export function connectionIdHex(id: string): string {
  return normalizeConnectionId(id).replaceAll("-", "");
}

export function connectionIdFromHex(hex: string): ConnectionId {
  const value = hex.toLowerCase();
  if (!HEX32_RE.test(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "connection hex must be 32 lowercase hex characters");
  }
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function compileManagedRouteId(connectionId: string): string {
  return `${LLM_MANAGED_ROUTE_PREFIX}${connectionIdHex(connectionId)}`;
}

export function isManagedRouteId(routeId: string): boolean {
  return MANAGED_ROUTE_RE.test(routeId);
}

export function parseManagedRouteId(routeId: string): ConnectionId | null {
  const match = MANAGED_ROUTE_RE.exec(routeId);
  return match ? connectionIdFromHex(match[1]) : null;
}

export function compileManagedCredentialRef(connectionId: string, credentialRevision: number): string {
  assertCredentialRevision(credentialRevision);
  return `${LLM_MANAGED_CREDENTIAL_REF_PREFIX}${connectionIdHex(connectionId).toUpperCase()}_R${credentialRevision}_API_KEY`;
}

export function isManagedCredentialRef(ref: string): boolean {
  return CREDENTIAL_REF_RE.test(ref);
}

export function parseManagedCredentialRef(
  ref: string,
): { connectionId: ConnectionId; credentialRevision: number } | null {
  const match = CREDENTIAL_REF_RE.exec(ref);
  if (!match) return null;
  return {
    connectionId: connectionIdFromHex(match[1].toLowerCase()),
    credentialRevision: Number(match[2]),
  };
}

export function compileManagedRecordKey(connectionId: string, credentialRevision: number): string {
  assertCredentialRevision(credentialRevision);
  return `${LLM_MANAGED_RECORD_SCOPE}/conn-${connectionIdHex(connectionId)}-rev-${credentialRevision}`;
}

export function parseManagedRecordKey(
  recordId: string,
): { connectionId: ConnectionId; credentialRevision: number } | null {
  const match = CREDENTIAL_RECORD_RE.exec(recordId);
  if (!match) return null;
  return {
    connectionId: connectionIdFromHex(match[1]),
    credentialRevision: Number(match[2]),
  };
}

export function credentialRevisionOf(auth: SharedAuth): number | null {
  if (auth.kind !== "api-key") return null;
  return parseManagedRecordKey(auth.credentialRecordId)?.credentialRevision ?? null;
}

export function emptyCatalog(): GlobalLlmCatalog {
  return {
    schemaVersion: LLM_CATALOG_SCHEMA_VERSION,
    revision: 0,
    connections: {},
    defaultModel: null,
    retiredConnectionIds: [],
  };
}

export function emptyPolicy(): SpaceLlmPolicy {
  return {
    schemaVersion: LLM_POLICY_SCHEMA_VERSION,
    revision: 0,
    shared: { mode: "none" },
  };
}

export function parseCatalog(value: unknown): GlobalLlmCatalog {
  if (!isRecord(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "catalog must be an object");
  }
  if (value.schemaVersion !== LLM_CATALOG_SCHEMA_VERSION) {
    throw new LlmConfigError(LLM_ERROR.UNSUPPORTED_RUNTIME, "unknown catalog schemaVersion", {
      schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : String(value.schemaVersion),
    });
  }
  if (!Number.isInteger(value.revision) || Number(value.revision) < 0) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "catalog revision must be a non-negative integer");
  }
  if (!isRecord(value.connections)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "catalog connections must be an object");
  }
  const connections: Record<ConnectionId, SharedConnection> = {};
  for (const [key, raw] of Object.entries(value.connections)) {
    const connection = parseConnection(raw);
    const id = normalizeConnectionId(key);
    if (connection.id !== id) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "connection map key must match connection id");
    }
    connections[id] = connection;
  }
  const retired = Array.isArray(value.retiredConnectionIds)
    ? value.retiredConnectionIds.map((id) => {
        if (typeof id !== "string") {
          throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "retired connection id must be a string");
        }
        return normalizeConnectionId(id);
      })
    : [];
  return {
    schemaVersion: LLM_CATALOG_SCHEMA_VERSION,
    revision: Number(value.revision),
    connections,
    defaultModel: value.defaultModel == null ? null : parseModelRef(value.defaultModel),
    retiredConnectionIds: retired,
  };
}

export function parsePolicy(value: unknown): SpaceLlmPolicy {
  if (!isRecord(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "policy must be an object");
  }
  if (value.schemaVersion !== LLM_POLICY_SCHEMA_VERSION) {
    throw new LlmConfigError(LLM_ERROR.UNSUPPORTED_RUNTIME, "unknown policy schemaVersion", {
      schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : String(value.schemaVersion),
    });
  }
  if (!Number.isInteger(value.revision) || Number(value.revision) < 0) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "policy revision must be a non-negative integer");
  }
  return {
    schemaVersion: LLM_POLICY_SCHEMA_VERSION,
    revision: Number(value.revision),
    shared: parseSelection(value.shared),
  };
}

export function parseConnection(value: unknown): SharedConnection {
  if (!isRecord(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "connection must be an object");
  }
  const id = normalizeConnectionId(String(value.id ?? ""));
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "connection revision must be a positive integer");
  }
  if (typeof value.displayName !== "string" || value.displayName.trim() === "") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "connection displayName is required");
  }
  if (value.backend !== LLM_SHARED_BACKEND) {
    throw new LlmConfigError(LLM_ERROR.UNSUPPORTED_PROTOCOL, "only llm-pi-ai shared connections are supported");
  }
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "connection timestamps are required");
  }
  return {
    id,
    revision: Number(value.revision),
    displayName: value.displayName,
    enabled: value.enabled === true,
    backend: LLM_SHARED_BACKEND,
    providerConfig: sanitizeProviderConfig(value.providerConfig),
    auth: parseAuth(value.auth),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function sanitizeProviderConfig(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (!isRecord(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "providerConfig must be an object");
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if ((FORBIDDEN_PROVIDER_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new LlmConfigError(
        LLM_ERROR.CONFIG_INVALID,
        "providerConfig cannot set route identity, credentials, or secret headers",
        { field: key },
      );
    }
    if (!(SHARED_PROVIDER_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "providerConfig field is not allowed", { field: key });
    }
    out[key] = field;
  }
  if (typeof out.api === "string" && !isPinnedProtocol(out.api)) {
    throw new LlmConfigError(LLM_ERROR.UNSUPPORTED_PROTOCOL, "providerConfig.api is not pinned for this runtime", {
      api: out.api,
    });
  }
  if (typeof out.baseURL === "string") {
    assertPublicEndpoint(out.baseURL);
  }
  return out;
}

export function isPinnedProtocol(api: string): api is PinnedLlmPiAiProtocol {
  return (PINNED_LLM_PI_AI_PROTOCOLS as readonly string[]).includes(api);
}

export function assertPublicEndpoint(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "providerConfig.baseURL must be an absolute URL");
  }
  if (parsed.username || parsed.password) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "providerConfig.baseURL cannot include userinfo");
  }
  if (parsed.searchParams.toString() !== "") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "providerConfig.baseURL cannot include a query string");
  }
}

function parseAuth(value: unknown): SharedAuth {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "connection auth is required");
  }
  if (value.kind === "none") return { kind: "none" };
  if (value.kind === "api-key") {
    if (typeof value.credentialRecordId !== "string" || !parseManagedRecordKey(value.credentialRecordId)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "api-key auth requires a managed credential record id");
    }
    return { kind: "api-key", credentialRecordId: value.credentialRecordId };
  }
  throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "unsupported connection auth kind");
}

function parseSelection(value: unknown): SharedSelection {
  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "policy.shared is required");
  }
  if (value.mode === "none" || value.mode === "all") return { mode: value.mode };
  if (value.mode === "selected") {
    if (!Array.isArray(value.connectionIds)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "selected policy requires connectionIds");
    }
    return {
      mode: "selected",
      connectionIds: value.connectionIds.map((id) => {
        if (typeof id !== "string") {
          throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "connectionIds must be strings");
        }
        return normalizeConnectionId(id);
      }),
    };
  }
  throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "unsupported shared selection mode");
}

function parseModelRef(value: unknown): SharedModelRef {
  if (!isRecord(value) || typeof value.connectionId !== "string" || typeof value.modelId !== "string") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "model ref requires connectionId and modelId");
  }
  if (value.modelId.trim() === "") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "model id must be the exact upstream value");
  }
  return { connectionId: normalizeConnectionId(value.connectionId), modelId: value.modelId };
}

function assertCredentialRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "credential revision must be a positive integer");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
