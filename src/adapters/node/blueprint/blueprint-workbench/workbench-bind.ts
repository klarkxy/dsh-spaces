import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { applyIsolationPatch, patchTextLooksConfigIsolated } from "../../../../core/domain/isolation";
import type { BlueprintPatch } from "@klarkxy/dsh-blueprint/v1/types";
import { atomicWrite } from "../../atomic";
import { publicError, isPublicError, modelWriteFailureReason, asDescribe, asSpacePolicy } from "./errors";
import { assertPatchSafeToApply, defeatsIsolation } from "./isolation-config";
import { BlueprintWorkbenchGenerateOps } from "./workbench-generate";

export class BlueprintWorkbenchBindOps extends BlueprintWorkbenchGenerateOps {

  protected async bindModel(spaceId: string, model: { connectionId: string; modelId: string }): Promise<void> {
    const llm = this.ports.llmAdmitted;
    if (!llm) throw publicError("This Home cannot apply a model binding.");
    try {
      const catalog = asDescribe(await llm({ method: "describe" }));
      const connection = catalog.connections.find((row) => row.id === model.connectionId);
      if (!connection || connection.enabled !== true) {
        throw publicError("The selected model connection is not available.");
      }
      const models = Array.isArray(connection.providerConfig.models)
        ? connection.providerConfig.models.flatMap((item) =>
            item && typeof item === "object" && "id" in item && typeof (item as { id?: unknown }).id === "string"
              ? [(item as { id: string }).id]
              : [],
          )
        : [];
      if (!models.includes(model.modelId)) {
        throw publicError("The selected model is not available on that connection.");
      }
      const policy = asSpacePolicy(await llm({ method: "spacePolicy", spaceId }));
      await llm({
        method: "updateSpacePolicy",
        spaceId,
        shared: { mode: "selected", connectionIds: [model.connectionId] },
        expectedRevision: policy.policy.revision,
      });
      await llm({
        method: "updateSpaceDefault",
        spaceId,
        model: { connectionId: model.connectionId, modelId: model.modelId },
      });
    } catch (error) {
      if (isPublicError(error)) throw error;
      throw publicError(modelWriteFailureReason(error));
    }
  }

  protected writeBoundPatch(spaceId: string, patch: BlueprintPatch): void {
    assertPatchSafeToApply(patch, spaceId);
    const yaml = stringifyYaml(patch, { lineWidth: 0, schema: "json" });
    const isolated = applyIsolationPatch(yaml.endsWith("\n") ? yaml : `${yaml}\n`, spaceId, "blueprint.patch");
    if (!patchTextLooksConfigIsolated(isolated, spaceId)) {
      throw publicError("The blueprint config does not isolate this space.");
    }
    if (defeatsIsolation(isolated, spaceId)) {
      throw publicError("The blueprint config points at a protected Home path.");
    }
    const writer = this.ports.writePatch ?? ((id: string, body: string) => {
      atomicWrite(join(this.ports.home, "profiles", id, "cordis.patch.yml"), body);
    });
    writer(spaceId, isolated);
  }

}
