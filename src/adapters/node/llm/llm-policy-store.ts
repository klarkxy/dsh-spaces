import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite } from "../atomic";
import { LLM_ERROR, LlmConfigError } from "../../../shared/llm-connections";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES } from "../../../shared/types";

export const LLM_POLICY_FILENAME = "llm-policy.json";

export interface SpaceLlmPolicy {
  inheritMain: boolean;
}

export function spaceDataRoot(home: string, spaceId: string): string {
  assertSafeSpaceId(spaceId);
  const root = resolve(home);
  if (spaceId === "web") return root;
  return join(root, "hub", spaceId);
}

export function llmPolicyPath(home: string, spaceId: string): string {
  return join(spaceDataRoot(home, spaceId), LLM_POLICY_FILENAME);
}

export function assertSafeSpaceId(spaceId: string): void {
  if (!PROFILE_NAME_RE.test(spaceId) || spaceId.includes("..")) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "space id is not allowed", { spaceId });
  }
  if (spaceId !== "web" && (RESERVED_PROFILE_NAMES as readonly string[]).includes(spaceId)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "space id is not allowed", { spaceId });
  }
}

export function parseSpaceLlmPolicy(value: unknown): SpaceLlmPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm policy must be an object");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "inheritMain,schemaVersion") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm policy has unexpected keys");
  }
  if (row.schemaVersion !== 1 || typeof row.inheritMain !== "boolean") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm policy is invalid");
  }
  return { inheritMain: row.inheritMain };
}

/** No file means no inheritance. A present file must parse strictly. */
export function readSpaceLlmPolicy(home: string, spaceId: string): SpaceLlmPolicy {
  const path = llmPolicyPath(home, spaceId);
  if (!existsSync(path)) return { inheritMain: false };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "policy file is not valid JSON");
  }
  return parseSpaceLlmPolicy(value);
}

/** Creation-time write; nothing updates the policy afterwards. */
export function writeSpaceLlmPolicy(home: string, spaceId: string, inheritMain: boolean): void {
  atomicWrite(
    llmPolicyPath(home, spaceId),
    `${JSON.stringify({ schemaVersion: 1, inheritMain }, null, 2)}\n`,
  );
}
