import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";
import { listProfilePlugins } from "./plugin-ops";
import { pluginToShare } from "./space-share";
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

export function listSpaceTemplates(dshHome: string): SpaceTemplate[] {
  assertNotRealHome(dshHome);
  const path = templatesPath(dshHome);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { templates?: unknown };
    return Array.isArray(parsed.templates) ? parsed.templates.filter(isTemplate) : [];
  } catch {
    return [];
  }
}

function isTemplate(value: unknown): value is SpaceTemplate {
  if (!value || typeof value !== "object") return false;
  const row = value as SpaceTemplate;
  return typeof row.id === "string" && typeof row.name === "string" && Array.isArray(row.plugins);
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
  const plugins = listProfilePlugins(dshHome, spaceId)
    .map(pluginToShare)
    .filter((row): row is SpaceSharePlugin => row !== null);
  const template: SpaceTemplate = {
    id: name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 39) || "template",
    name,
    displayName: options.displayName || name,
    plugins,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  const current = listSpaceTemplates(dshHome).filter((row) => row.id !== template.id);
  current.push(template);
  writeSpaceTemplates(dshHome, current);
  return template;
}

export async function createSpaceFromTemplate(
  template: SpaceTemplate,
  spaceId: string,
  ports: SpaceTemplatePorts,
): Promise<CreateFromTemplateResult> {
  await ports.createSpace({ name: spaceId, displayName: template.displayName });
  const errors: string[] = [];
  const npmPlugins = template.plugins.filter((row) => row.source === "npm" && row.resolvedVersion);
  const batch = await runBatch(npmPlugins, async (plugin) => {
    const spec = plugin.installSpec || `${plugin.packageName}@${plugin.resolvedVersion}`;
    await ports.installPlugin(spaceId, spec);
  });
  if (batch.failed) {
    errors.push(batch.failed.error);
    return { spaceId, plugins: "failed", errors };
  }
  const pending = template.plugins.some((row) => row.source !== "npm" || !row.resolvedVersion);
  return { spaceId, plugins: pending ? "pending-manual" : "completed", errors };
}
