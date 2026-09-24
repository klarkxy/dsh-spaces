import type { GlobalLlmCatalog, LlmSharedSnapshot, SpaceLlmPolicy } from "../../../src/core/domain/llm-connections";
import { snapshotForSpace } from "../../../src/core/domain/llm-resolution";

export function freezeSpaceSnapshot(
  catalog: GlobalLlmCatalog,
  policy: SpaceLlmPolicy,
  adapterVersion: string,
): LlmSharedSnapshot {
  return snapshotForSpace(catalog, policy, adapterVersion);
}
