/** Ordinary plugin identity. The full Spaces manager is not a workspace plugin. */

export const FULL_SPACES_PACKAGE = "@dsh-spaces/plugin";

export function isFullSpacesManagerSpec(spec: string): boolean {
  const value = spec.trim().toLowerCase();
  if (!value) return false;
  if (value === FULL_SPACES_PACKAGE) return true;
  if (value.startsWith(`${FULL_SPACES_PACKAGE}@`)) return true;
  if (/(^|\/)@dsh-spaces\/plugin(\b|@)/.test(value)) return true;
  if (value.startsWith("npm:") && value.includes("@dsh-spaces/plugin")) return true;
  if (value.startsWith("node:") && value.includes("@dsh-spaces/plugin")) return true;
  return false;
}

export function isUnresolvedPluginAlias(spec: string): boolean {
  const value = spec.trim().toLowerCase();
  return value.startsWith("npm:") || value.startsWith("node:") || value.startsWith("file:");
}
