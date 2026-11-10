import { join, resolve } from "node:path";
import { LLM_ERROR, LlmConfigError } from "../../../shared/llm-connections";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES } from "../../../shared/types";

/** Isolated data root of a space: the Home itself for web, hub/<id> for managed spaces. */
export function spaceDataRoot(home: string, spaceId: string): string {
  assertSafeSpaceId(spaceId);
  const root = resolve(home);
  if (spaceId === "web") return root;
  return join(root, "hub", spaceId);
}

export function assertSafeSpaceId(spaceId: string): void {
  if (!PROFILE_NAME_RE.test(spaceId) || spaceId.includes("..")) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "space id is not allowed", { spaceId });
  }
  if (spaceId !== "web" && (RESERVED_PROFILE_NAMES as readonly string[]).includes(spaceId)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "space id is not allowed", { spaceId });
  }
}
