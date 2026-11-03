import type { BlueprintRecipe as Blueprint } from "@klarkxy/dsh-blueprint/document";
import type { BlueprintPatch } from "@klarkxy/dsh-blueprint/v1/types";
import type { BlueprintRuntimeInspect, BlueprintRuntimeLayerIdentity, BlueprintRuntimeCompose, BlueprintRuntimeModule, ModuleIdentityEvidence } from "./types";
import { CONTROL_PACKAGE_SET, MANAGED_ENTRY_SET } from "./constants";
import { unique, isOwnedBridgeName } from "./utils";
import { walkAllPatchEntries } from "./yaml-codec";
import { readInstalledManifest, readInstalledIdentity } from "./source-inspection";

export function officialSkippedBlueprintOverlay(warnings: string[], patch: BlueprintPatch): string | undefined {
  const overlays = new Set<string>();
  const groupInserts = new Set<string>();
  for (const item of patch) {
    if ("insert" in item && Array.isArray(item.insert)) {
      if (item.id) groupInserts.add(item.id);
      continue;
    }
    if ("id" in item && item.id) overlays.add(item.id);
  }
  for (const warning of warnings) {
    const notFound = /^patch: entry "(.+)" not found$/.exec(warning);
    if (notFound && overlays.has(notFound[1]!)) {
      return `Blueprint overlay "${notFound[1]}" was not applied.`;
    }
    const nameMismatch =
      /^patch: name mismatch for "(.+)" \(expected .+, got .+\), skipping$/.exec(warning) ??
      /^patch: entry "(.+)" name mismatch/.exec(warning);
    if (nameMismatch && overlays.has(nameMismatch[1]!)) {
      return `Blueprint overlay "${nameMismatch[1]}" was skipped because the entry name does not match.`;
    }
    const notGroup = /^patch insert: entry "(.+)" is not a group$/.exec(warning);
    if (notGroup && groupInserts.has(notGroup[1]!)) {
      return `Blueprint insert target "${notGroup[1]}" is not a group.`;
    }
    const insertMissing = /^patch insert: entry "(.+)" not found$/.exec(warning);
    if (insertMissing && groupInserts.has(insertMissing[1]!)) {
      return `Blueprint overlay "${insertMissing[1]}" was not applied.`;
    }
  }
  return undefined;
}

export function selectedBundleIdentityError(blueprint: Blueprint, layers: BlueprintRuntimeLayerIdentity[]): string | undefined {
  const byName = new Map(
    layers
      .filter((layer) => layer && typeof layer.name === "string" && typeof layer.version === "string")
      .map((layer) => [layer.name, layer.version]),
  );
  for (const name of blueprint.profile.bundles) {
    const selected = blueprint.packages.find((pkg) => pkg.name === name);
    const version = byName.get(name);
    if (!version) return `Package ${name} did not resolve as a composed layer.`;
    if (selected && version !== selected.version) {
      return `Package ${name} resolved to a different version than the selected pin.`;
    }
  }
  return undefined;
}

export function patchModuleSpecifiers(patch: BlueprintPatch): string[] {
  const names: string[] = [];
  walkAllPatchEntries(patch, (entry) => {
    if (entry.name) names.push(entry.name);
  });
  return unique(names);
}

export function moduleResolutionEvidence(
  home: string,
  spaceId: string,
  blueprint: Blueprint,
  composed: BlueprintRuntimeCompose | undefined,
  inspected: BlueprintRuntimeInspect | null,
): ModuleIdentityEvidence[] {
  const evidence: ModuleIdentityEvidence[] = [];
  const seen = new Set<string>();
  const add = (name: string, version: string | null) => {
    const key = `${name}@${version ?? "*"}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ name, version });
  };
  for (const pkg of blueprint.packages) {
    const installed = readInstalledManifest(home, spaceId, pkg.name);
    for (const dep of installed?.dependencies ?? []) {
      const identity = readInstalledIdentity(home, spaceId, dep);
      if (identity) add(dep, identity.version);
    }
  }
  if (composed) {
    for (const layer of composed.layers) {
      if (layer.name && layer.version) add(layer.name, layer.version);
    }
  }
  if (inspected) {
    for (const layer of inspected.baseLayers) {
      if (layer.name && layer.version) add(layer.name, layer.version);
    }
    addUnknownEntryNames(inspected.baseEntries, add);
  }
  return evidence;
}

function addUnknownEntryNames(entries: unknown[], add: (name: string, version: string | null) => void): void {
  walkUnknownPatchItems(entries, (item) => {
    if (typeof item.name === "string" && item.name) add(item.name, null);
  });
}

export function resolvedIdentityAllowed(resolved: BlueprintRuntimeModule, evidence: ModuleIdentityEvidence[]): boolean {
  if (!resolved.packageName || resolved.packageVersion == null) return false;
  return evidence.some((row) => {
    if (row.name !== resolved.packageName) return false;
    if (row.version == null) return true;
    return row.version === resolved.packageVersion;
  });
}

export function homePatchesOverrideManaged(entries: unknown[]): boolean {
  let found = false;
  walkUnknownPatchItems(entries, (item) => {
    if (typeof item.id === "string" && MANAGED_ENTRY_SET.has(item.id)) found = true;
    if (typeof item.name === "string" && (CONTROL_PACKAGE_SET.has(item.name) || isOwnedBridgeName(item.name))) {
      found = true;
    }
  });
  return found;
}

function walkUnknownPatchItems(entries: unknown, visit: (item: Record<string, unknown>) => void): void {
  if (!Array.isArray(entries)) return;
  for (const item of entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    visit(rec);
    if (Array.isArray(rec.insert)) walkUnknownPatchItems(rec.insert, visit);
    if (rec.group === true && Array.isArray(rec.config)) walkUnknownPatchItems(rec.config, visit);
  }
}

export function composedManagedIsolationError(entries: unknown[], spaceId: string): string | undefined {
  let foreign = false;
  walkUnknownPatchItems(entries, (item) => {
    if (typeof item.id !== "string" || !MANAGED_ENTRY_SET.has(item.id)) return;
    const config = item.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) return;
    const rec = config as Record<string, unknown>;
    if (pointsAtForeignSpaceHub(isolationConfigText(rec.path ?? rec.root), spaceId)) foreign = true;
  });
  return foreign ? "Home configuration overrides managed isolation or control entries." : undefined;
}

function isolationConfigText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (typeof rec.__jsExpr === "string") return rec.__jsExpr;
  }
  return "";
}

function pointsAtForeignSpaceHub(text: string, spaceId: string): boolean {
  if (!text) return false;
  const match = /(?:^|[ '"\\/])hub[\\/]([^\\/'"]+)[\\/]/.exec(text);
  if (!match) return false;
  return match[1] !== spaceId;
}
