import { lstatSync, realpathSync } from "../../../../shared/node/filesystem";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isMap, isScalar } from "yaml";
import type { BlueprintJson, BlueprintPatch } from "@klarkxy/dsh-blueprint/v1/types";
import { isBareNpmPackageName, isGitSpec } from "../../../../shared/plugin";
import { isExactRuntimeVersion } from "../../../../shared/runtime";
import { BLUEPRINT_ORIGIN_FILE, type BlueprintEligibility, type BlueprintLocalObservation, type BlueprintSourceBundle, type BlueprintSourceNamespace, type BlueprintSourcePackage, type BlueprintSourcePatchInfo } from "../../../../shared/workbench-blueprint";
import { spaceDataRoot } from "../../llm/llm-policy-store";
import { profileSettingsPath as spaceSettingsPath } from "../../profile/profile-settings";
import { readProfileSettings } from "../../profile/profile-settings";
import { parseNpmNameAndVersion } from "../../products/plugin-ops";
import { isHubPluginArchive, readPluginLibrary } from "../../products/plugin-library";
import type { BlueprintRuntimeInspect, ProfileManifest, InstalledManifest } from "./types";
import { HOST_PACKAGE_SET, CONTROL_PACKAGE_SET, FORBIDDEN_SETTINGS, LIFECYCLE_SCRIPTS } from "./constants";
import { isPlainObject, containedIn, sameResolved, sha256Hex, isOwnedBridgeName } from "./utils";
import { publicError } from "./errors";
import { yamlPatchToBlueprint, yamlToJson, jsonPointerToken, findLocalPointers, jsonLooksCredential } from "./yaml-codec";
import { secretFindingsOfConfig } from "./diagnostics";

export function sourcePackages(
  home: string,
  spaceId: string,
  manifest: ProfileManifest,
  library: ReturnType<typeof readPluginLibrary>,
): BlueprintSourcePackage[] {
  const rows: BlueprintSourcePackage[] = [];
  for (const [name, requestedSpec] of Object.entries(manifest.dependencies)) {
    if (HOST_PACKAGE_SET.has(name) || CONTROL_PACKAGE_SET.has(name) || isOwnedBridgeName(name)) continue;
    const version = readInstalledVersion(home, spaceId, name);
    const installed = readInstalledManifest(home, spaceId, name);
    const origin = resolveNpmOrigin(name, requestedSpec, version, library, home, spaceId);
    const eligibility = packageEligibility(origin, version, installed, name);
    const row: BlueprintSourcePackage = {
      name,
      version,
      source: origin.source,
      inBundles: manifest.bundles.includes(name),
      hasBundlePatch: Boolean(installed?.hasBundle),
      eligibility,
      lifecycleScripts: installed?.lifecycleScripts ?? [],
    };
    if (origin.publicSpec) row.requestedSpec = origin.publicSpec;
    if (origin.integrity) row.integrity = origin.integrity;
    rows.push(row);
  }
  return rows;
}

export function withBuiltinSources(
  packages: BlueprintSourcePackage[],
  manifest: ProfileManifest,
  inspected: BlueprintRuntimeInspect | null,
): BlueprintSourcePackage[] {
  const rows = [...packages];
  for (const layer of inspected?.builtinLayers ?? []) {
    if (HOST_PACKAGE_SET.has(layer.name) || CONTROL_PACKAGE_SET.has(layer.name) || isOwnedBridgeName(layer.name)) continue;
    const row: BlueprintSourcePackage = {
      name: layer.name, version: layer.version, source: "builtin",
      inBundles: manifest.bundles.includes(layer.name), hasBundlePatch: true,
      eligibility: isExactRuntimeVersion(layer.version)
        ? { available: true } : { available: false, reason: "The installed version is unknown." },
      lifecycleScripts: [],
    };
    const index = rows.findIndex((item) => item.name === layer.name);
    if (index >= 0) rows[index] = row;
    else rows.push(row);
  }
  for (const name of inspected?.builtinCatalog ?? []) {
    if (inspected?.builtinLayers?.some((layer) => layer.name === name)) continue;
    if (HOST_PACKAGE_SET.has(name) || CONTROL_PACKAGE_SET.has(name) || isOwnedBridgeName(name)) continue;
    const row: BlueprintSourcePackage = {
      name, version: null, source: "builtin", inBundles: manifest.bundles.includes(name), hasBundlePatch: false,
      eligibility: { available: false, reason: "This builtin is unavailable in the bound runtime." }, lifecycleScripts: [],
    };
    const index = rows.findIndex((item) => item.name === name);
    if (index >= 0) rows[index] = row;
    else rows.push(row);
  }
  return rows;
}

export function sourceBundles(bundles: string[], packages: BlueprintSourcePackage[]): BlueprintSourceBundle[] {
  return bundles
    .filter((name) => !HOST_PACKAGE_SET.has(name) && !CONTROL_PACKAGE_SET.has(name) && !isOwnedBridgeName(name))
    .map((name, order) => {
      const pkg = packages.find((row) => row.name === name);
      if (!pkg) {
        return { name, order, eligible: false, reason: "This layer is not a direct dependency." };
      }
      if (!pkg.eligibility.available) {
        return { name, order, eligible: false, reason: pkg.eligibility.reason };
      }
      if (!pkg.hasBundlePatch) {
        return { name, order, eligible: false, reason: "This package has no bundle patch." };
      }
      return { name, order, eligible: true };
    });
}

function resolveNpmOrigin(
  name: string,
  requestedSpec: string,
  version: string | null,
  library: ReturnType<typeof readPluginLibrary>,
  home: string,
  spaceId: string,
): { source: BlueprintSourcePackage["source"]; publicSpec?: string; integrity?: string } {
  if (isGitSpec(requestedSpec) || requestedSpec.startsWith("link:") || requestedSpec.startsWith(".")) {
    return { source: "local" };
  }
  if (requestedSpec.startsWith("file:")) {
    return resolveFileArchiveOrigin(name, requestedSpec, version, library, home, spaceId);
  }
  const exact = isExactRuntimeVersion(requestedSpec) ? requestedSpec : null;
  const pin = parseNpmNameAndVersion(requestedSpec);
  const libraryHit = library.find((entry) => {
    if (entry.packageName !== name) return false;
    const parsed = parseNpmNameAndVersion(entry.spec);
    const wanted = pin?.version ?? exact ?? version;
    return Boolean(wanted && parsed?.version === wanted);
  });
  if (pin && pin.name === name) {
    return {
      source: "npm",
      publicSpec: `${name}@${pin.version}`,
      integrity: hashedLibraryIntegrity(home, libraryHit),
    };
  }
  if (exact) {
    return {
      source: "npm",
      publicSpec: `${name}@${exact}`,
      integrity: hashedLibraryIntegrity(home, libraryHit),
    };
  }
  if (libraryHit && parseNpmNameAndVersion(libraryHit.spec)) {
    const parsed = parseNpmNameAndVersion(libraryHit.spec)!;
    return {
      source: "npm",
      publicSpec: `${name}@${parsed.version}`,
      integrity: hashedLibraryIntegrity(home, libraryHit),
    };
  }
  return { source: "unknown" };
}

function resolveFileArchiveOrigin(
  name: string,
  requestedSpec: string,
  version: string | null,
  library: ReturnType<typeof readPluginLibrary>,
  home: string,
  spaceId: string,
): { source: BlueprintSourcePackage["source"]; publicSpec?: string; integrity?: string } {
  const raw = requestedSpec.slice("file:".length).trim();
  if (!raw || raw.includes("\0")) return { source: "local" };
  const profileDir = join(home, "profiles", spaceId);
  if (!containedIn(home, profileDir)) return { source: "local" };
  const archive = isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? resolve(raw) : resolve(profileDir, raw);
  if (!isHubPluginArchive(home, archive)) return { source: "local" };
  try {
    const st = lstatSync(archive);
    if (st.isSymbolicLink()) {
      const real = realpathSync(archive);
      if (!isHubPluginArchive(home, real)) return { source: "local" };
    } else if (!st.isFile()) {
      return { source: "local" };
    }
  } catch {
    return { source: "local" };
  }
  const libraryHit = library.find((entry) => {
    if (entry.packageName !== name) return false;
    if (!entry.tarball) return false;
    const recorded = isAbsolute(entry.tarball) ? entry.tarball : join(home, entry.tarball);
    return sameResolved(recorded, archive);
  });
  if (!libraryHit) return { source: "local" };
  const parsed = parseNpmNameAndVersion(libraryHit.spec);
  if (!parsed || parsed.name !== name) return { source: "local" };
  if (!version || parsed.version !== version) return { source: "local" };
  const integrity = hashedLibraryIntegrity(home, libraryHit);
  if (!integrity) return { source: "unknown" };
  return {
    source: "npm",
    publicSpec: `${parsed.name}@${parsed.version}`,
    integrity,
  };
}

function hashedLibraryIntegrity(
  home: string,
  entry: { tarball?: string } | undefined,
): string | undefined {
  if (!entry?.tarball) return undefined;
  return tarballIntegrity(home, entry.tarball);
}

function packageEligibility(
  origin: { source: BlueprintSourcePackage["source"] },
  version: string | null,
  installed: InstalledManifest | null,
  name: string,
): BlueprintEligibility {
  if (origin.source !== "npm") {
    return { available: false, reason: "Only packages with an npm origin can be included." };
  }
  if (!version || !isExactRuntimeVersion(version)) {
    return { available: false, reason: "The installed version is unknown." };
  }
  if (!installed) {
    return { available: false, reason: "The installed package manifest could not be read." };
  }
  if (installed.name !== name) {
    return { available: false, reason: "The installed package identity does not match its dependency name." };
  }
  return { available: true };
}

export function describePatch(home: string, spaceId: string): { info: BlueprintSourcePatchInfo; observations: BlueprintLocalObservation[] } {
  const converted = convertSourcePatch(home, spaceId);
  return {
    info: {
      exists: converted.exists,
      shareable: converted.shareable,
      reason: converted.reason,
    },
    observations: converted.observations,
  };
}

export function describeSettings(
  home: string,
  spaceId: string,
): Array<{ info: BlueprintSourceNamespace; observations: BlueprintLocalObservation[]; value: BlueprintJson }> {
  const path = spaceSettingsPath(home, spaceId);
  if (!existsSync(path)) return [];
  const doc = readProfileSettings(home, spaceId, true);
  if (!isMap(doc.contents)) return [];
  const rows: Array<{ info: BlueprintSourceNamespace; observations: BlueprintLocalObservation[]; value: BlueprintJson }> = [];
  for (const item of doc.contents.items) {
    const namespace = typeof item.key === "string" ? item.key : isScalar(item.key) ? String(item.key.value ?? "") : "";
    if (!namespace) continue;
    const pointer = `/profile/settings/${jsonPointerToken(namespace)}`;
    if (FORBIDDEN_SETTINGS.has(namespace)) {
      rows.push({
        info: {
          namespace,
          eligible: false,
          shareable: false,
          convertible: false,
          reason: "Managed model settings are re-expressed as a model input.",
        },
        observations: [{ pointer, kind: "managed", reason: "Managed model settings are not copied." }],
        value: null,
      });
      continue;
    }
    const dynamics: string[] = [];
    const json = yamlToJson(item.value, pointer, dynamics);
    const observations: BlueprintLocalObservation[] = dynamics.map((path) => ({
      pointer: path,
      kind: "dynamic" as const,
      reason: "Dynamic expressions cannot be shared.",
    }));
    if (jsonLooksCredential(json, pointer, observations) || secretFindingsOfConfig([], { [namespace]: json })) {
      rows.push({
        info: {
          namespace,
          eligible: false,
          shareable: false,
          convertible: false,
          reason: "This namespace looks like a credential preset.",
        },
        observations,
        value: json,
      });
      continue;
    }
    const locals = findLocalPointers(json, pointer);
    observations.push(...locals);
    const convertible = locals.length > 0 && dynamics.length === 0;
    rows.push({
      info: {
        namespace,
        eligible: dynamics.length === 0,
        shareable: dynamics.length === 0 && locals.length === 0,
        convertible,
        reason: dynamics.length
          ? "Dynamic expressions cannot be shared."
          : locals.length
            ? "Local values must be declared as inputs."
            : undefined,
      },
      observations,
      value: json,
    });
  }
  return rows;
}

export function convertSourcePatch(
  home: string,
  spaceId: string,
): {
  exists: boolean;
  shareable: boolean;
  convertible: boolean;
  secret: boolean;
  reason?: string;
  patch: BlueprintPatch;
  observations: BlueprintLocalObservation[];
} {
  const path = join(home, "profiles", spaceId, "cordis.patch.yml");
  if (!existsSync(path)) {
    return { exists: false, shareable: true, convertible: false, secret: false, patch: [], observations: [] };
  }
  const text = readFileSync(path, "utf8");
  const observations: BlueprintLocalObservation[] = [];
  const dynamics: string[] = [];
  const patch = yamlPatchToBlueprint(text, spaceId, dynamics, observations);
  if (dynamics.length) {
    return {
      exists: true,
      shareable: false,
      convertible: false,
      secret: false,
      reason: "Dynamic expressions cannot be shared.",
      patch,
      observations: [
        ...observations,
        ...dynamics.map((pointer) => ({ pointer, kind: "dynamic" as const, reason: "Dynamic expressions cannot be shared." })),
      ],
    };
  }
  const secret = Boolean(secretFindingsOfConfig(patch, {}));
  if (secret) {
    return {
      exists: true,
      shareable: false,
      convertible: false,
      secret: true,
      reason: "The selected configuration contains a secret and cannot be shared.",
      patch,
      observations,
    };
  }
  const locals = findLocalPointers(patch as unknown as BlueprintJson, "/profile/patch");
  observations.push(...locals);
  return {
    exists: true,
    shareable: locals.length === 0,
    convertible: locals.length > 0,
    secret: false,
    patch,
    observations,
  };
}

export function readProfileManifest(home: string, spaceId: string): ProfileManifest {
  const path = join(home, "profiles", spaceId, "package.json");
  if (!existsSync(path)) throw publicError("That space was not found.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: unknown } };
  };
  const dependencies = parsed.dependencies && isPlainObject(parsed.dependencies) ? parsed.dependencies as Record<string, string> : {};
  const bundles = Array.isArray(parsed.dsh?.profile?.bundles)
    ? parsed.dsh.profile.bundles.filter((item): item is string => typeof item === "string")
    : [];
  return { dependencies, bundles };
}

export function readInstalledManifest(home: string, spaceId: string, name: string): InstalledManifest | null {
  const path = installedManifestPath(home, spaceId, name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      name?: unknown;
      version?: unknown;
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      dsh?: { bundle?: { patch?: unknown } };
    };
    const pkgName = typeof parsed.name === "string" ? parsed.name : name;
    const version = typeof parsed.version === "string" ? parsed.version : "";
    const patch = parsed.dsh?.bundle?.patch;
    const hasBundle = typeof patch === "string" || (Array.isArray(patch) && patch.every((file) => typeof file === "string"));
    const lifecycleScripts = LIFECYCLE_SCRIPTS.filter((script) => parsed.scripts && Object.prototype.hasOwnProperty.call(parsed.scripts, script));
    const dependencies = parsed.dependencies && isPlainObject(parsed.dependencies) ? Object.keys(parsed.dependencies) : [];
    return { name: pkgName, version, hasBundle, lifecycleScripts, dependencies };
  } catch {
    return null;
  }
}

export function readInstalledIdentity(home: string, spaceId: string, name: string): { name: string; version: string } | null {
  const installed = readInstalledManifest(home, spaceId, name);
  if (!installed || !isExactRuntimeVersion(installed.version)) return null;
  return { name: installed.name, version: installed.version };
}

function readInstalledVersion(home: string, spaceId: string, name: string): string | null {
  const version = readInstalledManifest(home, spaceId, name)?.version;
  return version && isExactRuntimeVersion(version) ? version : null;
}

function installedManifestPath(home: string, spaceId: string, name: string): string {
  if (!isBareNpmPackageName(name)) throw publicError("A dependency package name is invalid.");
  return join(home, "profiles", spaceId, "node_modules", ...name.split("/"), "package.json");
}

function tarballIntegrity(home: string, rel: string): string | undefined {
  const abs = isAbsolute(rel) ? rel : join(home, rel);
  if (!isHubPluginArchive(home, abs)) return undefined;
  try {
    const bytes = readFileSync(abs);
    return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  } catch {
    return undefined;
  }
}

export function sourceFingerprint(home: string, spaceId: string): string {
  const manifest = readProfileManifest(home, spaceId);
  return sha256Hex(
    [
      fileDigest(join(home, "profiles", spaceId, "package.json")),
      fileDigest(join(home, "profiles", spaceId, "cordis.patch.yml")),
      fileDigest(spaceSettingsPath(home, spaceId)),
      fileDigest(join(spaceDataRoot(home, spaceId), BLUEPRINT_ORIGIN_FILE)),
      ...Object.keys(manifest.dependencies).sort().map((name) => `${name}:${fileDigest(installedManifestPath(home, spaceId, name))}`),
    ].join("|"),
  );
}

export function fileDigest(path: string): string {
  if (!existsSync(path)) return sha256Hex("");
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return sha256Hex("unreadable");
  }
}
