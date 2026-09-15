import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";
import { listProfilePlugins } from "./plugin-ops";
import { readPluginLibrary } from "./plugin-library";
import { canonicalNpmInstallSpec, pluginToShare } from "./space-share";
import type { CreateFromTemplateResult, SpaceSharePlugin, SpaceTemplate } from "../shared/space-share";
import { runBatch } from "../shared/batch";

export const SPACE_TEMPLATES_FILE = "space-templates.json";

export interface SpaceTemplatePorts {
  createSpace(input: { name: string; displayName: string }): Promise<void>;
  installPlugin(spaceId: string, spec: string): Promise<void>;
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { templates?: unknown }).templates)) {
    throw new Error("Space templates file is not a valid template list. Original bytes were left unchanged.");
  }
  const templates = (parsed as { templates: unknown[] }).templates;
  if (!templates.every(isTemplate)) {
    throw new Error("Space templates file contains an invalid template. Original bytes were left unchanged.");
  }
  return templates;
}

function isTemplate(value: unknown): value is SpaceTemplate {
  if (!value || typeof value !== "object") return false;
  const row = value as SpaceTemplate;
  return (
    typeof row.id === "string" &&
    Boolean(row.id) &&
    typeof row.name === "string" &&
    Boolean(row.name) &&
    typeof row.displayName === "string" &&
    Boolean(row.displayName) &&
    typeof row.createdAt === "string" &&
    Array.isArray(row.plugins) &&
    row.plugins.every((plugin) => {
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
  );
}

export function writeSpaceTemplates(dshHome: string, templates: SpaceTemplate[]): SpaceTemplate[] {
  assertNotRealHome(dshHome);
  atomicWrite(templatesPath(dshHome), `${JSON.stringify({ templates }, null, 2)}\n`);
  return templates;
}

export function saveSpaceTemplate(
  dshHome: string,
  spaceId: string,
  name: string,
  options: { displayName?: string; now?: Date } = {},
): SpaceTemplate {
  const library = readPluginLibrary(dshHome);
  const plugins = listProfilePlugins(dshHome, spaceId)
    .map((plugin) => pluginToShare(plugin, { library, dshHome, spaceId }))
    .filter((row): row is SpaceSharePlugin => row !== null);
  const template: SpaceTemplate = {
    id: spaceTemplateId(name),
    name,
    displayName: options.displayName || name,
    plugins,
    createdAt: (options.now ?? new Date()).toISOString(),
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
  await ports.createSpace({ name: spaceId, displayName: template.displayName });
  const errors: string[] = [];
  const auto: { plugin: SpaceSharePlugin; spec: string }[] = [];
  for (const plugin of template.plugins) {
    const spec = canonicalNpmInstallSpec(plugin);
    if (spec) auto.push({ plugin, spec });
  }
  const batch = await runBatch(auto, async (row) => {
    await ports.installPlugin(spaceId, row.spec);
  });
  if (batch.failed) {
    errors.push(batch.failed.error);
    return { spaceId, plugins: "failed", errors };
  }
  const pending = template.plugins.some((row) => canonicalNpmInstallSpec(row) === null);
  return { spaceId, plugins: pending ? "pending-manual" : "completed", errors };
}
