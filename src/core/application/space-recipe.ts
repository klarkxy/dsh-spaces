import { applyIsolationPatch, patchTextLooksIsolated } from "../domain/isolation";
import { assertShareSecretFree, parseLlmShareManifest, type LlmShareManifest } from "../domain/llm-share";
import { FULL_SPACES_PACKAGE, isFullSpacesManagerSpec, isUnresolvedPluginAlias } from "../../shared/plugin-spec";
import { isGitSpec } from "../../shared/plugin";
import { isExactRuntimeVersion } from "../../shared/runtime";
import { runBatch } from "../../shared/batch";
import {
  SPACE_RECIPE_SCHEMA_VERSION,
  type SpaceImportResult,
  type SpaceRecipe,
  type SpaceSharePlugin,
  type SpaceSharePluginSource,
  type SpaceTemplate,
} from "../../shared/space-share";
import { PROFILE_NAME_RE, PROTECTED_PLUGIN_PACKAGES, RESERVED_PROFILE_NAMES } from "../../shared/types";

const HOST_PACKAGES = new Set<string>([...PROTECTED_PLUGIN_PACKAGES, FULL_SPACES_PACKAGE]);
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const NPM_RANGE_RE = /^[~^=]?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?$/;
const SHARE_SOURCES = new Set<SpaceSharePluginSource>(["npm", "git", "manual", "unknown"]);

export interface SpaceRecipePorts {
  createSpace(input: { name: string; displayName: string; icon?: string }): Promise<void>;
  installPlugin(spaceId: string, spec: string): Promise<void>;
  writePatch?(spaceId: string, patch: string): void;
  writeLlmShare?(spaceId: string, manifest: LlmShareManifest): Promise<void> | void;
}

export interface ApplySpaceRecipeOptions {
  name: string;
  displayName?: string;
}

export function isSafeNpmPackageName(name: string): boolean {
  if (!name || name.length > 214) return false;
  if (name.startsWith(".") || name.startsWith("_")) return false;
  return NPM_NAME_RE.test(name);
}

export function isNpmRangeOrExact(spec: string): boolean {
  return NPM_RANGE_RE.test(spec.trim());
}

export function canonicalNpmInstallSpec(plugin: SpaceSharePlugin): string | null {
  if (!isSafeNpmPackageName(plugin.packageName)) return null;
  if (HOST_PACKAGES.has(plugin.packageName) || isFullSpacesManagerSpec(plugin.packageName)) return null;
  if (plugin.source !== "npm") return null;
  const version = plugin.resolvedVersion;
  if (!version || !isExactRuntimeVersion(version)) return null;
  const expected = `${plugin.packageName}@${version}`;
  if (plugin.installSpec && plugin.installSpec !== expected) return null;
  return expected;
}

export function validateImportedPatch(patch: string, spaceId: string): string {
  if (spaceId === "web") throw new Error("The web space cannot be imported onto.");
  if ((RESERVED_PROFILE_NAMES as readonly string[]).includes(spaceId)) {
    throw new Error(`The ${spaceId} space cannot be imported onto.`);
  }
  const applied = applyIsolationPatch(patch, spaceId, "profile.patch.yml");
  if (!patchTextLooksIsolated(applied, spaceId)) {
    throw new Error("The imported config does not isolate this space.");
  }
  if (/dshHomePath\s*\(\s*['"][^'"]*\.\./i.test(applied)) {
    throw new Error("The imported config contains a path that is not allowed.");
  }
  if (/(?:hub|profiles)\/web\b/i.test(applied) && spaceId !== "web") {
    throw new Error("The imported config points at the web space.");
  }
  return applied;
}

export function parseSpaceRecipe(value: unknown): SpaceRecipe {
  if (!value || typeof value !== "object") {
    throw new Error("The space recipe is invalid. Original bytes were left unchanged.");
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== SPACE_RECIPE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported space recipe schema ${String(row.schemaVersion)}. Original bytes were left unchanged.`,
    );
  }
  if (typeof row.displayName !== "string" || !row.displayName.trim()) {
    throw new Error("The space recipe is missing a display name. Original bytes were left unchanged.");
  }
  if (row.icon !== undefined && typeof row.icon !== "string") {
    throw new Error("The space recipe has an invalid icon. Original bytes were left unchanged.");
  }
  if (!Array.isArray(row.plugins)) {
    throw new Error("The space recipe plugins list is invalid. Original bytes were left unchanged.");
  }
  const plugins = row.plugins.map((plugin, index) => assertRecipePlugin(plugin, index));
  if (row.patch !== undefined && typeof row.patch !== "string") {
    throw new Error("The space recipe config is invalid. Original bytes were left unchanged.");
  }
  const llm = row.llm === undefined ? undefined : parseLlmShareManifest(row.llm);
  if (row.source !== undefined) {
    if (!row.source || typeof row.source !== "object") {
      throw new Error("The space recipe has invalid source metadata. Original bytes were left unchanged.");
    }
    const dshVersion = (row.source as Record<string, unknown>).dshVersion;
    if (dshVersion !== undefined && dshVersion !== null && typeof dshVersion !== "string") {
      throw new Error("The space recipe has an invalid DSH version. Original bytes were left unchanged.");
    }
  }
  const source = row.source as { dshVersion?: string | null } | undefined;
  const recipe: SpaceRecipe = {
    schemaVersion: SPACE_RECIPE_SCHEMA_VERSION,
    displayName: row.displayName,
    icon: typeof row.icon === "string" ? row.icon : undefined,
    plugins,
    patch: typeof row.patch === "string" ? row.patch : undefined,
    llm,
    source: source
      ? { dshVersion: typeof source.dshVersion === "string" ? source.dshVersion : source.dshVersion === null ? null : undefined }
      : undefined,
  };
  assertRecipeSecretFree(recipe);
  return recipe;
}

export function recipeFromShareParts(input: {
  displayName: string;
  icon?: string;
  plugins: SpaceSharePlugin[];
  patch?: string;
  llm?: LlmShareManifest;
  source?: { dshVersion?: string | null };
}): SpaceRecipe {
  return parseSpaceRecipe({
    schemaVersion: SPACE_RECIPE_SCHEMA_VERSION,
    displayName: input.displayName,
    icon: input.icon,
    plugins: input.plugins,
    patch: input.patch,
    llm: input.llm,
    source: input.source,
  });
}

export function recipeFromTemplate(template: SpaceTemplate): SpaceRecipe {
  if (template.recipe) return parseSpaceRecipe(template.recipe);
  return parseSpaceRecipe({
    schemaVersion: SPACE_RECIPE_SCHEMA_VERSION,
    displayName: template.displayName,
    plugins: template.plugins,
  });
}

export function publicSpaceTemplate(template: SpaceTemplate): SpaceTemplate {
  assertSharePluginsSecretFree(template.plugins);
  const recipe = template.recipe ? projectPublicRecipe(parseSpaceRecipe(template.recipe)) : undefined;
  return {
    id: template.id,
    name: template.name,
    displayName: template.displayName,
    plugins: template.plugins.map(projectPublicPlugin),
    createdAt: template.createdAt,
    recipe,
  };
}

export function assertSharePluginsSecretFree(plugins: SpaceSharePlugin[]): void {
  const entries: Array<{ name: string; data: string }> = [];
  for (const plugin of plugins) {
    if (plugin.requestedSpec) entries.push({ name: "plugins.json", data: plugin.requestedSpec });
    if (plugin.installSpec) entries.push({ name: "plugins.json", data: plugin.installSpec });
    entries.push({ name: "plugins.json", data: plugin.packageName });
  }
  if (entries.length) assertShareSecretFree(entries);
}

export function assertRecipeSecretFree(recipe: SpaceRecipe): void {
  assertSharePluginsSecretFree(recipe.plugins);
  if (recipe.patch) assertShareSecretFree([{ name: "profile.patch.yml", data: recipe.patch }]);
}

export function llmImportResult(manifest: LlmShareManifest | undefined): SpaceImportResult["llm"] {
  if (!manifest || manifest.requirements.length === 0) return undefined;
  return {
    mappingRequired: true,
    requirements: manifest.requirements,
    mapped: false,
  };
}

export function assertMutableRecipeSpaceId(spaceId: string, protectedIds: Iterable<string> = []): void {
  if (!PROFILE_NAME_RE.test(spaceId)) {
    throw new Error("That space name is not allowed.");
  }
  if (spaceId === "web" || (RESERVED_PROFILE_NAMES as readonly string[]).includes(spaceId)) {
    throw new Error(`The ${spaceId} space cannot be changed this way.`);
  }
  for (const id of protectedIds) {
    if (id && spaceId === id) throw new Error(`The ${spaceId} space cannot be changed this way.`);
  }
}

export async function applySpaceRecipe(
  recipe: SpaceRecipe,
  ports: SpaceRecipePorts,
  options: ApplySpaceRecipeOptions,
): Promise<SpaceImportResult> {
  const parsed = parseSpaceRecipe(recipe);
  const name = options.name;
  try {
    assertMutableRecipeSpaceId(name);
  } catch (error) {
    return definitionFailed(error);
  }

  let isolatedPatch: string | undefined;
  if (parsed.patch) {
    try {
      isolatedPatch = validateImportedPatch(parsed.patch, name);
    } catch (error) {
      return definitionFailed(error);
    }
  }

  try {
    await ports.createSpace({
      name,
      displayName: options.displayName?.trim() || parsed.displayName,
      icon: parsed.icon,
    });
  } catch (error) {
    return definitionFailed(error);
  }

  if (isolatedPatch && ports.writePatch) {
    try {
      ports.writePatch(name, isolatedPatch);
    } catch (error) {
      return {
        definition: "imported",
        plugins: "not-run",
        start: "not-run",
        spaceId: name,
        errors: [errorMessage(error)],
        pendingManual: [],
        llm: llmImportResult(parsed.llm),
      };
    }
  }

  if (parsed.llm && ports.writeLlmShare) {
    try {
      await ports.writeLlmShare(name, parsed.llm);
    } catch (error) {
      return {
        definition: "imported",
        plugins: "not-run",
        start: "not-run",
        spaceId: name,
        errors: [errorMessage(error)],
        pendingManual: [],
        llm: llmImportResult(parsed.llm),
      };
    }
  }

  const auto: { plugin: SpaceSharePlugin; spec: string }[] = [];
  const pendingManual: SpaceSharePlugin[] = [];
  for (const plugin of parsed.plugins) {
    const spec = canonicalNpmInstallSpec(plugin);
    if (spec) auto.push({ plugin, spec });
    else pendingManual.push(plugin);
  }
  let pluginStatus: SpaceImportResult["plugins"] = auto.length
    ? "completed"
    : pendingManual.length
      ? "pending-manual"
      : "completed";
  const errors: string[] = [];
  const batch = await runBatch(auto, async (row) => {
    await ports.installPlugin(name, row.spec);
  });
  if (batch.failed) {
    errors.push(batch.failed.error);
    pluginStatus = "failed";
  } else if (pendingManual.length) pluginStatus = "pending-manual";

  return {
    definition: "imported",
    plugins: pluginStatus,
    start: "not-run",
    spaceId: name,
    errors,
    pendingManual,
    llm: llmImportResult(parsed.llm),
  };
}

function projectPublicRecipe(recipe: SpaceRecipe): SpaceRecipe {
  return {
    schemaVersion: SPACE_RECIPE_SCHEMA_VERSION,
    displayName: recipe.displayName,
    icon: recipe.icon,
    plugins: recipe.plugins.map(projectPublicPlugin),
    patch: recipe.patch,
    llm: recipe.llm,
    source: recipe.source,
  };
}

function projectPublicPlugin(plugin: SpaceSharePlugin): SpaceSharePlugin {
  const next: SpaceSharePlugin = {
    packageName: plugin.packageName,
    resolvedVersion: plugin.resolvedVersion,
    source: plugin.source,
  };
  if (plugin.requestedSpec && isPublicPluginSpec(plugin.requestedSpec)) next.requestedSpec = plugin.requestedSpec;
  if (plugin.installSpec && isPublicPluginSpec(plugin.installSpec)) next.installSpec = plugin.installSpec;
  return next;
}

function isPublicPluginSpec(spec: string): boolean {
  const trimmed = spec.trim();
  if (!trimmed) return false;
  if (isGitSpec(trimmed)) return true;
  if (isUnresolvedPluginAlias(trimmed)) return false;
  if (/:\/\//.test(trimmed) || /\/\/[^/\s]*@/.test(trimmed)) return false;
  if (trimmed.startsWith(".") || trimmed.includes("\\") || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith("@")) return false;
  return true;
}

function assertRecipePlugin(value: unknown, index: number): SpaceSharePlugin {
  if (!value || typeof value !== "object") {
    throw new Error(`The space recipe plugins list is invalid at index ${index}. Original bytes were left unchanged.`);
  }
  const row = value as Record<string, unknown>;
  if (typeof row.packageName !== "string" || !row.packageName.trim()) {
    throw new Error(`The space recipe plugin at index ${index} is missing packageName. Original bytes were left unchanged.`);
  }
  if (
    row.resolvedVersion !== null &&
    row.resolvedVersion !== undefined &&
    typeof row.resolvedVersion !== "string"
  ) {
    throw new Error(`The space recipe plugin at index ${index} has an invalid resolvedVersion. Original bytes were left unchanged.`);
  }
  if (typeof row.source !== "string" || !SHARE_SOURCES.has(row.source as SpaceSharePluginSource)) {
    throw new Error(`The space recipe plugin at index ${index} has an invalid source. Original bytes were left unchanged.`);
  }
  if (row.installSpec !== undefined && typeof row.installSpec !== "string") {
    throw new Error(`The space recipe plugin at index ${index} has an invalid installSpec. Original bytes were left unchanged.`);
  }
  if (row.requestedSpec !== undefined && typeof row.requestedSpec !== "string") {
    throw new Error(`The space recipe plugin at index ${index} has an invalid requestedSpec. Original bytes were left unchanged.`);
  }
  const plugin: SpaceSharePlugin = {
    packageName: row.packageName,
    resolvedVersion: typeof row.resolvedVersion === "string" ? row.resolvedVersion : null,
    source: row.source as SpaceSharePluginSource,
  };
  if (typeof row.requestedSpec === "string") plugin.requestedSpec = row.requestedSpec;
  if (typeof row.installSpec === "string") plugin.installSpec = row.installSpec;
  return plugin;
}

function definitionFailed(error: unknown): SpaceImportResult {
  return {
    definition: "failed",
    plugins: "not-run",
    start: "not-run",
    errors: [errorMessage(error)],
    pendingManual: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
