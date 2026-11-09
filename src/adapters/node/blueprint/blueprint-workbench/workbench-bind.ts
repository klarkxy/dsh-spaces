import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { applyIsolationPatch, patchTextLooksConfigIsolated } from "../../../../core/domain/isolation";
import type { BlueprintPatch } from "@klarkxy/dsh-blueprint/v1/types";
import { atomicWrite } from "../../atomic";
import { publicError } from "./errors";
import { assertPatchSafeToApply, defeatsIsolation } from "./isolation-config";
import { BlueprintWorkbenchGenerateOps } from "./workbench-generate";

export class BlueprintWorkbenchBindOps extends BlueprintWorkbenchGenerateOps {

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
