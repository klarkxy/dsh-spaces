/** Browser-safe space share types. Archives stay in the main process. */

import type { LlmShareManifest, LlmShareRequirement } from "../core/domain/llm-share";

export const SPACE_SHARE_KIND = "dsh-space" as const;
export const SPACE_SHARE_FORMAT_VERSION = 1 as const;
export const SPACE_RECIPE_SCHEMA_VERSION = 1 as const;

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
  llmMappingRequired: boolean;
  llmRequirements: LlmShareRequirement[];
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
  llm?: {
    mappingRequired: boolean;
    requirements: LlmShareRequirement[];
    mapped: false;
  };
}

export interface SpaceExportOptions {
  includeConfig?: boolean;
  llm?: LlmShareManifest;
}

/** Versioned local recipe. Shares are the portable zip wrapping the same fields. */
export interface SpaceRecipe {
  schemaVersion: typeof SPACE_RECIPE_SCHEMA_VERSION;
  displayName: string;
  icon?: string;
  plugins: SpaceSharePlugin[];
  patch?: string;
  llm?: LlmShareManifest;
  source?: { dshVersion?: string | null };
}

export interface SpaceTemplate {
  id: string;
  name: string;
  displayName: string;
  plugins: SpaceSharePlugin[];
  createdAt: string;
  recipe?: SpaceRecipe;
}

export interface CreateFromTemplateResult {
  spaceId: string;
  plugins: "completed" | "failed" | "pending-manual";
  errors: string[];
}
