import {
  INSTALLABLE_PLUGIN_TIERS,
  type PluginCatalogEntry,
} from "./types";

export function isSafeSpec(spec: string): boolean {
  if (spec === "" || spec.length > 200) return false;
  if (spec.startsWith("-")) return false;
  return /^[@a-zA-Z0-9][a-zA-Z0-9._~:/#@+-]*$/.test(spec);
}

/** npm package name with no version, tag, or range. */
export function isBareNpmPackageName(name: string): boolean {
  if (!isSafeSpec(name) || isGitSpec(name)) return false;
  if (name.startsWith("@")) {
    const rest = name.slice(1);
    if (rest.includes("@") || rest.includes(":")) return false;
    const parts = rest.split("/");
    return parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]);
  }
  return !name.includes("@") && !name.includes("/") && !name.includes(":");
}

export function pluginSearchText(entry: {
  id: string;
  repo: string;
  owner: string;
  packageName?: string;
  summary?: string;
  summaryEn?: string;
  description: string;
  tags: string[];
}): string {
  return [entry.id, entry.repo, entry.owner, entry.packageName, entry.summary, entry.summaryEn, entry.description, ...entry.tags]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function matchesPluginQuery(entry: Parameters<typeof pluginSearchText>[0], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = pluginSearchText(entry);
  if (hay.includes(q)) return true;
  const tokens = q.split(/[\s/:._-]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => hay.includes(token));
}

export function isGitSpec(spec: string): boolean {
  return spec.startsWith("github:");
}

export function isInstallableEntry(entry: PluginCatalogEntry): boolean {
  return (
    INSTALLABLE_PLUGIN_TIERS.includes(entry.tier) &&
    entry.installMethod !== "manual" &&
    typeof entry.installSpec === "string" &&
    isSafeSpec(entry.installSpec)
  );
}


export function pluginDisplayName(entry: Pick<PluginCatalogEntry, "packageName" | "repo" | "id">): string {
  const raw = entry.packageName || entry.repo || entry.id;
  const noScope = raw.replace(/^@[^/]+\//, "");
  const slash = noScope.lastIndexOf("/");
  return slash >= 0 ? noScope.slice(slash + 1) : noScope;
}

export function pluginAliases(entry: { spec: string; packageName: string }): string[] {
  const names = [entry.packageName, entry.spec];
  if (entry.spec.startsWith("github:")) {
    const repo = entry.spec.slice("github:".length).split("/")[1];
    if (repo) names.push(repo);
  }
  return [...new Set(names.filter(Boolean))];
}


