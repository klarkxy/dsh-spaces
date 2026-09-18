/** Secret-free Space share LLM requirements and import mapping. */

import {
  LLM_ERROR,
  LlmConfigError,
  compileManagedRouteId,
  createConnectionId,
  isRecord,
  normalizeConnectionId,
  parseCatalog,
  redactEndpoint,
  type GlobalLlmCatalog,
  type SharedModelRef,
  type SharedSelection,
  type SpaceLlmPolicy,
} from "./llm-connections";
import { selectSharedConnections } from "./llm-resolution";

export const LLM_SHARE_KIND = "dsh-space-llm-requirements" as const;
export const LLM_SHARE_SCHEMA_VERSION = 1 as const;
export const LLM_SHARE_FILENAME = "llm.json";
export const LLM_SHARE_NOTE =
  "Source connection IDs are local to the exporting Home and are not valid references here. Map each requirement to a connection on this Home. Unmapped requirements stay unavailable.";

export type LlmShareAuthKind = "api-key" | "none";

export type LlmShareRequirement = {
  requirementId: string;
  displayName: string;
  protocol: string;
  endpoint: string;
  modelIds: string[];
  authKind: LlmShareAuthKind;
  usedAsDefault: boolean;
};

export type LlmShareManifest = {
  schemaVersion: typeof LLM_SHARE_SCHEMA_VERSION;
  kind: typeof LLM_SHARE_KIND;
  sourceSharedMode: SpaceLlmPolicy["shared"]["mode"];
  requirements: LlmShareRequirement[];
  defaultRequirementId: string | null;
  adapterRequired: "llm-pi-ai";
  note: typeof LLM_SHARE_NOTE;
};

export type LlmShareMapping = {
  requirementId: string;
  connectionId: string;
};

export type SecretScanFinding = {
  path: string;
  reason: string;
};

const FORBIDDEN_SHARE_ENTRY = [
  /(^|\/)\.credentials\.yaml$/i,
  /(^|\/)credentials\.yaml$/i,
  /(^|\/)\.dsh-spaces-control\/llm(\/|$)/i,
  /(^|\/)llm-policy\.json$/i,
  /(^|\/)operations\.json$/i,
  /(^|\/)catalog\.json$/i,
  /(^|\/)[^/]*snapshot[^/]*\.json$/i,
];

const SECRET_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /SPACES_LLM_[0-9A-F]{32}_R[1-9][0-9]*_API_KEY/g, reason: "managed credential reference" },
  { re: /spaces-llm\/conn-[0-9a-f]{32}-rev-[1-9][0-9]*/g, reason: "credential record id" },
  { re: /["']?apiKey(?:Env)?["']?\s*[:=]\s*["']?[^"'\s]+["']?/gi, reason: "apiKey field" },
  { re: /Authorization:\s*Bearer\s+\S+/gi, reason: "authorization header" },
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, reason: "key-like token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, reason: "private key block" },
  { re: /(?:^|[\s"'=])(?:\/(?:home|Users|root|opt|var)\/|[A-Za-z]:\\)/g, reason: "absolute path" },
];

export function buildLlmShareManifest(input: {
  catalog: GlobalLlmCatalog;
  policy: SpaceLlmPolicy;
  spaceDefault?: { provider: string; model: string } | null;
  createId?: () => string;
}): LlmShareManifest {
  parseCatalog(input.catalog);
  const createId = input.createId ?? createConnectionId;
  const connections = selectSharedConnections(input.catalog, input.policy);
  const requirements: LlmShareRequirement[] = [];
  let defaultRequirementId: string | null = null;
  for (const connection of connections) {
    const requirementId = createId();
    const usedAsDefault = isUsedAsDefault(connection.id, input.spaceDefault, input.catalog.defaultModel);
    if (usedAsDefault) defaultRequirementId = requirementId;
    requirements.push({
      requirementId,
      displayName: connection.displayName,
      protocol: typeof connection.providerConfig.api === "string" ? connection.providerConfig.api : "",
      endpoint: redactEndpoint(connection.providerConfig.baseURL),
      modelIds: modelIdsOf(connection.providerConfig.models),
      authKind: connection.auth.kind === "none" ? "none" : "api-key",
      usedAsDefault,
    });
  }
  return {
    schemaVersion: LLM_SHARE_SCHEMA_VERSION,
    kind: LLM_SHARE_KIND,
    sourceSharedMode: input.policy.shared.mode,
    requirements,
    defaultRequirementId,
    adapterRequired: "llm-pi-ai",
    note: LLM_SHARE_NOTE,
  };
}

export function parseLlmShareManifest(value: unknown): LlmShareManifest {
  if (!isRecord(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share manifest must be an object");
  }
  if (value.kind !== LLM_SHARE_KIND) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share kind is not supported");
  }
  if (value.schemaVersion !== LLM_SHARE_SCHEMA_VERSION) {
    throw new LlmConfigError(LLM_ERROR.UNSUPPORTED_RUNTIME, "unknown llm share schemaVersion", {
      schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : String(value.schemaVersion),
    });
  }
  if (value.adapterRequired !== "llm-pi-ai") {
    throw new LlmConfigError(LLM_ERROR.UNSUPPORTED_PROTOCOL, "llm share adapter is not supported");
  }
  if (value.sourceSharedMode !== "none" && value.sourceSharedMode !== "all" && value.sourceSharedMode !== "selected") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share sourceSharedMode is not supported");
  }
  if (!Array.isArray(value.requirements)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share requirements must be an array");
  }
  const requirements = value.requirements.map((row, index) => parseRequirement(row, index));
  const defaultRequirementId =
    value.defaultRequirementId == null ? null : String(value.defaultRequirementId);
  if (defaultRequirementId && !requirements.some((row) => row.requirementId === defaultRequirementId)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share defaultRequirementId is not in requirements");
  }
  return {
    schemaVersion: LLM_SHARE_SCHEMA_VERSION,
    kind: LLM_SHARE_KIND,
    sourceSharedMode: value.sourceSharedMode,
    requirements,
    defaultRequirementId,
    adapterRequired: "llm-pi-ai",
    note: LLM_SHARE_NOTE,
  };
}

export function applyLlmShareMapping(input: {
  manifest: LlmShareManifest;
  mappings: readonly LlmShareMapping[];
  catalog: GlobalLlmCatalog;
}): {
  shared: SharedSelection;
  defaultModel: SharedModelRef | null;
  unmapped: LlmShareRequirement[];
} {
  const catalog = parseCatalog(input.catalog);
  const manifest = parseLlmShareManifest(input.manifest);
  const byRequirement = new Map(manifest.requirements.map((row) => [row.requirementId, row]));
  const seen = new Set<string>();
  const connectionIds: string[] = [];
  let defaultModel: SharedModelRef | null = null;
  for (const mapping of input.mappings) {
    if (typeof mapping.requirementId !== "string" || typeof mapping.connectionId !== "string") {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share mapping requires requirementId and connectionId");
    }
    if (seen.has(mapping.requirementId)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share mapping has a duplicate requirement");
    }
    seen.add(mapping.requirementId);
    const requirement = byRequirement.get(mapping.requirementId);
    if (!requirement) {
      throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "llm share mapping refers to an unknown requirement", {
        requirementId: mapping.requirementId,
      });
    }
    const connectionId = normalizeConnectionId(mapping.connectionId);
    const connection = catalog.connections[connectionId];
    if (!connection) {
      throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "mapped connection does not exist on this Home", {
        connectionId,
      });
    }
    connectionIds.push(connectionId);
    if (manifest.defaultRequirementId === mapping.requirementId) {
      const modelId = requirement.modelIds[0];
      if (modelId && modelIdsOf(connection.providerConfig.models).includes(modelId)) {
        defaultModel = { connectionId, modelId };
      }
    }
  }
  const unmapped = manifest.requirements.filter((row) => !seen.has(row.requirementId));
  return {
    shared: connectionIds.length === 0 ? { mode: "none" } : { mode: "selected", connectionIds },
    defaultModel,
    unmapped,
  };
}

export function forbiddenShareEntryReason(name: string): string | undefined {
  const normalized = name.replaceAll("\\", "/");
  if (FORBIDDEN_SHARE_ENTRY.some((re) => re.test(normalized))) {
    return "share entry is a secret, catalog, or Home-local LLM file";
  }
  return undefined;
}

export function scanShareText(path: string, text: string): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  const nameReason = forbiddenShareEntryReason(path);
  if (nameReason) findings.push({ path, reason: nameReason });
  for (const { re, reason } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) findings.push({ path, reason });
  }
  return findings;
}

export function scanShareEntries(entries: ReadonlyArray<{ name: string; data: Buffer | string }>): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  for (const entry of entries) {
    const text = typeof entry.data === "string" ? entry.data : entry.data.toString("utf8");
    findings.push(...scanShareText(entry.name, text));
  }
  return findings;
}

export function assertShareSecretFree(entries: ReadonlyArray<{ name: string; data: Buffer | string }>): void {
  const findings = scanShareEntries(entries);
  if (findings.length === 0) return;
  throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "share package contains a secret or Home-local credential reference", {
    path: findings[0].path,
    reason: findings[0].reason,
  });
}

function parseRequirement(value: unknown, index: number): LlmShareRequirement {
  if (!isRecord(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share requirement must be an object", { index });
  }
  if (typeof value.requirementId !== "string" || value.requirementId.trim() === "") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share requirementId is required", { index });
  }
  if (typeof value.displayName !== "string" || value.displayName.trim() === "") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share displayName is required", { index });
  }
  if (value.authKind !== "api-key" && value.authKind !== "none") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share authKind is not supported", { index });
  }
  if (!Array.isArray(value.modelIds) || value.modelIds.some((id) => typeof id !== "string")) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm share modelIds must be strings", { index });
  }
  return {
    requirementId: value.requirementId,
    displayName: value.displayName,
    protocol: typeof value.protocol === "string" ? value.protocol : "",
    endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
    modelIds: value.modelIds,
    authKind: value.authKind,
    usedAsDefault: value.usedAsDefault === true,
  };
}

function modelIdsOf(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return models.flatMap((item) =>
    item && typeof item === "object" && "id" in item && typeof item.id === "string" && item.id !== "" ? [item.id] : [],
  );
}

function isUsedAsDefault(
  connectionId: string,
  spaceDefault: { provider: string; model: string } | null | undefined,
  catalogDefault: SharedModelRef | null,
): boolean {
  if (spaceDefault?.provider === compileManagedRouteId(connectionId)) return true;
  if (!spaceDefault && catalogDefault?.connectionId === connectionId) return true;
  return false;
}
