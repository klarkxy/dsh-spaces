import { lstatSync, realpathSync } from "../../../../shared/node/filesystem";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { blueprintRecipe, parseBlueprintDocument, type BlueprintRecipe as Blueprint } from "@klarkxy/dsh-blueprint/document";
import type { BlueprintBinding, BlueprintInput, BlueprintInputValues, BlueprintJson, BlueprintPatch, BlueprintSettings } from "../../../../shared/blueprint";
import { BLUEPRINT_LOCAL_FILE, BLUEPRINT_ORIGIN_FILE, BLUEPRINT_ORIGIN_SCHEMA_VERSION, type BlueprintOriginRecord } from "../../../../shared/workbench-blueprint";
import { atomicWrite } from "../../atomic";
import { realDshHome } from "../../home/home-guard";
import { spaceDataRoot } from "../../llm/llm-policy-store";
import { spaceSettingsPath } from "../../llm/llm-space-settings";
import { writeProfileSettings } from "../../profile/profile-settings";
import type { OriginRecipe } from "./types";
import { HOST_PACKAGE_SET, CONTROL_PACKAGE_SET, MANAGED_ENTRY_SET, FORBIDDEN_SETTINGS } from "./constants";
import { isPlainObject, containedIn, sameResolved, isOwnedBridgeName } from "./utils";
import { publicError, assertRegularFile } from "./errors";
import { hasJsExpr, walkPatchEntries, patchEntryId, patchEntryName, settingsNamespaceOf } from "./yaml-codec";
import { readProfileManifest } from "./source-inspection";

export function writeBoundSettings(home: string, spaceId: string, settings: BlueprintSettings): void {
  writeProfileSettings(home, spaceId, Object.fromEntries(
    Object.entries(settings).filter(([namespace]) => !FORBIDDEN_SETTINGS.has(namespace)),
  ));
}

export function writeProvenance(home: string, spaceId: string, blueprint: Blueprint, values: BlueprintInputValues): void {
  const root = spaceDataRoot(home, spaceId);
  mkdirSync(root, { recursive: true });
  const origin: BlueprintOriginRecord = {
    schemaVersion: BLUEPRINT_ORIGIN_SCHEMA_VERSION,
    blueprint: blueprint.document,
    bindings: blueprint.bindings.map((binding) => {
      if (binding.target.kind === "default-model") return { input: binding.input, kind: "default-model" as const };
      const entryId = patchEntryId(blueprint.profile.patch, binding.target.pointer);
      const entryName = patchEntryName(blueprint.profile.patch, binding.target.pointer);
      const namespace = settingsNamespaceOf(binding.target.pointer);
      return {
        input: binding.input,
        kind: "value" as const,
        pointer: binding.target.pointer,
        ...(entryId ? { entryId } : {}),
        ...(entryName ? { entryName } : {}),
        ...(namespace ? { namespace } : {}),
      };
    }),
    appliedAt: new Date().toISOString(),
  };
  try {
    atomicWrite(join(root, BLUEPRINT_ORIGIN_FILE), `${JSON.stringify(origin, null, 2)}\n`);
  } catch {
    throw publicError("Blueprint provenance could not be saved.");
  }
  const local: Record<string, BlueprintJson> = {};
  for (const [id, value] of Object.entries(values)) {
    if (typeof value === "object") continue;
    local[id] = value;
  }
  try {
    atomicWrite(join(root, BLUEPRINT_LOCAL_FILE), `${JSON.stringify({ schemaVersion: BLUEPRINT_ORIGIN_SCHEMA_VERSION, values: local }, null, 2)}\n`);
  } catch {
    /* local observations are best-effort and never block provenance */
  }
}

export function readOrigin(home: string, spaceId: string): OriginRecipe | null {
  const path = join(spaceDataRoot(home, spaceId), BLUEPRINT_ORIGIN_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BlueprintOriginRecord;
    if (parsed.schemaVersion !== BLUEPRINT_ORIGIN_SCHEMA_VERSION) return null;
    const blueprint = blueprintRecipe(parseBlueprintDocument(parsed.blueprint));
    return { ...parsed, blueprint };
  } catch {
    return null;
  }
}

export function composeBundles(
  home: string,
  spaceId: string,
  blueprintBundles: string[],
  options: { includeLlmBridge: boolean },
): void {
  const manifest = readProfileManifest(home, spaceId);
  const known = [...manifest.bundles, ...Object.keys(manifest.dependencies)];
  const hostLayers = manifest.bundles.filter((name) => HOST_PACKAGE_SET.has(name) || CONTROL_PACKAGE_SET.has(name) || isOwnedBridgeName(name));
  const view = known.find((name) => name === "@dsh-spaces/view-bridge" || name === "dsh-spaces-view-bridge");
  const llm = known.find((name) => name === "@dsh-spaces/llm-bridge" || name === "dsh-spaces-llm-bridge");
  const final: string[] = [...hostLayers];
  if (view && !final.includes(view)) final.push(view);
  if (llm && (options.includeLlmBridge || manifest.bundles.includes(llm)) && !final.includes(llm)) final.push(llm);
  for (const name of blueprintBundles) {
    if (!final.includes(name)) final.push(name);
  }
  writeProfileBundles(home, spaceId, final);
}

function writeProfileBundles(home: string, spaceId: string, bundles: string[]): void {
  const path = join(home, "profiles", spaceId, "package.json");
  assertRegularFile(path);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const dsh = isPlainObject(raw.dsh) ? { ...raw.dsh } : {};
  const profile = isPlainObject(dsh.profile) ? { ...dsh.profile } : {};
  profile.bundles = bundles;
  dsh.profile = profile;
  raw.dsh = dsh;
  atomicWrite(path, `${JSON.stringify(raw, null, 2)}\n`);
}

export function assertPatchSafeToApply(patch: BlueprintPatch, _spaceId: string): void {
  if (hasJsExpr(patch, "/profile/patch", [])) {
    throw publicError("Dynamic expressions cannot be applied.");
  }
  walkPatchEntries(patch, (entry, pointer) => {
    if (MANAGED_ENTRY_SET.has(entry.id)) {
      throw publicError("Managed isolation fields cannot be supplied by a blueprint.", `${pointer}/id`);
    }
    if (entry.name && isOwnedBridgeName(entry.name)) {
      throw publicError("Owned control components cannot be supplied by a blueprint.", `${pointer}/name`);
    }
  });
}

export function defeatsIsolation(text: string, spaceId: string): boolean {
  if (/(?:hub|profiles)\/web\b/i.test(text) && spaceId !== "web") return true;
  if (/dshHomePath\s*\(\s*['"][^'"]*\.\./i.test(text)) return true;
  return false;
}

export function directoryInputError(home: string, blueprint: Blueprint, values: BlueprintInputValues): string | undefined {
  for (const input of blueprint.inputs) {
    if (input.type !== "directory") continue;
    const value = values[input.id];
    if (typeof value !== "string") continue;
    const error = directoryProtectionError(home, value);
    if (error) return error;
  }
  return undefined;
}

function directoryProtectionError(home: string, value: string): string | undefined {
  if (!value || value.includes("\0")) return "A directory input is invalid.";
  if (!isAbsolute(value)) return "A directory input must be an absolute path.";
  return walkProtectedAncestors(resolve(home), resolve(realDshHome()), value);
}

function walkProtectedAncestors(homeRoot: string, realHome: string, value: string): string | undefined {
  const segments: string[] = [];
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    segments.push(value.slice(0, 2) + sep);
    segments.push(...value.slice(3).split(/[/\\]/).filter(Boolean));
  } else if (value.startsWith("\\\\") || value.startsWith("//")) {
    return "A directory input cannot use a network path.";
  } else if (value.startsWith("/") || value.startsWith("\\")) {
    segments.push(sep);
    segments.push(...value.slice(1).split(/[/\\]/).filter(Boolean));
  } else {
    return "A directory input must be an absolute path.";
  }
  let resolved = segments[0]!;
  for (let index = 1; index < segments.length; index++) {
    const next = join(resolved, segments[index]!);
    let st;
    try {
      st = lstatSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const rest = join(resolved, ...segments.slice(index));
        if (isProtectedLocation(homeRoot, realHome, rest) || isProtectedLocation(homeRoot, realHome, resolved)) {
          return "A directory input points at a protected Home path.";
        }
        return undefined;
      }
      return "A directory input could not be read.";
    }
    try {
      const target = st.isSymbolicLink() ? realpathSync(next) : next;
      if (isProtectedLocation(homeRoot, realHome, target)) {
        return "A directory input points at a protected Home path.";
      }
      resolved = target;
    } catch {
      return "A directory input could not be read.";
    }
  }
  try {
    const st = lstatSync(resolved);
    if (st.isSymbolicLink()) {
      const target = realpathSync(resolved);
      if (isProtectedLocation(homeRoot, realHome, target)) return "A directory input points at a protected Home path.";
    } else if (!st.isDirectory()) {
      return "A directory input must be a directory.";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return "A directory input could not be read.";
  }
  if (isProtectedLocation(homeRoot, realHome, resolved)) return "A directory input points at a protected Home path.";
  return undefined;
}

function isProtectedLocation(homeRoot: string, realHome: string, target: string): boolean {
  const resolved = resolve(target);
  if (sameResolved(resolved, homeRoot) || containedIn(homeRoot, resolved)) return true;
  if (sameResolved(resolved, realHome) || containedIn(realHome, resolved)) return true;
  return false;
}

export function maybeModelInput(
  home: string,
  spaceId: string,
  origin: OriginRecipe | null,
): { input: BlueprintInput; binding: BlueprintBinding } | null {
  if (origin?.blueprint.bindings.some((binding) => binding.target.kind === "default-model")) {
    const binding = origin.blueprint.bindings.find((item) => item.target.kind === "default-model")!;
    const input = origin.blueprint.inputs.find((item) => item.id === binding.input);
    if (input) return { input, binding };
  }
  const path = spaceSettingsPath(home, spaceId);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (!text.includes("agent-default-model") && !text.includes("llm-pi-ai")) return null;
  return {
    input: { id: "default-model", type: "model", label: "Model", required: false },
    binding: { input: "default-model", target: { kind: "default-model" } },
  };
}
