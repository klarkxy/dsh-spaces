import type { SpaceDetail } from "../../../../src/shared/spaces-control";
import type { SpaceImportResult, SpaceSharePreview, SpaceTemplate } from "../../../../src/shared/space-share";
import type { LocalePreference, PluginCatalogSnapshot, ThemePreference } from "../../../../src/shared/types";
import type {
  WorkbenchApi,
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPackageRelease,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchSnapshot,
  WorkbenchSpace,
  WorkbenchState,
  WorkbenchView,
} from "../../../../src/shared/workbench";
import {
  MAX_WORKBENCH_SHARE_BASE64,
  type WorkbenchDiagnostics,
  type WorkbenchHomeSettings,
  type WorkbenchLibraryItem,
  type WorkbenchProductObservation,
  type WorkbenchProductOutcome,
} from "../../../../src/shared/workbench-product";
import type { WorkbenchLogEntry } from "../../../../src/shared/workbench-log";
import { createWorkbenchLlmClient, type LlmUiClient } from "./llm/client";
import { validateWorkbenchIcon } from "./icons";
import { localizeError, t, type WorkbenchLocale, type WorkbenchMessageKey } from "./i18n";
import {
  defaultStorage,
  homeSelectionId,
  isHomeSelection,
  persistWasEmpty,
  readPersist,
  writePersist,
  type StorageLike,
} from "./persistence";
import {
  acceptViewMessage,
  authorizedViewSrc,
  ViewSession,
  type ViewFrameState,
  type ViewMessageEvent,
} from "./view-session";
import {
  BlueprintSession,
  type BlueprintUiState,
} from "./blueprint-session";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const RESERVED = new Set(["web", "hub", "headless", "node_modules", "spaces-hub"]);
const ACTIVE_JOB = new Set(["queued", "running"]);

export type HomeTab = "overview" | "spaces" | "plugins" | "snapshots" | "runtime" | "templates" | "blueprints";

export type OverlayKind =
  | { type: "create" }
  | { type: "rename"; spaceId: string }
  | { type: "icon"; spaceId: string }
  | { type: "detail"; spaceId: string }
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
  commandPending: boolean;
  readError: Partial<Record<WorkbenchReadSurface, string>>;
  homeTab: HomeTab;
  settingsTab: "general" | "llm" | "advanced" | HomeTab;
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
  catalog: PluginCatalogSnapshot | null;
  catalogStatus: "idle" | "loading" | "ready" | "error";
  library: WorkbenchLibraryItem[];
  libraryStatus: "idle" | "loading" | "ready" | "error";
  snapshots: WorkbenchSnapshot[];
  snapshotsStatus: "idle" | "loading" | "ready" | "error";
  runtimes: WorkbenchRuntime[];
  runtimesStatus: "idle" | "loading" | "ready" | "error";
  workbenchPackage: WorkbenchPackageRelease | null;
  workbenchPackageStatus: "idle" | "loading" | "ready" | "error";
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

function defaultOpenUrl(url: string): void {
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function defaultWriteClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clipboard?.writeText) throw new Error("clipboard");
  await clipboard.writeText(text);
}

function defaultDownloadFile(fileName: string, archiveBase64: string): void {
  if (typeof document === "undefined" || typeof atob !== "function") return;
  const binary = atob(archiveBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function createDefaultEnv(): WorkbenchEnv {
  return {
    uuid: () => crypto.randomUUID(),
    storage: defaultStorage(),
    hidden: () => typeof document !== "undefined" && document.hidden,
    onVisibilityChange: (listener) => {
      if (typeof document === "undefined") return () => undefined;
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    handshakeTimeoutMs: 45_000,
    startTimeoutMs: 90_000,
    openUrl: defaultOpenUrl,
    downloadFile: defaultDownloadFile,
    writeClipboard: defaultWriteClipboard,
    addMessageListener: (listener) => {
      if (typeof window === "undefined") return () => undefined;
      const wrapped = (event: MessageEvent) => listener(event);
      window.addEventListener("message", wrapped);
      return () => window.removeEventListener("message", wrapped);
    },
  };
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

export function pollDelayMs(activeJobs: boolean, hidden: boolean): number {
  if (hidden) return activeJobs ? 2000 : 4000;
  return activeJobs ? 500 : 1000;
}

function localLogMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) return null;
  if (
    message.startsWith("The workbench request did not reach") ||
    message.startsWith("The workbench response") ||
    message.startsWith("The workbench endpoint") ||
    message.startsWith("The workbench error did not include") ||
    message.startsWith("Expected ")
  ) {
    return message;
  }
  return null;
}

function wrongProduct(expected: string, actual: string): Error {
  return Object.assign(new Error(`Expected ${expected}, received ${actual}.`), { code: "workbench/unavailable" });
}

function errorCode(error: unknown): { code?: string; message?: string } {
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  return {};
}

function intentKey(command: WorkbenchCommand): string {
  return JSON.stringify(command);
}

function mapLocale(value: LocalePreference): WorkbenchLocale {
  if (value === "en") return "en";
  if (value === "zh") return "zh";
  return "zh";
}

export class WorkbenchController {
  readonly views = new ViewSession();
  readonly blueprint: BlueprintSession;
  private readonly pendingViewRequests = new Set<string>();
  private readonly env: WorkbenchEnv;
  private readonly iframeWindows = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();
  private readonly intentRequestIds = new Map<string, string>();
  private readonly intentInflight = new Set<string>();
  private pollTimer: unknown = null;
  private waitTimer: unknown = null;
  private unsubVisibility: (() => void) | null = null;
  private unsubMessages: (() => void) | null = null;
  private running = false;
  private stateGeneration = 0;
  private cycle = 0;
  private wrapDepth = 0;
  private handledProductJobs = new Set<string>();
  private primedProductJobs = false;
  private submittedSettingsJson: string | null = null;
  private restoreId: string | null;
  private notedCreates = new Set<string>();
  private awaitingPackagePlanId: string | null = null;
  private awaitingPackageJobId: string | null = null;
  private prepareEpoch: string | null = null;
  private persistEmpty: boolean;
  private appliedClientDefaults = false;
  private ui: WorkbenchUiState;

  constructor(
    private readonly api: WorkbenchApi,
    env?: Partial<WorkbenchEnv>,
  ) {
    this.env = { ...createDefaultEnv(), ...env };
    this.persistEmpty = persistWasEmpty(this.env.storage);
    const persist = readPersist(this.env.storage);
    this.restoreId = isHomeSelection(persist.selectedId) ? null : persist.selectedId;
    this.blueprint = new BlueprintSession({
      product: (request) => this.api.product(request),
      submitApply: (planId, observation) => this.submitBlueprintApply(planId, observation),
      describeLlm: () => this.llmClient().describe(),
      uuid: () => this.env.uuid(),
      now: () => this.env.now(),
      downloadFile: (fileName, archiveBase64) => this.env.downloadFile(fileName, archiveBase64),
      writeClipboard: (text) => this.env.writeClipboard(text),
      locale: () => this.ui.locale,
      canMutate: () => this.canMutate(),
      serviceEpoch: () => this.ui.state?.serviceEpoch ?? null,
      emit: () => {
        this.ui = { ...this.ui, blueprint: this.blueprint.getSnapshot() };
        for (const listener of this.listeners) listener();
      },
    });
    this.ui = {
      locale: persist.locale,
      theme: persist.theme,
      boot: "loading",
      error: null,
      state: null,
      selected: "home",
      pendingId: null,
      createdNotice: null,
      frames: [],
      visibleSpaceId: null,
      viewError: null,
      overlay: null,
      pendingPlan: null,
      planError: null,
      commandError: null,
      commandPending: false,
      readError: {},
      homeTab: "overview",
      settingsTab: "general",
      settingsDraft: null,
      settingsStatus: "idle",
      detail: null,
      detailStatus: "idle",
      backups: [],
      diagnostics: null,
      diagnosticsStatus: "idle",
      logs: [],
      logsStatus: "idle",
      logsError: null,
      plugins: [],
      pluginQuery: "",
      pluginSpaceId: "",
      pluginCatalogId: "",
      pluginVersion: "",
      pluginSpec: "",
      pluginsStatus: "idle",
      catalog: null,
      catalogStatus: "idle",
      library: [],
      libraryStatus: "idle",
      snapshots: [],
      snapshotsStatus: "idle",
      runtimes: [],
      runtimesStatus: "idle",
      workbenchPackage: null,
      workbenchPackageStatus: "idle",
      templates: [],
      templatesStatus: "idle",
      templateId: "",
      templateName: "",
      templateDisplayName: "",
      templateSpaceId: "",
      templateIncludeConfig: false,
      shareSpaceId: "",
      shareIncludeConfig: false,
      importPreview: null,
      importName: "",
      importDisplayName: "",
      lastProductOutcome: null,
      blueprint: this.blueprint.getSnapshot(),
    };
  }

  getSnapshot = (): WorkbenchUiState => {
    const blueprint = this.blueprint.getSnapshot();
    if (this.ui.blueprint !== blueprint) this.ui = { ...this.ui, blueprint };
    return this.ui;
  };

  now = (): number => this.env.now();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubVisibility = this.env.onVisibilityChange(() => this.schedulePoll());
    this.unsubMessages = this.env.addMessageListener((event) => this.handleMessage(event));
    void this.poll();
  }

  /** Disconnect this client only. Does not stop the supervisor or spaces. */
  stop(): void {
    this.running = false;
    this.cycle += 1;
    this.stateGeneration += 1;
    if (this.pollTimer !== null) this.env.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.clearWait();
    this.unsubVisibility?.();
    this.unsubMessages?.();
    this.unsubVisibility = null;
    this.unsubMessages = null;
    this.blueprint.abortPending();
  }

  private stillOpen(cycle: number): boolean {
    return cycle === this.cycle;
  }

  setLocale = (locale: WorkbenchLocale): void => {
    this.patch({ locale });
    this.writePersist();
  };

  setTheme = (theme: ThemePreference): void => {
    this.patch({ theme });
    this.writePersist();
  };

  setHomeTab = (homeTab: HomeTab): void => {
    this.patch({ homeTab, settingsTab: homeTab, overlay: { type: "settings" } });
    if (homeTab === "plugins") {
      if (this.ui.pluginsStatus === "idle") void this.searchPlugins(this.ui.pluginQuery);
      if (this.ui.catalogStatus === "idle") void this.loadCatalog(this.ui.pluginQuery);
      if (this.ui.libraryStatus === "idle") void this.loadLibrary();
    }
    if (homeTab === "snapshots" && this.ui.snapshotsStatus === "idle") void this.loadSnapshots();
    if (homeTab === "runtime" && this.ui.runtimesStatus === "idle") void this.loadRuntimes();
    if (homeTab === "runtime" && this.ui.workbenchPackageStatus === "idle") void this.loadWorkbenchPackage();
    if (homeTab === "templates" && this.ui.templatesStatus === "idle") void this.loadTemplates();
    if (homeTab === "overview") void this.loadLogs();
  };

  blueprintSourceSpaces = (): WorkbenchSpace[] => {
    return this.workspaceSpaces().filter((space) => space.id !== "web");
  };

  openBlueprintGenerate = (spaceId: string): void => {
    if (this.isManagerId(spaceId) || spaceId === "web") return;
    this.selectHome();
    this.setHomeTab("blueprints");
    this.blueprint.openGenerate(spaceId);
  };

  selectHome = (): void => {
    this.clearWait();
    this.views.commitHome();
    this.patch({
      selected: "home",
      pendingId: null,
      visibleSpaceId: null,
      viewError: null,
      overlay: this.ui.overlay?.type === "menu" ? null : this.ui.overlay,
      frames: this.views.list(),
    });
    this.writePersist();
  };

  selectSpace = (spaceId: string): void => {
    const space = this.space(spaceId);
    if (!space) return;
    this.beginSpace(space, { startIfStopped: true, force: false });
  };

  enterCreated = (): void => {
    const spaceId = this.ui.createdNotice?.spaceId;
    if (!spaceId) return;
    this.patch({ createdNotice: null });
    this.selectSpace(spaceId);
  };

  registerIframeWindow = (spaceId: string, generation: number, win: unknown): void => {
    const key = `${spaceId}:${generation}`;
    if (win) this.iframeWindows.set(key, win);
    else this.iframeWindows.delete(key);
  };

  handleMessage = (event: ViewMessageEvent): void => {
    for (const frame of this.views.list()) {
      const iframeWindow = this.iframeWindows.get(`${frame.spaceId}:${frame.generation}`);
      const message = acceptViewMessage(event, frame, iframeWindow);
      if (!message) continue;
      this.views.onAcceptedMessage(frame.spaceId, message);
      this.syncSelection();
      return;
    }
  };

  retryView = (spaceId: string): void => {
    const space = this.space(spaceId);
    if (!space) return;
    this.beginSpace(space, { startIfStopped: true, force: true });
  };

  openIndependent = (spaceId: string): void => {
    const cycle = this.cycle;
    void this.wrap(async () => {
      const view = await this.api.view(spaceId);
      if (!this.stillOpen(cycle)) return;
      this.env.openUrl(authorizedViewSrc(view));
    });
  };

  openCreate = (): void => {
    if (!this.canMutate()) {
      this.patch({ commandError: localizeError(this.ui.locale, "workbench/read-only") });
      return;
    }
    this.patch({ overlay: { type: "create" }, commandError: null });
  };

  openRename = (spaceId: string): void => {
    if (!this.canMutate()) return this.rejectReadonly();
    this.patch({ overlay: { type: "rename", spaceId } });
  };

  openIcon = (spaceId: string): void => {
    if (!this.canMutate()) return this.rejectReadonly();
    this.patch({ overlay: { type: "icon", spaceId } });
  };

  openSettings = (): void => {
    this.patch({ overlay: { type: "settings" }, settingsTab: "general" });
    void this.loadSettings();
  };

  setSettingsTab = (settingsTab: WorkbenchUiState["settingsTab"]): void => {
    if (settingsTab !== "general" && settingsTab !== "llm" && settingsTab !== "advanced") {
      this.setHomeTab(settingsTab);
      return;
    }
    this.patch({ settingsTab });
  };

  private cachedLlmClient: LlmUiClient | null = null;

  llmClient = (): LlmUiClient => {
    this.cachedLlmClient ??= createWorkbenchLlmClient(this.api, this.env.uuid);
    return this.cachedLlmClient;
  };

  llmSpaces = (): import("./llm/client").LlmUiSpace[] => {
    const epoch = this.ui.state?.serviceEpoch ?? "";
    return (this.ui.state?.spaces ?? []).map((space) => ({
      spaceId: space.id,
      displayName: space.displayName,
      status: space.status,
      generation: space.generation,
      serviceEpoch: epoch,
    }));
  };

  openDetail = (spaceId: string): void => {
    this.patch({ overlay: { type: "detail", spaceId } });
    void this.loadDetail(spaceId);
  };

  openMenu = (spaceId: string, x: number, y: number): void => {
    this.patch({ overlay: { type: "menu", spaceId, x, y } });
  };

  closeOverlay = (): void => this.patch({ overlay: null, planError: null });

  closePlan = (): void => this.patch({ pendingPlan: null, planError: null });

  closeImport = (): void => this.patch({ overlay: null, importPreview: null, planError: null });

  reportFailure = (error: unknown): void => {
    this.patch({ commandError: localizeError(this.ui.locale, errorCode(error)) });
  };

  createSpace = (input: { name: string; displayName?: string; icon?: string; useSharedLlm?: boolean }): void => {
    const name = input.name.trim().toLowerCase();
    if (!NAME_RE.test(name)) {
      this.patch({ commandError: this.msg("app.nameInvalid") });
      return;
    }
    if (RESERVED.has(name)) {
      this.patch({ commandError: this.msg("app.nameReserved") });
      return;
    }
    const icon = validateWorkbenchIcon(input.icon);
    if (!icon.ok) {
      this.patch({ commandError: this.msg(icon.reason === "too-large" ? "app.iconTooLarge" : "app.iconInvalid") });
      return;
    }
    void this.submit({
      kind: "space.create",
      input: {
        name,
        displayName: input.displayName?.trim() || undefined,
        icon: icon.icon || undefined,
        ...(input.useSharedLlm === undefined ? {} : { useSharedLlm: input.useSharedLlm }),
      },
    });
    this.patch({ overlay: null });
  };

  updateSpace = (spaceId: string, patch: { displayName?: string; icon?: string }): void => {
    if (patch.icon !== undefined) {
      const icon = validateWorkbenchIcon(patch.icon);
      if (!icon.ok) {
        this.patch({ commandError: this.msg(icon.reason === "too-large" ? "app.iconTooLarge" : "app.iconInvalid") });
        return;
      }
      patch = { ...patch, icon: icon.icon };
    }
    void this.submit({ kind: "space.update", spaceId, ...patch });
    this.patch({ overlay: null });
  };

  moveSpace = (spaceId: string, direction: -1 | 1): void => {
    const ids = this.workspaceIds();
    const index = ids.indexOf(spaceId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    const copy = [...ids];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    const managerId = this.ui.state?.managerId;
    const spaceIds = managerId && !copy.includes(managerId) ? [managerId, ...copy] : copy;
    void this.submit({ kind: "space.reorder", spaceIds });
  };

  startSpace = (spaceId: string): void => {
    this.selectSpace(spaceId);
  };

  verifySpace = (spaceId: string): void => {
    void this.submit({ kind: "space.verify", spaceId });
  };

  preview = (request: WorkbenchPlanRequest): void => {
    if (!this.canMutate()) {
      this.rejectReadonly();
      return;
    }
    if (request.kind === "space.delete" && this.isManagerId(request.spaceId)) {
      this.patch({ planError: this.msg("app.managerProtected"), pendingPlan: null });
      return;
    }
    if (
      (request.kind === "plugin.install" || request.kind === "plugin.toggle") &&
      this.touchesManagerPlugins(request)
    ) {
      this.patch({ planError: this.msg("app.managerProtected"), pendingPlan: null });
      return;
    }
    if (request.kind === "workbench.upgrade") {
      this.previewWorkbenchUpgrade();
      return;
    }
    void this.runPreview(request);
  };

  confirmPlan = (): void => {
    const pending = this.ui.pendingPlan;
    if (!pending) {
      this.patch({ planError: this.msg("app.noPlan") });
      return;
    }
    if (pending.request.kind === "workbench.upgrade" || pending.plan.kind === "workbench.upgrade") {
      this.awaitingPackagePlanId = pending.plan.id;
      this.awaitingPackageJobId = null;
    }
    this.patch({ pendingPlan: null, overlay: null });
    void this.submit({ kind: "plan.execute", planId: pending.plan.id });
  };

  cancelJob = (id: string): void => {
    const job = this.ui.state?.jobs.find((item) => item.id === id);
    if (!job?.canCancel) return;
    const cycle = this.cycle;
    void this.wrap(async () => {
      const next = await this.api.cancel(id);
      if (!this.stillOpen(cycle)) return;
      this.mergeJob(next);
    });
  };

  setPluginQuery = (pluginQuery: string): void => this.patch({ pluginQuery });
  setPluginSpace = (pluginSpaceId: string): void => this.patch({ pluginSpaceId });
  setPluginCatalog = (pluginCatalogId: string, pluginVersion?: string): void => {
    this.patch({
      pluginCatalogId,
      pluginVersion: pluginVersion ?? this.ui.pluginVersion,
    });
  };
  setPluginVersion = (pluginVersion: string): void => this.patch({ pluginVersion });
  setPluginSpec = (pluginSpec: string): void => this.patch({ pluginSpec });

  searchPlugins = (query: string): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ pluginQuery: query, pluginsStatus: "loading", readError: this.readErrors("plugins") });
    return this.wrap(async () => {
      const plugins = await this.api.plugins(query);
      if (!this.stillOpen(cycle)) return;
      this.patch({ plugins: Array.isArray(plugins) ? plugins : [], pluginsStatus: "ready", readError: this.readErrors("plugins") });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ pluginsStatus: "error", readError: this.readErrors("plugins", message) });
    });
  };

  loadCatalog = (query?: string): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ catalogStatus: "loading", readError: this.readErrors("catalog") });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "catalog", query: query ?? this.ui.pluginQuery });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "catalog") {
        throw wrongProduct("catalog", result.method);
      }
      this.patch({ catalog: result.catalog, catalogStatus: "ready", readError: this.readErrors("catalog") });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ catalogStatus: "error", catalog: this.ui.catalog, readError: this.readErrors("catalog", message) });
    });
  };

  loadLibrary = (): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ libraryStatus: "loading", readError: this.readErrors("library") });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "library" });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "library") {
        throw wrongProduct("library", result.method);
      }
      this.patch({ library: result.items, libraryStatus: "ready", readError: this.readErrors("library") });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ libraryStatus: "error", readError: this.readErrors("library", message) });
    });
  };

  refreshCatalog = (): void => {
    const url = this.ui.settingsDraft?.settings.catalogUrl?.trim();
    void this.submit({ kind: "catalog.refresh", ...(url ? { url } : {}) });
  };

  downloadPlugin = (): void => {
    const catalogId = this.ui.pluginCatalogId.trim();
    const spec = this.ui.pluginSpec.trim();
    const version = this.ui.pluginVersion.trim();
    if (!catalogId && !spec) {
      this.patch({ commandError: this.msg("plugins.needDownload") });
      return;
    }
    void this.submit({
      kind: "plugin.download",
      ...(catalogId ? { catalogId } : {}),
      ...(spec ? { spec } : {}),
      ...(version ? { version } : {}),
    });
  };

  removeLibraryItem = (libraryId: string): void => {
    void this.submit({ kind: "plugin.library.remove", libraryId });
  };

  prepareWorkbenchPackage = (): void => {
    if (!this.canMutate()) {
      this.rejectReadonly();
      return;
    }
    if (this.isBusy()) {
      this.patch({ commandError: localizeError(this.ui.locale, "workbench/locked") });
      return;
    }
    this.prepareEpoch = this.ui.state?.serviceEpoch ?? null;
    void this.submit({ kind: "workbench.prepare" });
  };

  previewInstallSelected = (): void => {
    const { pluginSpaceId, pluginCatalogId, pluginVersion } = this.ui;
    if (!pluginSpaceId || !pluginCatalogId || !pluginVersion) {
      this.patch({ planError: this.msg("plugins.needExact"), pendingPlan: null });
      return;
    }
    this.preview({
      kind: "plugin.install",
      spaceIds: [pluginSpaceId],
      catalogId: pluginCatalogId,
      version: pluginVersion,
    });
  };

  loadSnapshots = (): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ snapshotsStatus: "loading", readError: this.readErrors("snapshots") });
    return this.wrap(async () => {
      const snapshots = await this.api.snapshots();
      if (!this.stillOpen(cycle)) return;
      this.patch({ snapshots: Array.isArray(snapshots) ? snapshots : [], snapshotsStatus: "ready", readError: this.readErrors("snapshots") });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ snapshotsStatus: "error", readError: this.readErrors("snapshots", message) });
    });
  };

  loadRuntimes = (): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ runtimesStatus: "loading", readError: this.readErrors("runtimes") });
    return this.wrap(async () => {
      const runtimes = await this.api.runtimes();
      if (!this.stillOpen(cycle)) return;
      this.patch({ runtimes: Array.isArray(runtimes) ? runtimes : [], runtimesStatus: "ready", readError: this.readErrors("runtimes") });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ runtimesStatus: "error", readError: this.readErrors("runtimes", message) });
    });
  };

  loadWorkbenchPackage = (): Promise<void> => {
    const loader = this.api.workbenchPackage;
    if (typeof loader !== "function") {
      this.patch({ workbenchPackage: null, workbenchPackageStatus: "ready", readError: this.readErrors("package") });
      return Promise.resolve();
    }
    const cycle = this.cycle;
    this.patch({ workbenchPackageStatus: "loading", readError: this.readErrors("package") });
    return this.wrap(async () => {
      const release = await loader();
      if (!this.stillOpen(cycle)) return;
      this.patch({
        workbenchPackage: release?.id === "bundled-workbench" ? release : null,
        workbenchPackageStatus: "ready",
        readError: this.readErrors("package"),
      });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ workbenchPackage: null, workbenchPackageStatus: "error", readError: this.readErrors("package", message) });
    });
  };

  loadSettings = (): Promise<void> => {
    if (this.ui.settingsDraft?.dirty) return Promise.resolve();
    const cycle = this.cycle;
    this.patch({ settingsStatus: "loading", readError: this.readErrors("settings") });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "settings" });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "settings") {
        throw wrongProduct("settings", result.method);
      }
      if (this.ui.settingsDraft?.dirty) return;
      this.applyClientDefaults(result.clientDefaults);
      this.patch({
        settingsDraft: { settings: result.settings, observation: result.observation, dirty: false },
        settingsStatus: "ready",
        readError: this.readErrors("settings"),
      });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ settingsStatus: "error", readError: this.readErrors("settings", message) });
    });
  };

  setHomeSettings = (patch: Partial<WorkbenchHomeSettings>): void => {
    const draft = this.ui.settingsDraft;
    if (!draft) return;
    this.patch({
      settingsDraft: {
        settings: { ...draft.settings, ...patch },
        observation: draft.observation,
        dirty: true,
      },
    });
  };

  saveHomeSettings = (): void => {
    const draft = this.ui.settingsDraft;
    if (!draft) return;
    this.submittedSettingsJson = JSON.stringify(draft.settings);
    void this.submit({ kind: "settings.update", settings: draft.settings }, draft.observation);
  };

  loadLogs = (): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ logsStatus: "loading", readError: this.readErrors("logs") });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "logs" });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "logs") throw wrongProduct("logs", result.method);
      this.patch({
        logs: result.entries,
        logsError: result.logError,
        logsStatus: "ready",
        readError: this.readErrors("logs"),
      });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ logsStatus: "error", readError: this.readErrors("logs", message) });
    });
  };

  copyWorkbenchLog = (): string => {
    return this.ui.logs
      .map((entry) => [entry.at, entry.level, entry.area, entry.event, entry.code, entry.message].filter(Boolean).join(" "))
      .join("\n");
  };

  private lastLocalLog = "";

  private persistLocalLog(message: string): void {
    if (!message || message === this.lastLocalLog) return;
    this.lastLocalLog = message;
    const entry: WorkbenchLogEntry = {
      at: new Date().toISOString(),
      level: "error",
      area: "client",
      event: "request",
      message,
    };
    void this.api.product({ method: "log.record", level: "error", area: "client", event: "request", message }).then(
      (result) => {
        if (!this.running || result.method !== "logs") return;
        this.patch({ logs: result.entries, logsError: result.logError, logsStatus: "ready" });
      },
      () => {
        if (!this.running) return;
        this.patch({ logs: [...this.ui.logs, entry].slice(-400) });
      },
    );
  };

  loadTemplates = (): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ templatesStatus: "loading", readError: this.readErrors("templates") });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "templates" });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "templates") {
        throw wrongProduct("templates", result.method);
      }
      const templates = result.templates;
      const templateId = this.ui.templateId && templates.some((row) => row.id === this.ui.templateId)
        ? this.ui.templateId
        : templates[0]?.id ?? "";
      const workspaces = this.workspaceSpaces();
      const templateSpaceId =
        this.ui.templateSpaceId && workspaces.some((space) => space.id === this.ui.templateSpaceId)
          ? this.ui.templateSpaceId
          : workspaces[0]?.id ?? "";
      const shareSpaceId =
        this.ui.shareSpaceId && workspaces.some((space) => space.id === this.ui.shareSpaceId)
          ? this.ui.shareSpaceId
          : workspaces[0]?.id ?? "";
      this.patch({
        templates,
        templatesStatus: "ready",
        templateId,
        templateSpaceId,
        shareSpaceId,
        readError: this.readErrors("templates"),
      });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ templatesStatus: "error", readError: this.readErrors("templates", message) });
    });
  };

  setTemplateId = (templateId: string): void => this.patch({ templateId });
  setTemplateName = (templateName: string): void => this.patch({ templateName });
  setTemplateDisplayName = (templateDisplayName: string): void => this.patch({ templateDisplayName });
  setTemplateSpaceId = (templateSpaceId: string): void => this.patch({ templateSpaceId });
  setTemplateIncludeConfig = (templateIncludeConfig: boolean): void => this.patch({ templateIncludeConfig });
  setShareSpaceId = (shareSpaceId: string): void => this.patch({ shareSpaceId });
  setShareIncludeConfig = (shareIncludeConfig: boolean): void => this.patch({ shareIncludeConfig });
  setImportName = (importName: string): void => this.patch({ importName });
  setImportDisplayName = (importDisplayName: string): void => this.patch({ importDisplayName });

  saveTemplate = (): void => {
    const spaceId = this.ui.templateSpaceId;
    const name = this.ui.templateName.trim();
    if (!spaceId || !name) {
      this.patch({ commandError: this.msg("templates.needName") });
      return;
    }
    void this.submit({
      kind: "template.save",
      spaceId,
      name,
      includeConfig: this.ui.templateIncludeConfig,
    });
  };

  createFromTemplate = (): void => {
    const templateId = this.ui.templateId;
    const name = this.ui.templateName.trim().toLowerCase();
    if (!templateId || !NAME_RE.test(name)) {
      this.patch({ commandError: this.msg("app.nameInvalid") });
      return;
    }
    if (RESERVED.has(name)) {
      this.patch({ commandError: this.msg("app.nameReserved") });
      return;
    }
    void this.submit({
      kind: "template.create",
      templateId,
      name,
      displayName: this.ui.templateDisplayName.trim() || undefined,
    });
  };

  exportShare = (): void => {
    const spaceId = this.ui.shareSpaceId;
    if (!spaceId) {
      this.patch({ commandError: this.msg("share.needSpace") });
      return;
    }
    const cycle = this.cycle;
    void this.wrap(async () => {
      const result = await this.api.product({
        method: "share.export",
        spaceId,
        includeConfig: this.ui.shareIncludeConfig,
      });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "share.export") {
        throw wrongProduct("share.export", result.method);
      }
      this.env.downloadFile(result.fileName, result.archiveBase64);
    });
  };

  previewImportArchive = (archiveBase64: string, fileName: string): void => {
    if (archiveBase64.length > MAX_WORKBENCH_SHARE_BASE64) {
      this.patch({ commandError: this.msg("share.tooLarge"), importPreview: null });
      return;
    }
    const cycle = this.cycle;
    void this.wrap(async () => {
      const result = await this.api.product({ method: "share.previewImport", archiveBase64 });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "share.previewImport") {
        throw wrongProduct("share.previewImport", result.method);
      }
      this.patch({
        overlay: { type: "import" },
        importPreview: {
          importId: result.importId,
          expiresAt: result.expiresAt,
          preview: result.preview,
          observation: result.observation,
          fileName,
        },
        importName: "",
        importDisplayName: "",
        commandError: null,
      });
    });
  };

  confirmImport = (): void => {
    const preview = this.ui.importPreview;
    if (!preview) {
      this.patch({ commandError: this.msg("share.noPreview") });
      return;
    }
    const name = this.ui.importName.trim().toLowerCase();
    if (!NAME_RE.test(name)) {
      this.patch({ commandError: this.msg("app.nameInvalid") });
      return;
    }
    if (RESERVED.has(name)) {
      this.patch({ commandError: this.msg("app.nameReserved") });
      return;
    }
    const liveEpoch = this.ui.state?.serviceEpoch;
    if (!liveEpoch || liveEpoch !== preview.observation.serviceEpoch) {
      this.patch({ commandError: this.msg("share.epochChanged") });
      return;
    }
    const expires = Date.parse(preview.expiresAt);
    if (!Number.isFinite(expires) || this.env.now() >= expires) {
      this.patch({ commandError: this.msg("share.expired") });
      return;
    }
    const importId = preview.importId;
    this.patch({ overlay: null, importPreview: null });
    void this.submit(
      {
        kind: "space.import",
        importId,
        name,
        displayName: this.ui.importDisplayName.trim() || undefined,
      },
      preview.observation,
    );
  };

  copyDiagnostics = (): string => {
    const diag = this.ui.diagnostics;
    const lines = [
      diag?.lastError,
      ...(diag?.logs ?? []).map((entry) => `${entry.at} ${entry.channel} ${entry.text}`),
      diag?.logError,
    ].filter((line): line is string => Boolean(line));
    return lines.join("\n");
  };

  loadDetail = (spaceId: string): Promise<void> => {
    const cycle = this.cycle;
    const cleared = this.readErrors("detail");
    delete cleared.diagnostics;
    this.patch({ detailStatus: "loading", diagnosticsStatus: "loading", diagnostics: null, readError: cleared });
    return this.wrap(async () => {
      const [detailResult, backupsResult, diagResult] = await Promise.allSettled([
        this.api.detail(spaceId),
        this.api.backups(spaceId),
        this.api.product({ method: "diagnostics", spaceId }),
      ]);
      if (!this.stillOpen(cycle)) return;
      const backups = backupsResult.status === "fulfilled" && Array.isArray(backupsResult.value)
        ? backupsResult.value
        : [];
      let diagnostics: WorkbenchDiagnostics | null = null;
      let diagnosticsStatus: WorkbenchUiState["diagnosticsStatus"] = "error";
      let diagnosticsMessage: string | undefined;
      if (diagResult.status === "fulfilled" && diagResult.value.method === "diagnostics") {
        diagnostics = diagResult.value.diagnostics;
        diagnosticsStatus = "ready";
      } else if (diagResult.status === "rejected") {
        diagnosticsMessage = localizeError(this.ui.locale, errorCode(diagResult.reason));
      } else if (diagResult.status === "fulfilled") {
        diagnosticsMessage = localizeError(this.ui.locale, errorCode(wrongProduct("diagnostics", diagResult.value.method)));
      }
      const detailParts: string[] = [];
      if (detailResult.status !== "fulfilled") {
        detailParts.push(localizeError(this.ui.locale, errorCode(detailResult.reason)));
      }
      if (backupsResult.status === "rejected") {
        detailParts.push(localizeError(this.ui.locale, errorCode(backupsResult.reason)));
      }
      const readError = { ...this.ui.readError };
      delete readError.detail;
      delete readError.diagnostics;
      if (diagnosticsMessage) readError.diagnostics = diagnosticsMessage;
      if (detailParts.length > 0) readError.detail = detailParts.join("\n");
      this.patch({
        detail: detailResult.status === "fulfilled" ? detailResult.value : null,
        backups,
        diagnostics,
        diagnosticsStatus,
        detailStatus: detailResult.status === "fulfilled" ? "ready" : "error",
        readError,
      });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ detailStatus: "error", readError: this.readErrors("detail", message) });
    });
  };

  poll = async (): Promise<void> => {
    const cycle = this.cycle;
    const generation = ++this.stateGeneration;
    try {
      const state = await this.api.state();
      if (!this.stillOpen(cycle) || generation !== this.stateGeneration) return;
      this.applyState(state);
    } catch (error) {
      if (!this.stillOpen(cycle) || generation !== this.stateGeneration) return;
      this.patch({
        boot: this.ui.state || this.ui.frames.length > 0 ? "ready" : "error",
        error: localizeError(this.ui.locale, errorCode(error)),
      });
    } finally {
      if (this.running) this.schedulePoll();
    }
  };

  canMutate(): boolean {
    const state = this.ui.state;
    if (!state) return false;
    if (state.protocolVersion !== 2) return false;
    if (state.availability === "unavailable") return false;
    return state.writable === true;
  }

  isBusy(): boolean {
    return this.ui.commandPending || this.hasActiveJobs() || this.ui.state?.maintenance === true;
  }

  isManagerId(spaceId: string): boolean {
    const state = this.ui.state;
    if (!state) return false;
    if (state.managerId && state.managerId === spaceId) return true;
    return this.space(spaceId)?.isHost === true;
  }

  space(spaceId: string): WorkbenchSpace | undefined {
    return this.ui.state?.spaces.find((item) => item.id === spaceId);
  }

  workspaceSpaces(): WorkbenchSpace[] {
    return (this.ui.state?.spaces ?? []).filter((space) => !this.isManagerId(space.id));
  }

  private workspaceIds(): string[] {
    return this.workspaceSpaces().map((space) => space.id);
  }

  private applyState(state: WorkbenchState): void {
    const previousEpoch = this.ui.state?.serviceEpoch;
    const epochDestroyed = this.views.syncServiceEpoch(state.serviceEpoch);
    const destroyed = this.views.syncGenerations(state.spaces);
    for (const spaceId of [...epochDestroyed, ...destroyed]) {
      for (const key of [...this.iframeWindows.keys()]) {
        if (key.startsWith(`${spaceId}:`)) this.iframeWindows.delete(key);
      }
    }
    let selected = this.ui.selected;
    const noticeId = this.ui.createdNotice?.spaceId;
    const noticeRemoved = Boolean(noticeId && this.ui.state?.spaces.some(space => space.id === noticeId) &&
      !state.spaces.some(space => space.id === noticeId));
    const selectedWasRemoved = selected !== "home" && !state.spaces.some((space) => space.id === selected);
    if (selectedWasRemoved) {
      selected = "home";
      this.views.commitHome();
    }
    const pluginSpaceId =
      this.ui.pluginSpaceId && state.spaces.some((space) => space.id === this.ui.pluginSpaceId)
        ? this.ui.pluginSpaceId
        : this.workspaceSpacesFrom(state)[0]?.id ?? "";
    const templateSpaceId =
      this.ui.templateSpaceId && state.spaces.some((space) => space.id === this.ui.templateSpaceId)
        ? this.ui.templateSpaceId
        : pluginSpaceId;
    const shareSpaceId =
      this.ui.shareSpaceId && state.spaces.some((space) => space.id === this.ui.shareSpaceId)
        ? this.ui.shareSpaceId
        : pluginSpaceId;
    const protocolError =
      state.protocolVersion !== 2 ? localizeError(this.ui.locale, "workbench/unsupported") : this.ui.error;
    this.patch({
      boot: "ready",
      error: state.protocolVersion === 2 ? null : protocolError,
      state,
      selected,
      createdNotice: noticeId === selected || noticeRemoved ? null : this.ui.createdNotice,
      pluginSpaceId,
      templateSpaceId,
      shareSpaceId,
      frames: this.views.list(),
      visibleSpaceId: this.views.visibleSpaceId,
      viewError: this.views.viewError,
    });
    if (selectedWasRemoved) this.writePersist();
    if (previousEpoch && previousEpoch !== state.serviceEpoch) {
      this.blueprint.onServiceEpoch(state.serviceEpoch);
    }
    if (!this.primedProductJobs) {
      this.primedProductJobs = true;
      for (const item of state.jobs) {
        if (!ACTIVE_JOB.has(item.status)) this.handledProductJobs.add(item.id);
      }
    }
    for (const item of state.jobs) {
      this.noteCreated(item, true);
      this.onUpgradeJobUpdate(item);
      this.onProductJob(item);
    }
    const restoreId = this.restoreId;
    if (restoreId) {
      this.restoreId = null;
      const restore = state.spaces.find((item) => item.id === restoreId);
      if (restore?.status === "running") {
        this.beginSpace(restore, { startIfStopped: false, force: false });
      }
    }
    this.continuePending(state);
  }

  private workspaceSpacesFrom(state: WorkbenchState): WorkbenchSpace[] {
    return state.spaces.filter((space) => space.id !== state.managerId && !space.isHost);
  }

  private beginSpace(space: WorkbenchSpace, options: { startIfStopped: boolean; force: boolean }): void {
    if (space.status !== "running") {
      if (!options.startIfStopped) return;
      if (!space.managed) {
        this.patch({ commandError: this.msg("app.unmanaged") });
        return;
      }
      if (!this.canMutate()) {
        this.rejectReadonly();
        return;
      }
      const decision = options.force ? this.views.retry(space) : this.views.requestSpace(space);
      this.syncSelection();
      void this.submit({ kind: "space.start", spaceId: space.id });
      this.armWait(decision.token, this.env.startTimeoutMs, space.id, "start");
      return;
    }
    if (options.force) {
      for (const key of [...this.iframeWindows.keys()]) {
        if (key.startsWith(`${space.id}:`)) this.iframeWindows.delete(key);
      }
    }
    const decision = options.force ? this.views.retry(space) : this.views.requestSpace(space);
    if (decision.reuseReady) {
      this.views.commitPending(space.id, decision.token);
      this.syncSelection();
      return;
    }
    this.syncSelection();
    if (decision.load || options.force) void this.loadAuthorizedView(space.id, decision.token);
    this.armWait(decision.token, this.env.handshakeTimeoutMs, space.id, "handshake");
  }

  private continuePending(state: WorkbenchState): void {
    const pendingId = this.views.pendingSpaceId;
    if (!pendingId) return;
    const space = state.spaces.find((item) => item.id === pendingId);
    if (!space) {
      this.views.failView(pendingId, this.views.selectToken, "view-failed");
      this.syncSelection();
      return;
    }
    const frame = this.views.get(pendingId);
    if (space.status !== "running") return;
    if (!frame || frame.generation !== space.generation) {
      this.beginSpace(space, { startIfStopped: false, force: false });
      return;
    }
    if (frame.status === "loading" && frame.view === null) {
      void this.loadAuthorizedView(pendingId, frame.selectToken);
    }
  }

  private async loadAuthorizedView(spaceId: string, token: number): Promise<void> {
    const cycle = this.cycle;
    const requestKey = `${spaceId}:${token}`;
    if (this.pendingViewRequests.has(requestKey)) return;
    this.pendingViewRequests.add(requestKey);
    if (this.views.isCurrentToken(token)) this.armWait(token, this.env.handshakeTimeoutMs, spaceId, "handshake");
    try {
      const view: WorkbenchView = await this.api.view(spaceId);
      if (!this.stillOpen(cycle)) return;
      if (!this.views.isCurrentToken(token)) {
        this.views.applyView(spaceId, token, view);
        this.syncSelection();
        return;
      }
      this.views.applyView(spaceId, token, view);
      this.syncSelection();
    } catch {
      if (!this.stillOpen(cycle)) return;
      this.views.failView(spaceId, token, "view-failed");
      this.syncSelection();
    } finally {
      this.pendingViewRequests.delete(requestKey);
    }
  }

  private syncSelection(): void {
    const selected = this.views.committedSpaceId ?? "home";
    const changed = selected !== this.ui.selected;
    this.patch({
      selected,
      pendingId: this.views.pendingSpaceId,
      frames: this.views.list(),
      visibleSpaceId: this.views.visibleSpaceId,
      viewError: this.views.viewError,
      overlay: this.ui.overlay?.type === "menu" ? null : this.ui.overlay,
    });
    if (changed) this.writePersist();
  }

  private armWait(token: number, ms: number, spaceId: string, kind: "start" | "handshake"): void {
    this.clearWait();
    this.waitTimer = this.env.setTimeout(() => {
      if (!this.views.isCurrentToken(token)) return;
      if (this.views.pendingSpaceId !== spaceId) return;
      const frame = this.views.get(spaceId);
      if (kind === "handshake" && frame?.status === "ready") return;
      if (kind === "start") {
        const space = this.space(spaceId);
        if (space?.status === "running") return;
      }
      this.views.failView(spaceId, token, "timeout");
      this.patch({ commandError: this.msg("app.handshakeTimeout") });
      this.syncSelection();
    }, ms);
  }

  private clearWait(): void {
    if (this.waitTimer !== null) this.env.clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }

  private mutationContext(): WorkbenchMutationContext | null {
    const state = this.ui.state;
    if (!state || state.protocolVersion !== 2) return null;
    if (!state.serviceEpoch || !state.revision) return null;
    return { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision };
  }

  private async runPreview(request: WorkbenchPlanRequest): Promise<void> {
    const context = this.mutationContext();
    if (!context) {
      this.patch({
        pendingPlan: null,
        planError: localizeError(this.ui.locale, "workbench/unsupported"),
        commandPending: false,
      });
      return;
    }
    const cycle = this.cycle;
    this.patch({ planError: null, pendingPlan: null, commandPending: true });
    try {
      const plan = await this.api.preview(request, context);
      if (!this.stillOpen(cycle)) return;
      this.patch({ pendingPlan: { request, plan }, planError: null, commandPending: false, overlay: null });
    } catch (error) {
      if (!this.stillOpen(cycle)) return;
      this.patch({
        pendingPlan: null,
        planError: localizeError(this.ui.locale, errorCode(error)),
        commandPending: false,
      });
    }
  }

  private async submitBlueprintApply(
    planId: string,
    observation: WorkbenchProductObservation,
  ): Promise<void> {
    if (!this.canMutate()) {
      this.rejectReadonly();
      throw Object.assign(new Error("workbench/read-only"), { code: "workbench/read-only" });
    }
    const command: WorkbenchCommand = { kind: "blueprint.apply", planId };
    const key = intentKey(command);
    if (this.intentInflight.has(key)) return;
    const requestId = this.intentRequestIds.get(key) ?? this.env.uuid();
    this.intentRequestIds.set(key, requestId);
    this.intentInflight.add(key);
    const cycle = this.cycle;
    try {
      const job = await this.api.submit(command, requestId, observation);
      if (!this.stillOpen(cycle)) return;
      this.mergeJob(job);
      this.noteCreated(job);
      this.onProductJob(job);
      if (!ACTIVE_JOB.has(job.status)) this.intentRequestIds.delete(key);
      await this.poll();
    } catch (error) {
      if (!this.stillOpen(cycle)) return;
      this.patch({ commandError: localizeError(this.ui.locale, errorCode(error)) });
      throw error;
    } finally {
      this.intentInflight.delete(key);
    }
  }

  private async submit(command: WorkbenchCommand, contextOverride?: WorkbenchMutationContext): Promise<void> {
    if (!this.canMutate()) {
      this.rejectReadonly();
      return;
    }
    const context = contextOverride ?? this.mutationContext();
    if (!context) {
      this.patch({ commandError: localizeError(this.ui.locale, "workbench/unsupported") });
      return;
    }
    const key = intentKey(command);
    if (this.intentInflight.has(key)) return;
    const requestId = this.intentRequestIds.get(key) ?? this.env.uuid();
    this.intentRequestIds.set(key, requestId);
    this.intentInflight.add(key);
    const cycle = this.cycle;
    try {
      await this.wrap(async () => {
        const job = await this.api.submit(command, requestId, context);
        if (!this.stillOpen(cycle)) return;
        if (command.kind === "plan.execute" && command.planId === this.awaitingPackagePlanId) {
          this.awaitingPackageJobId = job.id;
        }
        this.mergeJob(job);
        this.noteCreated(job);
        this.onProductJob(job);
        if (!ACTIVE_JOB.has(job.status)) this.intentRequestIds.delete(key);
        await this.poll();
      });
    } finally {
      this.intentInflight.delete(key);
    }
  }

  private mergeJob(job: WorkbenchJob): void {
    const state = this.ui.state;
    if (!state) return;
    const jobs = state.jobs.filter((item) => item.id !== job.id);
    jobs.unshift(job);
    this.patch({ state: { ...state, jobs } });
    this.noteCreated(job);
    this.onUpgradeJobUpdate(job);
    this.onProductJob(job);
  }

  private onProductJob(job: WorkbenchJob): void {
    if (job.kind === "blueprint.apply") this.blueprint.onApplyJob(job);
    if (ACTIVE_JOB.has(job.status)) return;
    for (const [key, requestId] of [...this.intentRequestIds.entries()]) {
      if (requestId === job.requestId) this.intentRequestIds.delete(key);
    }
    if (this.handledProductJobs.has(job.id)) return;
    this.handledProductJobs.add(job.id);
    const product = job.result?.product;
    if (product) this.patch({ lastProductOutcome: product });
    if (job.status === "succeeded" && product?.kind === "settings.update") {
      const draft = this.ui.settingsDraft;
      const submitted = this.submittedSettingsJson;
      this.submittedSettingsJson = null;
      const newerEdit = Boolean(draft && submitted && JSON.stringify(draft.settings) !== submitted);
      if (draft && !newerEdit) {
        this.patch({
          settingsDraft: {
            settings: product.settings,
            observation: draft.observation,
            dirty: false,
          },
          settingsStatus: "idle",
        });
        void this.loadSettings();
      }
    } else if (job.status === "succeeded") {
      if (job.kind === "catalog.refresh" || product?.kind === "catalog.refresh") {
        this.patch({ catalogStatus: "idle" });
        if (this.ui.homeTab === "plugins") void this.loadCatalog(this.ui.pluginQuery);
      }
      if (
        job.kind === "plugin.download" ||
        job.kind === "plugin.library.remove" ||
        product?.kind === "plugin.download" ||
        product?.kind === "plugin.library.remove"
      ) {
        this.patch({ libraryStatus: "idle" });
        if (this.ui.homeTab === "plugins") void this.loadLibrary();
      }
      if (
        job.kind === "template.save" ||
        job.kind === "template.create" ||
        job.kind === "space.import" ||
        product?.kind === "template.save" ||
        product?.kind === "template.create" ||
        product?.kind === "space.import"
      ) {
        this.patch({ templatesStatus: "idle" });
        if (this.ui.homeTab === "templates") void this.loadTemplates();
      }
      if (job.kind === "workbench.prepare" || product?.kind === "workbench.prepare") {
        this.applyPreparedWorkbenchPackage();
      }
    } else if (job.status === "failed" && (job.kind === "workbench.prepare" || product?.kind === "workbench.prepare")) {
      this.prepareEpoch = null;
      this.patch({
        commandError: job.error?.message || localizeError(this.ui.locale, job.error ?? { code: "workbench/failed" }),
      });
    }
  }

  private applyPreparedWorkbenchPackage(): void {
    if (this.prepareEpoch && this.ui.state?.serviceEpoch !== this.prepareEpoch) return;
    this.prepareEpoch = null;
    this.patch({ workbenchPackageStatus: "idle" });
    if (this.ui.homeTab === "runtime") void this.loadWorkbenchPackage();
  }

  private noteCreated(job: WorkbenchJob, fromSnapshot = false): void {
    const spaceId = job.result?.spaceId ?? importSpaceId(job.result?.product);
    if ((job.kind !== "space.create" && job.kind !== "template.create" && job.kind !== "space.import") || job.status !== "succeeded" || !spaceId) return;
    if (fromSnapshot && !this.ui.state?.spaces.some(space => space.id === spaceId)) return;
    if (this.notedCreates.has(spaceId)) return;
    this.notedCreates.add(spaceId);
    this.patch({ createdNotice: { spaceId } });
  }

  hasActiveJobs(): boolean {
    return (this.ui.state?.jobs ?? []).some((job) => ACTIVE_JOB.has(job.status));
  }

  private schedulePoll(): void {
    if (!this.running) return;
    if (this.pollTimer !== null) this.env.clearTimeout(this.pollTimer);
    const active = (this.ui.state?.jobs ?? []).some((job) => ACTIVE_JOB.has(job.status));
    const delay = pollDelayMs(active, this.env.hidden());
    this.pollTimer = this.env.setTimeout(() => {
      void this.poll();
    }, delay);
  }

  private readErrors(surface: WorkbenchReadSurface, message?: string): WorkbenchUiState["readError"] {
    const next = { ...this.ui.readError };
    if (message) next[surface] = message;
    else delete next[surface];
    return next;
  }

  private async wrap(action: () => Promise<void>, onError?: (message: string) => void): Promise<void> {
    const cycle = this.cycle;
    if (!this.stillOpen(cycle)) return;
    this.wrapDepth += 1;
    this.patch({ commandPending: true, commandError: this.wrapDepth === 1 ? null : this.ui.commandError });
    try {
      await action();
      if (!this.stillOpen(cycle)) return;
      this.patch({ commandPending: this.wrapDepth - 1 > 0 });
    } catch (error) {
      if (!this.stillOpen(cycle)) return;
      const message = localizeError(this.ui.locale, errorCode(error));
      onError?.(message);
      const local = localLogMessage(error);
      if (local) this.persistLocalLog(local);
      this.patch({
        commandPending: this.wrapDepth - 1 > 0,
        commandError: onError ? this.ui.commandError : message,
      });
    } finally {
      this.wrapDepth = Math.max(0, this.wrapDepth - 1);
    }
  }

  private rejectReadonly(): void {
    const state = this.ui.state;
    const code = state && state.protocolVersion !== 2 ? "workbench/unsupported" : "workbench/read-only";
    this.patch({ commandError: localizeError(this.ui.locale, code), pendingPlan: null });
  }

  private applyClientDefaults(defaults: { locale: LocalePreference; theme: ThemePreference }): void {
    if (this.appliedClientDefaults || !this.persistEmpty) return;
    this.appliedClientDefaults = true;
    this.patch({
      locale: mapLocale(defaults.locale),
      theme: defaults.theme,
    });
    this.writePersist();
  }

  private previewWorkbenchUpgrade(): void {
    if (this.ui.state?.maintenance || this.hasActiveJobs()) {
      this.patch({
        planError: localizeError(this.ui.locale, "workbench/locked"),
        pendingPlan: null,
      });
      return;
    }
    const pkg = this.ui.workbenchPackage;
    if (!pkg || pkg.id !== "bundled-workbench" || !pkg.updateAvailable) return;
    void this.runPreview({
      kind: "workbench.upgrade",
      catalogId: "bundled-workbench",
      version: pkg.version,
    });
  }

  private onUpgradeJobUpdate(job: WorkbenchJob): void {
    if (!this.awaitingPackageJobId || job.id !== this.awaitingPackageJobId) return;
    if (ACTIVE_JOB.has(job.status)) return;
    if ((this.ui.state?.jobs ?? []).some((item) => ACTIVE_JOB.has(item.status))) return;
    if (job.status === "succeeded" && job.phase === "handoff-pending") return;
    this.awaitingPackagePlanId = null;
    this.awaitingPackageJobId = null;
    this.patch({ workbenchPackageStatus: "idle" });
    if (this.ui.homeTab === "runtime") void this.loadWorkbenchPackage();
  }

  private touchesManagerPlugins(request: WorkbenchPlanRequest): boolean {
    if (request.kind === "plugin.install") {
      return request.spaceIds.some((id) => this.isManagerId(id));
    }
    if (request.kind === "plugin.toggle") return this.isManagerId(request.spaceId);
    return false;
  }

  private msg(key: WorkbenchMessageKey): string {
    return t(this.ui.locale, key);
  }

  private writePersist(): void {
    this.persistEmpty = false;
    writePersist(this.env.storage, {
      selectedId: this.ui.selected === "home" ? homeSelectionId() : this.ui.selected,
      locale: this.ui.locale,
      theme: this.ui.theme,
    });
  }

  private patch(partial: Partial<WorkbenchUiState>): void {
    this.ui = { ...this.ui, ...partial, blueprint: this.blueprint.getSnapshot() };
    for (const listener of this.listeners) listener();
  }
}

function importSpaceId(product: WorkbenchProductOutcome | undefined): string | undefined {
  if (!product) return undefined;
  if (product.kind === "template.create" || product.kind === "space.import") {
    return product.import.spaceId;
  }
  return undefined;
}

export type { SpaceImportResult };
