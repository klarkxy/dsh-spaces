/** Ordinary plugin identity. The full Spaces manager is not a workspace plugin. */

export const FULL_SPACES_PACKAGE = "dsh-spaces";
export const LEGACY_SPACES_PACKAGE = "@dsh-spaces/plugin";
export const FULL_SPACES_PACKAGES = [FULL_SPACES_PACKAGE, LEGACY_SPACES_PACKAGE] as const;
export const SPACES_COMPONENT_PACKAGES = {
  plugin: FULL_SPACES_PACKAGE,
  "view-bridge": "@dsh-spaces/view-bridge",
  browser: "@dsh-spaces/browser",
} as const;

export function isFullSpacesManagerSpec(spec: string): boolean {
  const value = spec.trim().toLowerCase();
  if (!value) return false;
  return /(?:^|[/:])(?:dsh-spaces|@dsh-spaces\/plugin)(?=$|[@/#])/.test(value);
}

export function isUnresolvedPluginAlias(spec: string): boolean {
  const value = spec.trim().toLowerCase();
  return value.startsWith("npm:") || value.startsWith("node:") || value.startsWith("file:");
}
