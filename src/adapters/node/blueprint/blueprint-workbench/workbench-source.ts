import type { WorkbenchBlueprintSourcePayload } from "../../../../shared/workbench-blueprint";
import { readPluginLibrary } from "../../products/plugin-library";
import { sourcePackages, withBuiltinSources, sourceBundles, describePatch, describeSettings, readProfileManifest } from "./source-inspection";
import { BlueprintWorkbenchBase } from "./workbench-base";

export class BlueprintWorkbenchSourceOps extends BlueprintWorkbenchBase {

  async source(spaceId: string): Promise<WorkbenchBlueprintSourcePayload> {
    const id = this.requireMutableSpace(spaceId, { mustExist: true });
    const manifest = readProfileManifest(this.ports.home, id);
    const library = readPluginLibrary(this.ports.home);
    const packages = withBuiltinSources(sourcePackages(this.ports.home, id, manifest, library), manifest, await this.inspectRuntimeSnapshot(undefined, id));
    const bundles = sourceBundles(manifest.bundles, packages);
    const patchInfo = describePatch(this.ports.home, id);
    const settingsNamespaces = describeSettings(this.ports.home, id);
    const localObservations = [
      ...patchInfo.observations,
      ...settingsNamespaces.flatMap((row) => row.observations),
    ];
    return {
      method: "blueprint.source",
      spaceId: id,
      packages,
      bundles,
      patch: patchInfo.info,
      settingsNamespaces: settingsNamespaces.map((row) => row.info),
      localObservations,
      host: await this.hostVersions(id),
    };
  }

}
