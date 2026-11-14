import { valid as validVersion } from "semver";
import type { PluginCatalogEntry, PluginCatalogMeta } from "../../../shared/types";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The public dsh-plugins feed is also consumed by dsh-dev-index. Reuse that
 * published data contract, without importing a host plugin's private modules.
 * npm metadata remains authoritative for the version selected at installation.
 */
export function parsePublishedPluginCatalog(value: unknown): { meta: PluginCatalogMeta; entries: PluginCatalogEntry[] } {
  const feed = record(value);
  if (!feed || !Array.isArray(feed.plugins) || !text(feed.generatedAt)) {
    throw new Error("unsupported published plugin catalog");
  }
  const entries = new Map<string, PluginCatalogEntry>();
  for (const candidate of feed.plugins) {
    const row = record(candidate);
    if (!row) throw new Error("Invalid published plugin entry.");
    // Shared service libraries are dependencies, not installable DSH bundles.
    if (row.kind === "service") continue;
    if (row.kind !== "plugin" && row.kind !== "preset") throw new Error("Unknown published plugin kind.");
    const name = text(row.package);
    const version = text(row.version);
    if (!PACKAGE_NAME.test(name) || name.length > 214 || validVersion(version) !== version) {
      throw new Error("Invalid published plugin package or version.");
    }
    const repository = new URL(text(row.repository));
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repository.href)) {
      throw new Error("Invalid published plugin repository.");
    }
    const repo = repository.pathname.replace(/^\/|\/$/g, "");
    const summary = record(row.summary);
    const title = record(row.title);
    const category = text(row.category) || "other";
    if (entries.has(name)) throw new Error(`Duplicate published plugin ${name}.`);
    entries.set(name, {
      id: name,
      repo,
      owner: repo.split("/")[0]!,
      url: repository.href,
      tier: "verified-npm",
      packageName: name,
      installMethod: "npm",
      installSpec: `${name}@${version}`,
      runsBuildScript: false,
      description: text(summary?.en) || text(summary?.zh),
      summary: text(summary?.zh),
      summaryEn: text(summary?.en),
      category,
      tags: [text(title?.zh), text(title?.en), category].filter(Boolean),
      stars: 0,
      hasClient: false,
    });
  }
  return {
    meta: { schemaVersion: 1, generatedAt: text(feed.generatedAt), count: entries.size, contentHash: "dsh-plugins-published" },
    entries: [...entries.values()],
  };
}
