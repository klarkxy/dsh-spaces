export interface BlueprintPackage { name: string; version: string; source: 'npm' | 'builtin' }
export interface BlueprintDocument {
  kind: 'dsh-blueprint';
  formatVersion: 2;
  metadata: { name: string; description?: string };
  packages: BlueprintPackage[];
  bundles: string[];
}
export interface BlueprintCatalogPackage {
  name: string;
  version: string | null;
  source: 'npm' | 'builtin' | null;
  enabled: boolean;
  readonly: boolean;
  reason: string | null;
}
export interface BlueprintCatalog { packages: BlueprintCatalogPackage[]; order: string[]; stamp: string }
export function validate(value: unknown): BlueprintDocument;
export function parseBlueprint(code: string): BlueprintDocument;
export function encodeBlueprint(document: BlueprintDocument): { code: string };
export class BlueprintCore {
  constructor(port: { snapshot(): Promise<BlueprintCatalog> });
  catalog(signal?: AbortSignal): Promise<BlueprintCatalog>;
  generate(request: { packages: string[]; name: string }, signal?: AbortSignal): Promise<{ code: string }>;
}
