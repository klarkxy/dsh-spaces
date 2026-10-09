import type { Blueprint as BlueprintV1, BlueprintMetadata, BlueprintPackage as PackageV1, BlueprintPackageSource, BlueprintInputValues, BlueprintBindResult, BlueprintEnvironment, BlueprintDiagnostic } from './lib/v1/types.js';
import type { BlueprintDocument as BlueprintV2 } from './core.mjs';
export type BlueprintDocument = BlueprintV1 | BlueprintV2;
export type BlueprintRecipe = Omit<BlueprintV1, 'formatVersion' | 'metadata' | 'packages'> & {
  formatVersion: 1 | 2;
  metadata: Omit<BlueprintMetadata, 'version'> & { version?: string };
  packages: Array<Omit<PackageV1, 'source'> & { source: BlueprintPackageSource | { type: 'builtin' } }>;
  document: BlueprintDocument;
};
export function parseBlueprintDocument(value: unknown): BlueprintDocument;
export function blueprintRecipe(document: BlueprintDocument): BlueprintRecipe;
export function bindDocumentInputs(document: BlueprintDocument, values: BlueprintInputValues): BlueprintBindResult;
export function diagnoseDocument(document: BlueprintDocument, environment?: BlueprintEnvironment): BlueprintDiagnostic[];
