import { join } from "node:path";
import type { BlueprintRecipe as Blueprint } from "@klarkxy/dsh-blueprint/document";
import type { BlueprintPatch } from "@klarkxy/dsh-blueprint/v1/types";
import { SPACE_NAME_RE, spaceIdFromName } from "../../../../shared/types";
import type { BlueprintHostVersions } from "../../../../shared/workbench-blueprint";
import { assertNotRealHome } from "../../home/home-guard";
import { settingsPath } from "../../home/hub-settings";
import type { BlueprintRuntimeOptions, BlueprintRuntimeInspect, BlueprintRuntimeCompose, BlueprintRuntimeModule, BlueprintWorkbenchPorts, PlanObservation, StagedPlan } from "./types";
import { INSPECT_RUNTIME_FAILED } from "./constants";
import { sha256Hex, exactOrNull } from "./utils";
import { publicError, compositionFailureReason, assertMutableName } from "./errors";
import { readProfileManifest, fileDigest } from "./source-inspection";
import { officialSkippedBlueprintOverlay, selectedBundleIdentityError, patchModuleSpecifiers, moduleResolutionEvidence, resolvedIdentityAllowed, homePatchesOverrideManaged, composedManagedIsolationError } from "./runtime-composition";

export class BlueprintWorkbenchBase {
  protected readonly ports: BlueprintWorkbenchPorts;
  protected readonly plans = new Map<string, StagedPlan>();
  protected totalPlanBytes = 0;

  constructor(ports: BlueprintWorkbenchPorts) {
    assertNotRealHome(ports.home);
    this.ports = ports;
  }

  async hostVersions(spaceId?: string): Promise<BlueprintHostVersions> {
    const inspected = await this.inspectRuntimeSnapshot(undefined, spaceId);
    const ports = this.portHostVersions();
    return {
      ...ports,
      dsh: exactOrNull(inspected?.versions.dsh ?? this.ports.dshVersion?.() ?? null),
      base: exactOrNull(inspected?.versions.base ?? null),
      webApp: exactOrNull(inspected?.versions.webApp ?? null),
    };
  }

  protected portHostVersions(): BlueprintHostVersions {
    return {
      dsh: exactOrNull(this.ports.dshVersion?.() ?? null),
      spaces: exactOrNull(this.ports.spacesVersion?.() ?? null),
      node: process.versions.node,
      os: process.platform,
      arch: process.arch,
      base: null,
      webApp: null,
    };
  }

  private runtimeOptions(spaceId?: string): BlueprintRuntimeOptions | null {
    const bin = this.ports.runtimeBin?.(spaceId);
    if (!bin) return null;
    return { home: this.ports.home, bin };
  }

  protected async inspectRuntimeSnapshot(blueprint?: Blueprint, spaceId?: string): Promise<BlueprintRuntimeInspect | null> {
    const options = this.runtimeOptions(spaceId);
    if (!options || !this.ports.inspectRuntime) return null;
    if (blueprint) options.builtinPackages = blueprint.packages.filter((pkg) => pkg.source.type === "builtin").map((pkg) => pkg.name);
    try {
      return await this.ports.inspectRuntime(options);
    } catch {
      throw publicError(INSPECT_RUNTIME_FAILED);
    }
  }

  protected async builtinIdentityError(blueprint: Blueprint): Promise<string | undefined> {
    const packages = blueprint.packages.filter((pkg) => pkg.source.type === "builtin");
    if (!blueprint.packages.length) return undefined;
    let inspected: BlueprintRuntimeInspect | null;
    try {
      inspected = await this.inspectRuntimeSnapshot(blueprint);
    } catch {
      return "A selected builtin is unavailable in the bound runtime.";
    }
    const catalog = inspected?.builtinCatalog ?? inspected?.builtinLayers?.map((layer) => layer.name) ?? [];
    if (blueprint.packages.some((pkg) => pkg.source.type === "npm" && catalog.includes(pkg.name))) {
      return "A shipped builtin cannot be installed from an npm source.";
    }
    for (const pkg of packages) {
      const layer = inspected?.builtinLayers?.find((item) => item.name === pkg.name);
      if (!layer || layer.version !== pkg.version) return "A selected builtin does not match its exact bound runtime identity.";
    }
    return undefined;
  }

  protected async modelAvailabilityError(model: { connectionId: string; modelId: string } | undefined): Promise<string | undefined> {
    if (!model) return undefined;
    return "This Home cannot apply a model binding.";
  }

  protected async homePatchOverrideError(): Promise<string | undefined> {
    const inspected = await this.inspectRuntimeSnapshot();
    if (!inspected) return undefined;
    if (homePatchesOverrideManaged(inspected.homePatches)) {
      return "Home configuration overrides managed isolation or control entries.";
    }
    return undefined;
  }

  protected async compositionPreflightError(blueprint: Blueprint): Promise<string | undefined> {
    if (blueprint.profile.patch.length === 0 && blueprint.profile.bundles.length === 0) return undefined;
    const options = this.runtimeOptions();
    if (!options || !this.ports.composeRuntime) {
      return "Blueprint composition cannot be verified.";
    }
    return undefined;
  }

  protected async compositionError(
    spaceId: string,
    blueprint: Blueprint,
    patch: BlueprintPatch,
    extra?: { force?: boolean },
  ): Promise<string | undefined> {
    if (!extra?.force && patch.length === 0 && blueprint.profile.bundles.length === 0) return undefined;
    const options = this.runtimeOptions(spaceId);
    if (!options || !this.ports.composeRuntime) {
      return "Blueprint composition cannot be verified.";
    }

    let composed: BlueprintRuntimeCompose;
    try {
      composed = await this.ports.composeRuntime(options, {
        spaceId,
        bundles: readProfileManifest(this.ports.home, spaceId).bundles,
        patch,
      });
    } catch (error) {
      return compositionFailureReason(error);
    }
    const skipped = officialSkippedBlueprintOverlay(composed.warnings, patch);
    if (skipped) return skipped;
    const identity = selectedBundleIdentityError(blueprint, composed.layers);
    if (identity) return identity;
    const isolation = composedManagedIsolationError(composed.entries, spaceId);
    if (isolation) return isolation;

    const specifiers = patchModuleSpecifiers(patch);
    if (specifiers.length === 0) return undefined;
    if (!this.ports.resolveModule) return "Blueprint composition cannot be verified.";
    let inspected: BlueprintRuntimeInspect | null;
    try {
      inspected = await this.inspectRuntimeSnapshot(undefined, spaceId);
    } catch {
      return INSPECT_RUNTIME_FAILED;
    }
    const evidence = moduleResolutionEvidence(this.ports.home, spaceId, blueprint, composed, inspected);
    for (const specifier of specifiers) {
      let resolved: BlueprintRuntimeModule;
      try {
        resolved = await this.ports.resolveModule(options, { spaceId, specifier });
      } catch (error) {
        return compositionFailureReason(error, "A patch module could not be resolved.");
      }
      if (resolved.builtin) continue;
      if (!resolved.resolvedPath) return "A patch module could not be resolved.";
      const selected = blueprint.packages.find((pkg) => pkg.name === resolved.packageName);
      if (selected) {
        if (!resolved.packageVersion || resolved.packageVersion !== selected.version) {
          return `Package ${selected.name} resolved to a different version than the selected pin.`;
        }
        continue;
      }
      if (!resolvedIdentityAllowed(resolved, evidence)) {
        return "A patch module does not resolve to a selected, transitive, or host package.";
      }
    }
    return undefined;
  }

  protected async captureObservation(blueprint?: Blueprint): Promise<PlanObservation> {
    const observation = this.ports.observation();
    const host = await this.hostVersions();
    const inspected = await this.inspectRuntimeSnapshot(blueprint);
    return {
      serviceEpoch: observation.serviceEpoch,
      stateRevision: observation.expectedRevision,
      dshVersion: host.dsh,
      hostBaseVersion: host.base,
      hostWebAppVersion: host.webApp,
      homeSettingsDigest: fileDigest(settingsPath(this.ports.home)),
      homePatchDigest: fileDigest(join(this.ports.home, "cordis.patch.yml")),
      runtimeFingerprint: inspected?.fingerprint ?? sha256Hex(`${host.dsh ?? ""}|${host.base ?? ""}|${host.webApp ?? ""}|${fileDigest(join(this.ports.home, "cordis.patch.yml"))}`),
    };
  }

  protected requireMutableSpace(spaceId: string, options: { mustExist?: boolean }): string {
    assertMutableName(spaceId, this.ports.managerId());
    if (options.mustExist && !this.ports.listSpaces().some((row) => row.id === spaceId)) {
      throw publicError("That space was not found.");
    }
    return spaceId;
  }

  protected requireNewSpaceName(name: string): string {
    if (!SPACE_NAME_RE.test(name)) throw publicError("That space name is not allowed.");
    if (this.ports.listSpaces().some((row) => row.id === spaceIdFromName(name))) {
      throw publicError("A space with that name already exists.");
    }
    return name;
  }

}
