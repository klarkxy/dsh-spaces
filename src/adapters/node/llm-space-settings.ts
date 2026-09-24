import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMap, isScalar, isSeq, type YAMLMap } from "yaml";
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";
import {
  LLM_ERROR,
  LlmConfigError,
  isManagedRouteId,
  redactEndpoint,
  sanitizeProviderConfig,
} from "../../core/domain/llm-connections";
import { atomicWrite } from "./atomic";
import type { LlmLocalCandidate } from "../../shared/llm-api";
import type { LlmSpaceSettingsPort } from "../../core/ports/llm-runtime";
import { parseLlmShareManifest, type LlmShareManifest } from "../../core/domain/llm-share";
import { assertSafeSpaceId, spaceDataRoot } from "./llm-policy-store";
import { profileSettingsPath, readProfileSettings, writeProfileSettings } from "./profile-settings";

export const AGENT_DEFAULT_MODEL_NAMESPACE = "agent-default-model";
export const LLM_PI_AI_NAMESPACE = "llm-pi-ai";
export const LLM_IMPORT_FILENAME = "llm-import.json";

export type SpaceDefaultModel = {
  provider: string;
  model: string;
};

export function spaceSettingsPath(home: string, spaceId: string): string {
  assertSafeSpaceId(spaceId);
  return profileSettingsPath(home, spaceId);
}

export function spaceCredentialsPath(home: string, spaceId: string): string {
  assertSafeSpaceId(spaceId);
  return join(spaceDataRoot(home, spaceId), ".credentials.yaml");
}

export function readSpaceDefaultModel(home: string, spaceId: string): SpaceDefaultModel | null {
  const path = spaceSettingsPath(home, spaceId);
  if (!existsSync(path)) return null;
  const doc = readProfileSettings(home, spaceId);
  const node = doc.get(AGENT_DEFAULT_MODEL_NAMESPACE);
  if (!isMap(node)) return null;
  const provider = node.get("provider");
  const model = node.get("model");
  if (typeof provider !== "string" || typeof model !== "string") return null;
  if (provider.trim() === "" || model.trim() === "") return null;
  return { provider, model };
}

export async function writeSpaceDefaultModel(home: string, spaceId: string, value: SpaceDefaultModel | null): Promise<void> {
  if (spaceId === "web") throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "The default web profile is protected.");
  const path = spaceSettingsPath(home, spaceId);
  if (!existsSync(path) && value === null) return;
  if (!existsSync(path) && !existsSync(dirname(path))) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "space settings path is not available", { spaceId });
  }
  if (value && (value.provider.trim() === "" || value.model.trim() === "")) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "space default requires provider and model");
  }
  await withFileLock(join(dirname(path), "package.json"), async () => {
    writeProfileSettings(home, spaceId, { [AGENT_DEFAULT_MODEL_NAMESPACE]: value });
  });
}

export function listLocalLlmCandidates(home: string, spaceId: string): LlmLocalCandidate[] {
  const path = spaceSettingsPath(home, spaceId);
  if (!existsSync(path)) return [];
  const doc = readProfileSettings(home, spaceId);
  const ns = doc.get(LLM_PI_AI_NAMESPACE);
  if (!isMap(ns)) return [];
  const providers = ns.get("providers");
  if (!isMap(providers)) return [];
  const credentialText = existsSync(spaceCredentialsPath(home, spaceId))
    ? readFileSync(spaceCredentialsPath(home, spaceId), "utf8")
    : "";
  const out: LlmLocalCandidate[] = [];
  for (const item of providers.items) {
    const routeId = isScalar(item.key) ? String(item.key.value ?? "") : "";
    if (!routeId || isManagedRouteId(routeId)) continue;
    if (!isMap(item.value)) continue;
    out.push(candidateFromProvider(routeId, item.value, credentialText));
  }
  return out;
}

export function readLocalProviderConfig(home: string, spaceId: string, routeId: string): Record<string, unknown> {
  const path = spaceSettingsPath(home, spaceId);
  if (!existsSync(path)) {
    throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "local connection was not found", { spaceId });
  }
  if (isManagedRouteId(routeId)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "managed routes cannot be adopted as local connections");
  }
  const doc = readProfileSettings(home, spaceId);
  const ns = doc.get(LLM_PI_AI_NAMESPACE);
  if (!isMap(ns)) {
    throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "local connection was not found", { spaceId });
  }
  const providers = ns.get("providers");
  if (!isMap(providers)) {
    throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "local connection was not found", { spaceId });
  }
  const provider = providers.get(routeId);
  if (!isMap(provider)) {
    throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "local connection was not found", {
      spaceId,
    });
  }
  return sanitizeProviderConfig(yamlMapToJson(provider));
}

export function readCopyableLocalSecret(home: string, spaceId: string, routeId: string): string | undefined {
  const path = spaceSettingsPath(home, spaceId);
  if (!existsSync(path) || isManagedRouteId(routeId)) return undefined;
  const doc = readProfileSettings(home, spaceId);
  const ns = doc.get(LLM_PI_AI_NAMESPACE);
  if (!isMap(ns)) return undefined;
  const providers = ns.get("providers");
  if (!isMap(providers)) return undefined;
  const provider = providers.get(routeId);
  if (!isMap(provider)) return undefined;
  const apiKeyEnv = provider.get("apiKeyEnv");
  if (typeof apiKeyEnv !== "string" || apiKeyEnv.trim() === "") return undefined;
  return readNamedCredential(spaceCredentialsPath(home, spaceId), apiKeyEnv);
}

function candidateFromProvider(routeId: string, provider: YAMLMap, credentialText: string): LlmLocalCandidate {
  const api = provider.get("api");
  const displayName = provider.get("displayName");
  const apiKeyEnv = provider.get("apiKeyEnv");
  const models = modelIdsFromNode(provider.get("models"));
  let credentialCopy: LlmLocalCandidate["credentialCopy"] = "reenter";
  if (typeof apiKeyEnv === "string" && apiKeyEnv.includes("OAUTH")) {
    credentialCopy = "unsupported";
  } else if (typeof apiKeyEnv === "string" && apiKeyEnv.trim() && namedCredentialPresent(credentialText, apiKeyEnv)) {
    credentialCopy = "available";
  }
  return {
    routeId,
    displayName: typeof displayName === "string" && displayName.trim() ? displayName : routeId,
    api: typeof api === "string" ? api : undefined,
    origin: redactEndpoint(provider.get("baseURL")),
    modelIds: models,
    credentialCopy,
  };
}

function modelIdsFromNode(value: unknown): string[] {
  if (!isSeq(value)) return [];
  const ids: string[] = [];
  for (const item of value.items) {
    if (isScalar(item) && typeof item.value === "string") ids.push(item.value);
    else if (isMap(item)) {
      const id = item.get("id");
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

function yamlMapToJson(map: YAMLMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of map.items) {
    const key = isScalar(item.key) ? String(item.key.value ?? "") : "";
    if (!key || key === "apiKey" || key === "apiKeyEnv" || key === "headers") continue;
    out[key] = yamlToJson(item.value);
  }
  return out;
}

function yamlToJson(value: unknown): unknown {
  if (isScalar(value)) return value.value;
  if (isMap(value)) return yamlMapToJson(value);
  if (isSeq(value)) return value.items.map((item) => yamlToJson(item));
  return undefined;
}

function namedCredentialPresent(text: string, name: string): boolean {
  if (!text || !name) return false;
  return new RegExp(`(?:^|\\n)\\s*${escapeRegExp(name)}\\s*:`, "m").test(text);
}

function readNamedCredential(path: string, name: string): string | undefined {
  if (!existsSync(path) || !name) return undefined;
  const text = readFileSync(path, "utf8");
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(name)}\\s*:\\s*(\\S[^\\n]*)`, "m"));
  const value = match?.[1]?.trim();
  if (!value || value === '""' || value === "''") return undefined;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class FileLlmSpaceSettings implements LlmSpaceSettingsPort {
  constructor(private readonly home: string) {}

  async readDefault(spaceId: string) {
    return readSpaceDefaultModel(this.home, spaceId);
  }

  async writeDefault(spaceId: string, value: SpaceDefaultModel | null) {
    await writeSpaceDefaultModel(this.home, spaceId, value);
  }

  async listLocal(spaceId: string) {
    return listLocalLlmCandidates(this.home, spaceId);
  }

  async readLocalProvider(spaceId: string, routeId: string) {
    return readLocalProviderConfig(this.home, spaceId, routeId);
  }

  async readCopyableSecret(spaceId: string, routeId: string) {
    return readCopyableLocalSecret(this.home, spaceId, routeId);
  }

  async readImport(spaceId: string): Promise<LlmShareManifest | null> {
    const path = join(spaceDataRoot(this.home, spaceId), LLM_IMPORT_FILENAME);
    if (!existsSync(path)) return null;
    return parseLlmShareManifest(JSON.parse(readFileSync(path, "utf8")) as unknown);
  }

  async writeImport(spaceId: string, manifest: LlmShareManifest): Promise<void> {
    const parsed = parseLlmShareManifest(manifest);
    const path = join(spaceDataRoot(this.home, spaceId), LLM_IMPORT_FILENAME);
    atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  async clearImport(spaceId: string): Promise<void> {
    const path = join(spaceDataRoot(this.home, spaceId), LLM_IMPORT_FILENAME);
    if (!existsSync(path)) return;
    unlinkSync(path);
  }
}
