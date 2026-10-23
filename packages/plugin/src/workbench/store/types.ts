/**
 * The state and shape vocabulary of the workbench client.
 *
 * These declarations were the head of `workbench/store.ts`. They move here
 * unchanged: the types describe the client state, not the behaviour that
 * produces it, so every part module imports them from here.
 */

import type { SpaceDetail } from "../../../../../src/shared/spaces-control";
import type { SpaceImportResult, SpaceSharePreview, SpaceTemplate } from "../../../../../src/shared/space-share";
import type { PluginCatalogSnapshot, ThemePreference } from "../../../../../src/shared/types";
import type {
  WorkbenchBackup,
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchSnapshot,
  WorkbenchState,
} from "../../../../../src/shared/workbench";
import type {
  WorkbenchDiagnostics,
  WorkbenchHomeSettings,
  WorkbenchLibraryItem,
  WorkbenchProductObservation,
  WorkbenchProductOutcome,
} from "../../../../../src/shared/workbench-product";
import type { WorkbenchLogEntry } from "../../../../../src/shared/workbench-log";
import type { BlueprintUiState } from "../blueprint-session";
import type { WorkbenchLocale } from "../i18n";
import type { StorageLike } from "../persistence";
import type { ViewFrameState, ViewMessageEvent } from "../view-session";

export type { SpaceImportResult };

export type HomeTab = "overview" | "spaces" | "plugins" | "snapshots" | "runtime" | "templates" | "blueprints";

export type OverlayKind =
  | { type: "create" }
  | { type: "rename"; spaceId: string }
  | { type: "icon"; spaceId: string }
  | { type: "settings" }
  | { type: "import" }
  | { type: "menu"; spaceId: string; x: number; y: number }
  | null;

export interface SettingsDraft {
  settings: WorkbenchHomeSettings;
  observation: WorkbenchProductObservation;
  dirty: boolean;
}

export interface ImportPreviewState {
  importId: string;
  expiresAt: string;
  preview: SpaceSharePreview;
  observation: WorkbenchProductObservation;
  fileName: string;
}

/**
 * The published npm versions of one catalog entry.
 *
 * The versions are exact semver, newest first. A failed read keeps its reason:
 * there is no retry and no guessed version.
 */
export interface WorkbenchPluginVersions {
  catalogId: string;
  packageName: string;
  versions: string[];
  latest: string | null;
  status: "loading" | "ready" | "error";
  error: string | null;
}

/** The options of one submit. */
export interface SubmitOptions {
  /** The mutation context of a prepared plan. */
  context?: WorkbenchMutationContext;
  /** The surface that owns the failure of this command. */
  origin?: string | null;
  /** Called with the accepted job, before the next poll. */
  onJob?: (job: WorkbenchJob) => void;
}

export interface WorkbenchEnv {
  uuid(): string;
  storage: StorageLike;
  hidden(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  now(): number;
  handshakeTimeoutMs: number;
  startTimeoutMs: number;
  openUrl(url: string): void;
  downloadFile(fileName: string, archiveBase64: string): void;
  writeClipboard(text: string): Promise<void>;
  addMessageListener(listener: (event: ViewMessageEvent) => void): () => void;
}

export interface WorkbenchUiState {
  locale: WorkbenchLocale;
  theme: ThemePreference;
  boot: "loading" | "ready" | "error";
  error: string | null;
  state: WorkbenchState | null;
  selected: "home" | string;
  pendingId: string | null;
  createdNotice: { spaceId: string } | null;
  frames: ViewFrameState[];
  visibleSpaceId: string | null;
  viewError: { spaceId: string; message: string } | null;
  overlay: OverlayKind;
  pendingPlan: { request: WorkbenchPlanRequest; plan: WorkbenchPlan } | null;
  planError: string | null;
  commandError: string | null;
  /** The surface that owns the last failure. A failure without an origin stays global. */
  requestOrigin: string | null;
  commandPending: boolean;
  readError: Partial<Record<WorkbenchReadSurface, string>>;
  homeTab: HomeTab;
  settingsTab: "general" | "llm" | "advanced" | HomeTab;
  /** The space whose detail page is open inside the spaces tab. */
  detailSpaceId: string | null;
  /** The maintenance group of the settings navigation, remembered for this session. */
  maintenanceExpanded: boolean;
  settingsDraft: SettingsDraft | null;
  settingsStatus: "idle" | "loading" | "ready" | "error";
  detail: SpaceDetail | null;
  detailStatus: "idle" | "loading" | "ready" | "error";
  backups: WorkbenchBackup[];
  diagnostics: WorkbenchDiagnostics | null;
  diagnosticsStatus: "idle" | "loading" | "ready" | "error";
  logs: WorkbenchLogEntry[];
  logsStatus: "idle" | "loading" | "ready" | "error";
  logsError: string | null;
  plugins: WorkbenchPlugin[];
  pluginQuery: string;
  pluginSpaceId: string;
  pluginCatalogId: string;
  pluginVersion: string;
  pluginSpec: string;
  pluginsStatus: "idle" | "loading" | "ready" | "error";
  /** The published npm versions of a catalog entry, loaded on demand. */
  pluginVersions: Record<string, WorkbenchPluginVersions>;
  catalog: PluginCatalogSnapshot | null;
  catalogStatus: "idle" | "loading" | "ready" | "error";
  library: WorkbenchLibraryItem[];
  libraryStatus: "idle" | "loading" | "ready" | "error";
  snapshots: WorkbenchSnapshot[];
  snapshotsStatus: "idle" | "loading" | "ready" | "error";
  runtimes: WorkbenchRuntime[];
  runtimesStatus: "idle" | "loading" | "ready" | "error";
  templates: SpaceTemplate[];
  templatesStatus: "idle" | "loading" | "ready" | "error";
  templateId: string;
  templateName: string;
  templateDisplayName: string;
  templateSpaceId: string;
  templateIncludeConfig: boolean;
  shareSpaceId: string;
  shareIncludeConfig: boolean;
  importPreview: ImportPreviewState | null;
  importName: string;
  importDisplayName: string;
  lastProductOutcome: WorkbenchProductOutcome | null;
  blueprint: BlueprintUiState;
}

export type WorkbenchReadSurface =
  | "settings"
  | "catalog"
  | "library"
  | "plugins"
  | "templates"
  | "snapshots"
  | "runtimes"
  | "package"
  | "diagnostics"
  | "detail"
  | "logs";
