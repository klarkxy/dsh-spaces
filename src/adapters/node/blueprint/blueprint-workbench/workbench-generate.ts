import { diagnoseDocument } from "@klarkxy/dsh-blueprint/document";
import { encodeBlueprintDocument, stringifyBlueprintDocument } from "@klarkxy/dsh-blueprint/document-codec";
import { generateBlueprintV2 } from "../blueprint-v2";
import type { BlueprintGenerateBindingOverride, BlueprintGenerateSelection, WorkbenchBlueprintGeneratePayload } from "../../../../shared/workbench-blueprint";
import { readPluginLibrary } from "../../products/plugin-library";
import { publicError, sanitizePublicMessage } from "./errors";
import { findUndeclaredLocals, secretFindingsOfBlueprint, environmentFromHost } from "./diagnostics";
import { sourcePackages, withBuiltinSources, readProfileManifest, sourceFingerprint } from "./source-inspection";
import { buildGeneratedBlueprint, blueprintFileName } from "./generate-blueprint";
import { BlueprintWorkbenchSourceOps } from "./workbench-source";

export class BlueprintWorkbenchGenerateOps extends BlueprintWorkbenchSourceOps {

  async generate(input: {
    formatVersion?: 1 | 2;
    spaceId: string;
    selection: BlueprintGenerateSelection;
    metadata: { name: string; version?: string; description?: string };
    bindingOverrides?: BlueprintGenerateBindingOverride[];
  }): Promise<WorkbenchBlueprintGeneratePayload> {
    const id = this.requireMutableSpace(input.spaceId, { mustExist: true });
    if (input.formatVersion === 2) {
      const before = sourceFingerprint(this.ports.home, id);
      const inspected = await this.inspectRuntimeSnapshot(undefined, id);
      const manifest = readProfileManifest(this.ports.home, id);
      const available = withBuiltinSources(sourcePackages(this.ports.home, id, manifest, readPluginLibrary(this.ports.home)), manifest, inspected);
      let blueprint;
      try {
        blueprint = generateBlueprintV2(input, available, manifest.bundles);
      } catch (error) {
        throw publicError(sanitizePublicMessage(error instanceof Error ? error.message : "Blueprint generation failed."));
      }
      const rechecked = await this.inspectRuntimeSnapshot(undefined, id);
      if (before !== sourceFingerprint(this.ports.home, id) || inspected?.fingerprint !== rechecked?.fingerprint) {
        throw publicError("The space changed while the blueprint was being generated.");
      }
      return {
        method: "blueprint.generate", blueprint,
        fileName: blueprintFileName(blueprint.metadata.name),
        json: stringifyBlueprintDocument(blueprint), shareCode: encodeBlueprintDocument(blueprint),
        diagnostics: diagnoseDocument(blueprint, environmentFromHost(await this.hostVersions(id))),
      };
    }
    if (!input.metadata.version) throw publicError("Blueprint v1 requires a metadata version.");
    const runtime = await this.inspectRuntimeSnapshot(undefined, id);
    const builtinNames = runtime?.builtinCatalog ?? runtime?.builtinLayers?.map((layer) => layer.name) ?? [];
    if (builtinNames.some((name) => input.selection.packages.includes(name))) {
      throw publicError("Builtin identities require Blueprint format version 2.");
    }
    const before = sourceFingerprint(this.ports.home, id);
    const built = buildGeneratedBlueprint(this.ports.home, id, { ...input, metadata: { ...input.metadata, version: input.metadata.version } });
    const after = sourceFingerprint(this.ports.home, id);
    if (before !== after) {
      throw publicError("The space changed while the blueprint was being generated.");
    }
    const secret = secretFindingsOfBlueprint(built);
    if (secret) {
      throw publicError("The selected configuration contains a secret and cannot be shared.", secret);
    }
    const leftover = findUndeclaredLocals(built.profile.patch, built.profile.settings, built.bindings);
    if (leftover) {
      throw publicError("A local value must be declared as an input.", leftover);
    }
    const blueprint = built.document;
    const diagnostics = diagnoseDocument(blueprint, environmentFromHost(await this.hostVersions(id)));
    const json = stringifyBlueprintDocument(blueprint);
    const shareCode = encodeBlueprintDocument(blueprint, "shortest");
    return {
      method: "blueprint.generate",
      fileName: blueprintFileName(blueprint.metadata.name, built.metadata.version),
      json,
      shareCode,
      blueprint,
      diagnostics,
    };
  }

}
