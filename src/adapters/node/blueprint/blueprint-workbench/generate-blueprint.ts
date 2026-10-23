import { parseBlueprint } from "../../../../core/domain/blueprint";
import { blueprintRecipe, type BlueprintRecipe as Blueprint } from "@klarkxy/dsh-blueprint/document";
import { decodeBlueprintDocument } from "@klarkxy/dsh-blueprint/document-codec";
import type { BlueprintBinding, BlueprintInput, BlueprintJson, BlueprintJsonObject, BlueprintPackage, BlueprintPatch, BlueprintSettings } from "../../../../shared/blueprint";
import type { BlueprintGenerateBindingOverride, BlueprintGenerateSelection, BlueprintOriginRecord } from "../../../../shared/workbench-blueprint";
import { readPluginLibrary } from "../../products/plugin-library";
import type { OriginRecipe } from "./types";
import { unique, cloneJson } from "./utils";
import { publicError, sanitizeBlueprintError } from "./errors";
import { walkAllPatchEntries, settingsNamespaceOf, pointerExists, parentJsonPointer, lastJsonPointerToken, configBindingSuffix, readPointer, setPointer } from "./yaml-codec";
import { findUndeclaredLocals, secretFindingsOfConfig } from "./diagnostics";
import { sourcePackages, describeSettings, convertSourcePatch, readProfileManifest } from "./source-inspection";
import { readOrigin, maybeModelInput } from "./isolation-config";

export function buildGeneratedBlueprint(
  home: string,
  spaceId: string,
  input: {
    selection: BlueprintGenerateSelection;
    metadata: { name: string; version: string; description?: string };
    bindingOverrides?: BlueprintGenerateBindingOverride[];
  },
): Blueprint {
  const origin = readOrigin(home, spaceId);
  const manifest = readProfileManifest(home, spaceId);
  const library = readPluginLibrary(home);
  const available = sourcePackages(home, spaceId, manifest, library);
  const selected = unique(input.selection.packages);
  for (const name of selected) {
    const row = available.find((item) => item.name === name);
    if (!row) throw publicError(`Package ${name} is not a direct dependency of this space.`, `/packages/${name}`);
    if (!row.eligibility.available) {
      throw publicError(row.eligibility.reason ?? `Package ${name} cannot be included.`, `/packages/${name}`);
    }
  }

  let patch: BlueprintPatch = [];
  if (input.selection.includePatch) {
    const patchState = convertSourcePatch(home, spaceId);
    if (patchState.secret) {
      throw publicError("The selected configuration contains a secret and cannot be shared.", "/profile/patch");
    }
    if (!patchState.shareable && !patchState.convertible) {
      throw publicError(patchState.reason ?? "The selected configuration preset cannot be shared.", "/profile/patch");
    }
    patch = patchState.patch;
  }
  const described = describeSettings(home, spaceId);
  let settings: BlueprintSettings = {};
  for (const namespace of unique(input.selection.settingsNamespaces)) {
    const row = described.find((item) => item.info.namespace === namespace);
    if (!row) throw publicError(`Settings namespace ${namespace} was not found.`, `/profile/settings/${namespace}`);
    if (row.info.reason && !row.info.convertible && !row.info.shareable) {
      throw publicError(row.info.reason, `/profile/settings/${namespace}`);
    }
    if (!row.info.shareable && !row.info.convertible) {
      throw publicError(row.info.reason ?? `Settings namespace ${namespace} cannot be shared.`, `/profile/settings/${namespace}`);
    }
    settings[namespace] = row.value;
  }

  const packages: BlueprintPackage[] = selected.map((name) => {
    const row = available.find((item) => item.name === name)!;
    const pkg: BlueprintPackage = {
      name,
      version: row.version as string,
      source: { type: "npm" },
    };
    if (row.integrity) pkg.integrity = row.integrity;
    return pkg;
  });
  const bundles = manifest.bundles.filter((name) => selected.includes(name));
  let inputs: BlueprintInput[] = [];
  let bindings: BlueprintBinding[] = [];
  const overrides = input.bindingOverrides ?? [];

  if (origin) {
    const restored = restoreProvenanceOnCurrent(
      origin,
      patch,
      settings,
      input.selection.includePatch,
      unique(input.selection.settingsNamespaces),
      overrides,
    );
    patch = restored.patch;
    settings = restored.settings;
    inputs = restored.inputs;
    bindings = restored.bindings;
  }

  ({ patch, settings, inputs, bindings } = applyBindingOverrides(patch, settings, inputs, bindings, overrides));

  const leftover = findUndeclaredLocals(patch, settings, bindings);
  if (leftover) {
    throw publicError("A local value must be declared as an input.", leftover);
  }
  const secret = secretFindingsOfConfig(patch, settings);
  if (secret) {
    throw publicError("The selected configuration contains a secret and cannot be shared.", secret);
  }

  const model = maybeModelInput(home, spaceId, origin);
  if (model && !inputs.some((item) => item.id === model.input.id)) {
    inputs = [...inputs, model.input];
    bindings = [...bindings, model.binding];
  }

  const object: Record<string, unknown> = {
    kind: "dsh-blueprint",
    formatVersion: 1,
    metadata: metadataOf(input.metadata),
    packages,
    profile: { base: "web", bundles, patch, settings },
  };
  if (inputs.length) object.inputs = inputs;
  if (bindings.length) object.bindings = bindings;
  if (origin?.blueprint.relations?.length) {
    object.relations = origin.blueprint.relations.filter(
      (relation) => selected.includes(relation.from) || selected.includes(relation.to),
    );
  }
  if (origin?.blueprint.extensions) object.extensions = origin.blueprint.extensions;
  return blueprintRecipe(parseBlueprint(object));
}

function restoreProvenanceOnCurrent(
  origin: OriginRecipe,
  patch: BlueprintPatch,
  settings: BlueprintSettings,
  includePatch: boolean,
  namespaces: string[],
  overrides: BlueprintGenerateBindingOverride[],
): {
  patch: BlueprintPatch;
  settings: BlueprintSettings;
  inputs: BlueprintInput[];
  bindings: BlueprintBinding[];
} {
  const nextPatch = cloneJson(patch);
  const nextSettings = cloneJson(settings);
  const inputs: BlueprintInput[] = [];
  const bindings: BlueprintBinding[] = [];
  const root = { profile: { patch: nextPatch, settings: nextSettings } };
  for (const recorded of origin.bindings) {
    const input = origin.blueprint.inputs.find((item) => item.id === recorded.input);
    if (!input) continue;
    if (recorded.kind === "default-model") {
      if (!inputs.some((item) => item.id === input.id)) inputs.push(input);
      bindings.push({ input: input.id, target: { kind: "default-model" } });
      continue;
    }
    if (!recorded.pointer) continue;
    if (recorded.pointer.startsWith("/profile/patch") && !includePatch) continue;
    const namespace = recorded.namespace ?? settingsNamespaceOf(recorded.pointer);
    if (namespace && !namespaces.includes(namespace)) continue;
    const located = locateProvenancePointer(root, recorded);
    const remap = authoritativeRemapPointer(root, recorded, overrides);
    if (located.ok) {
      const replaced = overrides.some(
        (item) => item.pointer === located.pointer || item.input.id === recorded.input,
      );
      setPointer(root as unknown as BlueprintJsonObject, located.pointer, null);
      if (replaced) continue;
      if (!inputs.some((item) => item.id === input.id)) inputs.push(input);
      bindings.push({ input: input.id, target: { kind: "value", pointer: located.pointer } });
      continue;
    }
    if (remap) {
      setPointer(root as unknown as BlueprintJsonObject, remap, null);
      continue;
    }
    throw publicError(
      "A binding location changed and needs an explicit override.",
      recorded.pointer,
    );
  }
  return { patch: nextPatch, settings: nextSettings, inputs, bindings };
}

function authoritativeRemapPointer(
  root: { profile: { patch: BlueprintPatch; settings: BlueprintSettings } },
  recorded: BlueprintOriginRecord["bindings"][number],
  overrides: BlueprintGenerateBindingOverride[],
): string | undefined {
  if (!recorded.pointer) return undefined;
  if (recorded.pointer.startsWith("/profile/settings")) {
    const hit = overrides.find((item) => item.pointer === recorded.pointer && pointerExists(root, item.pointer));
    return hit?.pointer;
  }
  const uniquePointer = uniqueEntryConfigPointer(root, recorded);
  if (!uniquePointer) return undefined;
  const hit = overrides.find((item) => item.pointer === uniquePointer);
  return hit ? uniquePointer : undefined;
}

function uniqueEntryConfigPointer(
  root: { profile: { patch: BlueprintPatch } },
  recorded: BlueprintOriginRecord["bindings"][number],
): string | undefined {
  if (!recorded.entryId || !recorded.pointer) return undefined;
  const suffix = configBindingSuffix(recorded.pointer);
  if (suffix === undefined) return undefined;
  const matches: string[] = [];
  walkAllPatchEntries(root.profile.patch, (entry, pointer) => {
    if (entry.id === recorded.entryId) matches.push(`${pointer}${suffix}`);
  });
  const uniqueMatches = unique(matches);
  return uniqueMatches.length === 1 ? uniqueMatches[0] : undefined;
}

function locateProvenancePointer(
  root: { profile: { patch: BlueprintPatch; settings: BlueprintSettings } },
  recorded: BlueprintOriginRecord["bindings"][number],
): { ok: true; pointer: string } | { ok: false } {
  const recordedPointer = recorded.pointer;
  if (!recordedPointer) return { ok: false };
  if (recordedPointer.startsWith("/profile/settings")) {
    if (pointerExists(root, recordedPointer)) return { ok: true, pointer: recordedPointer };
    const parentPointer = parentJsonPointer(recordedPointer);
    if (!parentPointer || !pointerExists(root, parentPointer)) return { ok: false };
    const parent = readPointer(root as unknown as BlueprintJson, parentPointer);
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) return { ok: false };
    const leaf = lastJsonPointerToken(recordedPointer);
    if (!leaf) return { ok: false };
    (parent as BlueprintJsonObject)[leaf] = null;
    return { ok: true, pointer: recordedPointer };
  }
  if (recorded.entryId) {
    const suffix = configBindingSuffix(recordedPointer);
    if (suffix === undefined) return { ok: false };
    const matches: string[] = [];
    walkAllPatchEntries(root.profile.patch, (entry, pointer) => {
      if (entry.id !== recorded.entryId) return;
      if (recorded.entryName && entry.name !== recorded.entryName) return;
      matches.push(`${pointer}${suffix}`);
    });
    const uniqueMatches = unique(matches);
    if (uniqueMatches.length === 1) {
      const pointer = uniqueMatches[0]!;
      if (pointerExists(root, pointer)) return { ok: true, pointer };
      const parentPointer = parentJsonPointer(pointer);
      if (parentPointer && pointerExists(root, parentPointer)) {
        const parent = readPointer(root as unknown as BlueprintJson, parentPointer);
        if (parent && typeof parent === "object" && !Array.isArray(parent)) {
          const leaf = lastJsonPointerToken(pointer);
          if (leaf) {
            (parent as BlueprintJsonObject)[leaf] = null;
            return { ok: true, pointer };
          }
        }
      }
      return { ok: false };
    }
    return { ok: false };
  }
  if (pointerExists(root, recordedPointer)) return { ok: true, pointer: recordedPointer };
  return { ok: false };
}

function applyBindingOverrides(
  patch: BlueprintPatch,
  settings: BlueprintSettings,
  inputs: BlueprintInput[],
  bindings: BlueprintBinding[],
  overrides: BlueprintGenerateBindingOverride[],
): { patch: BlueprintPatch; settings: BlueprintSettings; inputs: BlueprintInput[]; bindings: BlueprintBinding[] } {
  const nextPatch = cloneJson(patch);
  const nextSettings = cloneJson(settings);
  const nextInputs = [...inputs];
  const nextBindings = [...bindings];
  const root: { profile: { patch: BlueprintPatch; settings: BlueprintSettings } } = {
    profile: { patch: nextPatch, settings: nextSettings },
  };
  for (const override of overrides) {
    if (!pointerExists(root, override.pointer)) {
      throw publicError(`Binding override path ${override.pointer} does not exist.`, override.pointer);
    }
    const existing = nextBindings.find((item) => item.input === override.input.id);
    if (existing) {
      if (existing.target.kind === "value" && existing.target.pointer === override.pointer) continue;
      throw publicError(`Input ${override.input.id} is already declared.`);
    }
    if (nextInputs.some((item) => item.id === override.input.id)) {
      throw publicError(`Input ${override.input.id} is already declared.`);
    }
    setPointer(root as unknown as BlueprintJsonObject, override.pointer, null);
    nextInputs.push(override.input);
    nextBindings.push({ input: override.input.id, target: { kind: "value", pointer: override.pointer } });
  }
  return { patch: nextPatch, settings: nextSettings, inputs: nextInputs, bindings: nextBindings };
}

function metadataOf(metadata: { name: string; version: string; description?: string }) {
  return metadata.description
    ? { name: metadata.name, version: metadata.version, description: metadata.description }
    : { name: metadata.name, version: metadata.version };
}

export function blueprintFileName(name: string, version?: string): string {
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const base = slug && /^[A-Za-z0-9]/.test(slug) ? slug : "blueprint";
  return `${base}${version ? `-${version}` : ""}.dsh-blueprint.json`;
}

export function decodeContent(content: string): Blueprint {
  try {
    return blueprintRecipe(decodeBlueprintDocument(content));
  } catch (error) {
    throw publicError(sanitizeBlueprintError(error));
  }
}
