import type { BlueprintRecipe as Blueprint } from "@klarkxy/dsh-blueprint/document";
import { BLUEPRINT_ARCH, BLUEPRINT_OS, type BlueprintArch, type BlueprintBinding, type BlueprintDiagnostic, type BlueprintInputValues, type BlueprintJson, type BlueprintOs, type BlueprintPackageEvidence, type BlueprintPatch, type BlueprintSettings } from "@klarkxy/dsh-blueprint/v1/types";
import { scanShareEntries } from "../../../../shared/llm-share";
import type { BlueprintHostVersions, BlueprintPreviewInput } from "../../../../shared/workbench-blueprint";
import { HOST_PACKAGE_SET, CONTROL_PACKAGE_SET, MANAGED_ENTRY_SET, FORBIDDEN_SETTINGS, GITHUB_APPLY_MESSAGE } from "./constants";
import { isOwnedBridgeName, looksLikeModulePath } from "./utils";
import { hasJsExpr, walkPatchEntries, findLocalPointers, jsonLooksCredential } from "./yaml-codec";

export function blockingApplyDiagnostics(
  blueprint: Blueprint,
): { diagnostics: BlueprintDiagnostic[]; errors: string[] } {
  const diagnostics: BlueprintDiagnostic[] = [];
  const errors: string[] = [];
  const push = (message: string, path?: string) => {
    diagnostics.push({ code: "blueprint.unsupported", message, severity: "error", path });
    errors.push(message);
  };
  if (blueprint.packages.some((pkg) => pkg.source.type === "github")) {
    push(GITHUB_APPLY_MESSAGE);
  }
  for (const pkg of blueprint.packages) {
    if (HOST_PACKAGE_SET.has(pkg.name) || CONTROL_PACKAGE_SET.has(pkg.name) || isOwnedBridgeName(pkg.name) || pkg.name === "@klarkxy/dsh-blueprint") {
      push("Owned host or control components cannot be supplied by a blueprint.");
    }
  }
  for (const namespace of Object.keys(blueprint.profile.settings)) {
    if (FORBIDDEN_SETTINGS.has(namespace)) {
      push("Managed model settings cannot be applied from a blueprint.", `/profile/settings/${namespace}`);
    }
  }
  walkPatchEntries(blueprint.profile.patch, (entry, pointer) => {
    if (MANAGED_ENTRY_SET.has(entry.id)) {
      push("Managed isolation fields cannot be supplied by a blueprint.", `${pointer}/id`);
    }
    if (entry.name && looksLikeModulePath(entry.name)) {
      push("Patch module references must be package names.", `${pointer}/name`);
    }
    if (hasJsExpr(entry as unknown as BlueprintJson, pointer, [])) {
      push("Dynamic expressions cannot be applied.", pointer);
    }
  });
  if (hasJsExpr(blueprint.profile.settings, "/profile/settings", [])) {
    push("Dynamic expressions cannot be applied.", "/profile/settings");
  }
  return { diagnostics, errors };
}

export function previewInputs(blueprint: Blueprint, values: BlueprintInputValues): BlueprintPreviewInput[] {
  return blueprint.inputs.map((input) => {
    if (Object.prototype.hasOwnProperty.call(values, input.id)) {
      return { id: input.id, type: input.type, origin: "explicit" as const, value: values[input.id] };
    }
    if (input.default !== undefined) {
      return { id: input.id, type: input.type, origin: "default" as const, value: input.default };
    }
    return { id: input.id, type: input.type, origin: "missing" as const };
  });
}

export function isRequiredInput(blueprint: Blueprint, id: string): boolean {
  return blueprint.inputs.some((input) => input.id === id && input.required);
}

export function findUndeclaredLocals(patch: BlueprintPatch, settings: BlueprintSettings, bindings: BlueprintBinding[]): string | null {
  const bound = new Set(
    bindings.flatMap((item) => (item.target.kind === "value" ? [item.target.pointer] : [])),
  );
  const found = [
    ...findLocalPointers(patch as unknown as BlueprintJson, "/profile/patch"),
    ...findLocalPointers(settings, "/profile/settings"),
  ];
  const leftover = found.find((item) => !bound.has(item.pointer));
  return leftover?.pointer ?? null;
}

export function secretFindingsOfBlueprint(blueprint: Blueprint): string | undefined {
  return secretFindingsOfConfig(blueprint.profile.patch, blueprint.profile.settings);
}

export function secretFindingsOfConfig(patch: BlueprintPatch, settings: BlueprintSettings): string | undefined {
  const payload = JSON.stringify({ patch, settings });
  const findings = scanShareEntries([{ name: "blueprint.json", data: payload }]).filter(
    (finding) => finding.reason !== "absolute path",
  );
  if (findings.length) return findings[0]?.path;
  if (jsonLooksCredential(settings, "/profile/settings", []) || jsonLooksCredential(patch as unknown as BlueprintJson, "/profile/patch", [])) {
    return "/profile";
  }
  return undefined;
}

export function environmentFromHost(host: BlueprintHostVersions, packages?: BlueprintPackageEvidence[]) {
  const os = (BLUEPRINT_OS as readonly string[]).includes(host.os) ? (host.os as BlueprintOs) : undefined;
  const arch = (BLUEPRINT_ARCH as readonly string[]).includes(host.arch) ? (host.arch as BlueprintArch) : undefined;
  return {
    dsh: host.dsh ?? undefined,
    spaces: host.spaces ?? undefined,
    node: host.node,
    os,
    arch,
    packages,
  };
}

export function evidenceFromBlueprint(blueprint: Blueprint): BlueprintPackageEvidence[] {
  return blueprint.packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    selected: true,
    bundled: blueprint.profile.bundles.includes(pkg.name),
  }));
}
