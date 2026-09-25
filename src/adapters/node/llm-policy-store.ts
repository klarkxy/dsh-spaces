import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite } from "./atomic";
import {
  LLM_ERROR,
  LlmConfigError,
  defaultPolicyFor,
  emptyPolicy,
  parsePolicy,
  type SpaceLlmPolicy,
} from "../../core/domain/llm-connections";
import type { LlmPolicyStore } from "../../core/ports/llm-store";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES } from "../../shared/types";
import { withExclusiveDir } from "./llm-file-lock";
import { LLM_POLICY_FILENAME } from "./llm-paths";

export { LLM_POLICY_FILENAME } from "./llm-paths";

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

export class FileLlmPolicyStore implements LlmPolicyStore {
  constructor(private readonly home: string) {}

  async read(spaceId: string): Promise<SpaceLlmPolicy> {
    if (!existsSync(llmPolicyPath(this.home, spaceId))) return defaultPolicyFor(spaceId);
    return readPolicyFile(llmPolicyPath(this.home, spaceId));
  }

  async write(spaceId: string, next: SpaceLlmPolicy, expectedRevision: number): Promise<SpaceLlmPolicy> {
    const path = llmPolicyPath(this.home, spaceId);
    return withExclusiveDir(`${path}.lock`, () => {
      const current = readPolicyFile(path);
      if (current.revision !== expectedRevision) {
        throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "policy revision moved", {
          expected: expectedRevision,
          actual: current.revision,
        });
      }
      if (next.revision !== expectedRevision + 1) {
        throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "policy write must increment revision by one");
      }
      const parsed = parsePolicy(next);
      atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
      return parsed;
    });
  }
}

function readPolicyFile(path: string): SpaceLlmPolicy {
  if (!existsSync(path)) return emptyPolicy();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "policy file is not valid JSON");
  }
  return parsePolicy(value);
}
