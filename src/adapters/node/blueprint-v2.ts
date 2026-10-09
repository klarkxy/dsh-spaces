import { parseBlueprintDocument, type BlueprintDocument } from "@klarkxy/dsh-blueprint/document";
import type { BlueprintGenerateSelection, BlueprintSourcePackage } from "../../shared/workbench-blueprint";

/** v2 shares exact identities and order; configuration requires the v1 format. */
export function generateBlueprintV2(input: {
  selection: BlueprintGenerateSelection;
  metadata: { name: string; description?: string };
  bindingOverrides?: unknown[];
}, available: BlueprintSourcePackage[], bundles: string[]): BlueprintDocument {
  if (input.selection.includePatch || input.selection.settingsNamespaces.length || input.bindingOverrides?.length) {
    throw new Error("Blueprint v2 cannot include configuration presets or input bindings. Use format version 1.");
  }
  const selected = [...new Set(input.selection.packages)];
  const packages = selected.map((name) => {
    const row = available.find((item) => item.name === name);
    if (!row || !row.eligibility.available || !row.version || (row.source !== "npm" && row.source !== "builtin")) {
      throw new Error("A selected package has no eligible installed identity.");
    }
    return { name: row.name, version: row.version, source: row.source };
  });
  const metadata = input.metadata.description === undefined
    ? { name: input.metadata.name }
    : { name: input.metadata.name, description: input.metadata.description };
  return parseBlueprintDocument({
    kind: "dsh-blueprint", formatVersion: 2, metadata, packages,
    bundles: bundles.filter((name) => selected.includes(name)),
  });
}
