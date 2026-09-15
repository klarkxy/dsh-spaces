/** Browser-safe space share types. Archives stay in the main process. */

export const SPACE_SHARE_KIND = "dsh-space" as const;
export const SPACE_SHARE_FORMAT_VERSION = 1 as const;

export type SpaceSharePluginSource = "npm" | "git" | "manual" | "unknown";

export interface SpaceShareManifest {
  formatVersion: typeof SPACE_SHARE_FORMAT_VERSION;
  kind: typeof SPACE_SHARE_KIND;
  exportedAt: string;
  source: { dshVersion?: string | null };
  space: { displayName: string; icon?: string };
}

export interface SpaceSharePlugin {
  packageName: string;
  requestedSpec?: string;
  resolvedVersion: string | null;
  source: SpaceSharePluginSource;
  installSpec?: string;
}

export interface SpaceSharePreview {
  manifest: SpaceShareManifest;
  plugins: SpaceSharePlugin[];
  hasConfig: boolean;
  unknownSources: string[];
}

export type SpaceShareDefinitionStatus = "imported" | "failed";
export type SpaceSharePluginStatus = "completed" | "failed" | "pending-manual" | "not-run";
export type SpaceShareStartStatus = "not-run" | "failed";

export interface SpaceImportResult {
  definition: SpaceShareDefinitionStatus;
  plugins: SpaceSharePluginStatus;
  start: SpaceShareStartStatus;
  spaceId?: string;
  errors: string[];
  pendingManual: SpaceSharePlugin[];
}

export interface SpaceExportOptions {
  includeConfig?: boolean;
}

export interface SpaceTemplate {
  id: string;
  name: string;
  displayName: string;
  plugins: SpaceSharePlugin[];
  createdAt: string;
}

export interface CreateFromTemplateResult {
  spaceId: string;
  plugins: "completed" | "failed" | "pending-manual";
  errors: string[];
}
