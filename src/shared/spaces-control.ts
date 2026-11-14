/** Browser-safe control-plane DTOs. No paths, launch URLs, raw config or logs. */
export type SpacesMode = "verified-full" | "verified-limited" | "unknown-readonly" | "recovery-only";

export interface SpacesCapabilities {
  mode: SpacesMode;
  hostSpaceId: string | null;
  dshVersion: string | null;
  canCreate: boolean;
  reasons: string[];
}

export interface SpaceSummary {
  id: string;
  displayName: string;
  isHost: boolean;
  hasWebApp: boolean;
  status: "running" | "stopped" | "unknown";
}

export interface SpacesOverview {
  capabilities: SpacesCapabilities;
  spaces: SpaceSummary[];
}

export interface SpaceModelConfig {
  status: 'configured' | 'incomplete' | 'unconfigured';
  routeNames: string[];
  defaultModel: string | null;
  missingCredentials: string[];
}

export interface SpaceDetail {
  /** Read from this space's own patch and credentials; no model requests are sent. */
  models: SpaceModelConfig;
  space: SpaceSummary;
  plugins: Array<{ name: string; version: string | null }>;
  snapshots: Array<{ id: string; createdAt: string; runtimeVersion: string | null }>;
  diagnostics: Array<{ level: "info" | "warning" | "error"; code: string; message: string }>;
}

export interface CreateSpaceInput {
  name: string;
  displayName?: string;
}

/** Transport adapters wrap these operations in the upstream typed Remote API. */
export interface SpacesApi {
  overview(): Promise<SpacesOverview>;
  detail(id: string): Promise<SpaceDetail>;
  create(input: CreateSpaceInput): Promise<SpaceSummary>;
}
