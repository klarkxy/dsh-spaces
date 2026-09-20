import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";
import { listProfilePlugins } from "./plugin-ops";
import { readPluginLibrary } from "./plugin-library";
import { pluginToShare } from "./space-share";
import {
  SPACE_RECIPE_SCHEMA_VERSION,
  type CreateFromTemplateResult,
  type SpaceRecipe,
  type SpaceSharePlugin,
  type SpaceTemplate,
} from "../../shared/space-share";
import {
  applySpaceRecipe,
  assertSharePluginsSecretFree,
  parseSpaceRecipe,
  recipeFromTemplate,
} from "../../core/application/space-recipe";
import type { LlmShareManifest } from "../../core/domain/llm-share";

export const SPACE_TEMPLATES_FILE = "space-templates.json";

export interface SpaceTemplatePorts {
  createSpace(input: { name: string; displayName: string; icon?: string }): Promise<void>;
  installPlugin(spaceId: string, spec: string): Promise<void>;
  writePatch?(spaceId: string, patch: string): void;
  writeLlmShare?(spaceId: string, manifest: LlmShareManifest): Promise<void> | void;
}

function templatesPath(dshHome: string): string {
  return join(dshHome, "hub", SPACE_TEMPLATES_FILE);
}

export function spaceTemplateId(name: string): string {
  const digest = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 10);
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const id = slug ? `${slug}-${digest}` : `template-${digest}`;
  return id.slice(0, 39);
}

export function listSpaceTemplates(dshHome: string): SpaceTemplate[] {
  assertNotRealHome(dshHome);
  const path = templatesPath(dshHome);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `Space templates could not be read. Original bytes were left unchanged: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Space templates JSON is invalid. Original bytes were left unchanged.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Space templates file is not a valid template list. Original bytes were left unchanged.");
  }
  const row = parsed as { schemaVersion?: unknown; templates?: unknown };
  if (row.schemaVersion !== undefined && row.schemaVersion !== SPACE_RECIPE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported space templates schema ${String(row.schemaVersion)}. Original bytes were left unchanged.`,
    );
  }
  if (!Array.isArray(row.templates)) {
    throw new Error("Space templates file is not a valid template list. Original bytes were left unchanged.");
  }
  const templates: SpaceTemplate[] = [];
  for (const item of row.templates) {
    const template = parseStoredTemplate(item);
    if (!template) {
      throw new Error("Space templates file contains an invalid template. Original bytes were left unchanged.");
    }
    templates.push(template);
  }
  return templates;
}

function parseStoredTemplate(value: unknown): SpaceTemplate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as SpaceTemplate;
  if (
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.name !== "string" ||
    !row.name ||
    typeof row.displayName !== "string" ||
    !row.displayName ||
    typeof row.createdAt !== "string" ||
    !Array.isArray(row.plugins)
  ) {
    return undefined;
  }
  if (
    !row.plugins.every((plugin) => {
      if (!plugin || typeof plugin !== "object") return false;
      return (
        typeof plugin.packageName === "string" &&
        Boolean(plugin.packageName) &&
        (plugin.requestedSpec === undefined || typeof plugin.requestedSpec === "string") &&
        (plugin.resolvedVersion === null || typeof plugin.resolvedVersion === "string") &&
        ["npm", "git", "manual", "unknown"].includes(plugin.source) &&
        (plugin.installSpec === undefined || typeof plugin.installSpec === "string")
      );
    })
  ) {
    return undefined;
  }
  assertSharePluginsSecretFree(row.plugins);
  if (row.recipe !== undefined) parseSpaceRecipe(row.recipe);
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    plugins: row.plugins,
    createdAt: row.createdAt,
    recipe: row.recipe,
  };
}

export function writeSpaceTemplates(dshHome: string, templates: SpaceTemplate[]): SpaceTemplate[] {
  assertNotRealHome(dshHome);
  atomicWrite(
    templatesPath(dshHome),
    `${JSON.stringify({ schemaVersion: SPACE_RECIPE_SCHEMA_VERSION, templates }, null, 2)}\n`,
  );
  return templates;
}

export function saveSpaceTemplate(
  dshHome: string,
  spaceId: string,
  name: string,
  options: {
    displayName?: string;
    now?: Date;
    includeConfig?: boolean;
    llm?: LlmShareManifest;
  } = {},
): SpaceTemplate {
  if (spaceId === "web") throw new Error("The web space cannot be saved as a template.");
  const library = readPluginLibrary(dshHome);
  const plugins = listProfilePlugins(dshHome, spaceId)
    .map((plugin) => pluginToShare(plugin, { library, dshHome, spaceId }))
    .filter((row): row is SpaceSharePlugin => row !== null);
  const patchPath = join(dshHome, "profiles", spaceId, "cordis.patch.yml");
  const patch =
    options.includeConfig && existsSync(patchPath) ? readFileSync(patchPath, "utf8") : undefined;
  const recipe: SpaceRecipe = parseSpaceRecipe({
    schemaVersion: SPACE_RECIPE_SCHEMA_VERSION,
    displayName: options.displayName || name,
    plugins,
    patch,
    llm: options.llm,
  });
  const template: SpaceTemplate = {
    id: spaceTemplateId(name),
    name,
    displayName: options.displayName || name,
    plugins,
    createdAt: (options.now ?? new Date()).toISOString(),
    recipe,
  };
  const current = listSpaceTemplates(dshHome);
  const clash = current.find((row) => row.id === template.id && row.name !== name);
  if (clash) {
    throw new Error("Template id collision; original templates were left unchanged.");
  }
  const next = current.filter((row) => row.id !== template.id);
  next.push(template);
  writeSpaceTemplates(dshHome, next);
  return template;
}

export async function createSpaceFromTemplate(
  template: SpaceTemplate,
  spaceId: string,
  ports: SpaceTemplatePorts,
): Promise<CreateFromTemplateResult> {
  const imported = await applySpaceRecipe(recipeFromTemplate(template), ports, {
    name: spaceId,
    displayName: template.displayName,
  });
  if (imported.definition !== "imported" || !imported.spaceId) {
    throw new Error(imported.errors[0] || "The template could not create a space.");
  }
  if (imported.plugins === "failed") {
    return { spaceId: imported.spaceId, plugins: "failed", errors: imported.errors };
  }
  if (imported.plugins === "pending-manual") {
    return { spaceId: imported.spaceId, plugins: "pending-manual", errors: imported.errors };
  }
  if (imported.plugins === "not-run") {
    return { spaceId: imported.spaceId, plugins: "failed", errors: imported.errors };
  }
  return { spaceId: imported.spaceId, plugins: "completed", errors: imported.errors };
}
