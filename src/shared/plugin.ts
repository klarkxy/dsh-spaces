import { INSTALLABLE_PLUGIN_TIERS, type PluginCatalogEntry } from "./types";

export function isSafeSpec(spec: string): boolean {
  if (spec === "" || spec.length > 200) return false;
  if (spec.startsWith("-")) return false;
  return /^[@a-zA-Z0-9][a-zA-Z0-9._~:/-]*$/.test(spec);
}

export function isInstallableEntry(entry: PluginCatalogEntry): boolean {
  return (
    INSTALLABLE_PLUGIN_TIERS.includes(entry.tier) &&
    entry.installMethod !== "manual" &&
    typeof entry.installSpec === "string" &&
    isSafeSpec(entry.installSpec)
  );
}
