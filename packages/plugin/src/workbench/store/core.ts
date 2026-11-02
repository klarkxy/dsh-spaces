/**
 * The shared base of the workbench client.
 *
 * The controller was one class of 1,957 lines. It is now a chain: this base
 * owns the state, the environment and the helpers every part needs, and it
 * declares the surface the parts implement. The parts themselves live in
 * `./parts/`.
 *
 * Nothing here changes the behaviour of the client. The state, the
 * constructor and the helpers move unchanged; only the visibility of the
 * members that more than one part touches widens from `private` to
 * `protected`, which is a compile-time marker only.
 */

import type { LocalePreference, ThemePreference } from "../../../../../src/shared/types";
import type {
  WorkbenchApi,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchSpace,
  WorkbenchState,
} from "../../../../../src/shared/workbench";
import type { WorkbenchHomeSettings, WorkbenchProductObservation } from "../../../../../src/shared/workbench-product";
import { localizeError, t, type WorkbenchLocale, type WorkbenchMessageKey } from "../i18n";
import type { LlmUiClient, LlmUiSpace } from "../llm/client";
import { isHomeSelection, persistWasEmpty, readPersist } from "../persistence";
import { ViewSession, type ViewFrameState, type ViewMessageEvent } from "../view-session";
import { BlueprintSession } from "../blueprint-session";
import { errorCode, localLogMessage } from "./errors";
import { createDefaultEnv } from "./env";
import type {
  HomeTab,
  SubmitOptions,
  WorkbenchEnv,
  WorkbenchReadSurface,
  WorkbenchUiState,
} from "./types";

export abstract class WorkbenchCore {
  readonly views = new ViewSession();
  readonly blueprint: BlueprintSession;
  protected readonly pendingViewRequests = new Set<string>();
  protected readonly env: WorkbenchEnv;
  protected readonly iframeWindows = new Map<string, unknown>();
  protected readonly listeners = new Set<() => void>();
  protected readonly intentRequestIds = new Map<string, string>();
  protected readonly intentInflight = new Set<string>();
  protected pollTimer: unknown = null;
  protected waitTimer: unknown = null;
  protected unsubVisibility: (() => void) | null = null;
  protected unsubMessages: (() => void) | null = null;
  protected running = false;
  protected shutdownRequested = false;
  protected stateGeneration = 0;
  protected stateObservation = 0;
  // User navigation is independent of view tokens advanced by startup observations.
  protected navigationIntent = 0;
  protected cycle = 0;
  protected wrapDepth = 0;
  protected requestSurface = 0;
  protected handledProductJobs = new Set<string>();
  protected watchedCreates = new Set<string>();
  protected primedProductJobs = false;
  /** Set only by the current poll generation's own rejection. Late failures cannot set it. */
  protected stateReadFailed = false;
  protected submittedSettingsJson: string | null = null;
  protected restoreId: string | null;
  protected notedCreates = new Set<string>();
  /** Creates this client submitted, keyed by request id. */
  protected submittedCreates = new Map<string, { spaceId: string; intent: number }>();
  /** A finished create that still waits for its space to appear in the state. */
  protected pendingAutoEnter: { spaceId: string; intent: number } | null = null;
  protected persistEmpty: boolean;
  protected appliedClientDefaults = false;
  protected ui: WorkbenchUiState;

  constructor(
    protected readonly api: WorkbenchApi,
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
      requestOrigin: null,
      commandPending: false,
      readError: {},
      homeTab: "overview",
      settingsTab: "general",
      detailSpaceId: null,
      maintenanceExpanded: false,
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
      pluginVersions: {},
      catalog: null,
      catalogStatus: "idle",
      library: [],
      libraryStatus: "idle",
      snapshots: [],
      snapshotsStatus: "idle",
      runtimes: [],
      runtimesStatus: "idle",
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
    this.unsubVisibility = this.env.onVisibilityChange(() => {
      if (!this.stateReadFailed) this.schedulePoll();
    });
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

  protected stillOpen(cycle: number): boolean {
    return cycle === this.cycle;
  }

  protected patch(partial: Partial<WorkbenchUiState>): void {
    this.ui = { ...this.ui, ...partial, blueprint: this.blueprint.getSnapshot() };
    for (const listener of this.listeners) listener();
  }

  protected msg(key: WorkbenchMessageKey): string {
    return t(this.ui.locale, key);
  }

  protected readErrors(surface: WorkbenchReadSurface, message?: string): WorkbenchUiState["readError"] {
    const next = { ...this.ui.readError };
    if (message) next[surface] = message;
    else delete next[surface];
    return next;
  }

  protected clearRequestError(): void {
    ++this.requestSurface;
    this.patch({ commandError: null, requestOrigin: null });
  }

  protected rejectReadonly(): void {
    const state = this.ui.state;
    const code = state && state.protocolVersion !== 2 ? "workbench/unsupported" : "workbench/read-only";
    this.patch({ commandError: localizeError(this.ui.locale, code), pendingPlan: null, requestOrigin: null });
  }

  protected async wrap(action: () => Promise<void>, onError?: (message: string) => void): Promise<void> {
    const cycle = this.cycle;
    const requestSurface = this.requestSurface;
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
        commandError: onError || requestSurface !== this.requestSurface ? this.ui.commandError : message,
      });
    } finally {
      this.wrapDepth = Math.max(0, this.wrapDepth - 1);
    }
  }

  // ---------------------------------------------------------------------------
  // The surface the parts implement. Every member below is declared here so
  // that a part can call a member that another part owns; the implementation
  // stays with the part that owns the concern.
  // ---------------------------------------------------------------------------

  abstract setLocale: (locale: WorkbenchLocale) => void;

  abstract setTheme: (theme: ThemePreference) => void;

  abstract setHomeTab: (homeTab: HomeTab) => void;

  abstract toggleMaintenance: () => void;

  abstract blueprintSourceSpaces: () => WorkbenchSpace[];

  abstract openBlueprintGenerate: (spaceId: string) => void;

  abstract openBlueprintUse: () => void;

  abstract selectHome: () => void;

  abstract selectSpace: (spaceId: string) => void;

  abstract selectRunningSpace: (spaceId: string, isCurrent?: () => boolean, targetGeneration?: number) => Promise<boolean>;

  abstract enterCreated: () => void;

  abstract registerIframeWindow: (spaceId: string, generation: number, win: unknown) => void;

  abstract isRegisteredViewSource: (event: ViewMessageEvent, frame: ViewFrameState) => boolean;

  abstract handleMessage: (event: ViewMessageEvent) => void;

  abstract openIndependent: (spaceId: string) => void;

  abstract openCreate: () => void;

  abstract openRename: (spaceId: string) => void;

  abstract openIcon: (spaceId: string) => void;

  abstract openSettings: () => void;

  abstract setSettingsTab: (settingsTab: WorkbenchUiState["settingsTab"]) => void;

  abstract llmClient: () => LlmUiClient;

  abstract llmSpaces: () => LlmUiSpace[];

  abstract openDetail: (spaceId: string) => void;

  abstract closeDetail: () => void;

  abstract openMenu: (spaceId: string, x: number, y: number) => void;

  abstract closeOverlay: () => void;

  abstract closePlan: () => void;

  abstract closeImport: () => void;

  abstract reportFailure: (error: unknown) => void;

  baseVersions = async (base: 'web' | 'browser') => {
    const result = await this.api.product({ method: 'base.versions', base });
    if (result.method !== 'base.versions' || result.base !== base) throw new Error('Unexpected base version response.');
    return result;
  };

  abstract createSpace: (input: { name: string; displayName?: string; icon?: string; useSharedLlm?: boolean; modelSource?: 'main'|'shared'|'local'; browser?: boolean; base?: 'web'|'browser'; baseVersion?: string }) => void;

  abstract updateSpace: (spaceId: string, patch: { displayName?: string; icon?: string }) => void;

  abstract moveSpace: (spaceId: string, direction: -1 | 1) => void;

  abstract startSpace: (spaceId: string) => void;

  abstract preview: (request: WorkbenchPlanRequest) => void;

  abstract confirmPlan: () => void;

  abstract cancelJob: (id: string) => void;

  abstract setPluginQuery: (pluginQuery: string) => void;

  abstract setPluginSpace: (pluginSpaceId: string) => void;

  abstract setPluginCatalog: (pluginCatalogId: string, pluginVersion?: string) => void;

  abstract setPluginVersion: (pluginVersion: string) => void;

  abstract setPluginSpec: (pluginSpec: string) => void;

  abstract loadPluginVersions: (catalogId: string, force?: boolean) => Promise<void>;

  abstract searchPlugins: (query: string) => Promise<void>;

  abstract loadCatalog: (query?: string) => Promise<void>;

  abstract loadLibrary: () => Promise<void>;

  abstract refreshCatalog: () => void;

  abstract downloadPlugin: () => void;

  abstract removeLibraryItem: (libraryId: string) => void;

  abstract previewInstallSelected: (spaceId?: string) => void;

  abstract loadSnapshots: () => Promise<void>;

  abstract loadRuntimes: () => Promise<void>;

  abstract loadSettings: () => Promise<void>;

  abstract setHomeSettings: (patch: Partial<WorkbenchHomeSettings>) => void;

  abstract saveHomeSettings: () => void;

  abstract loadLogs: () => Promise<void>;

  abstract copyWorkbenchLog: () => string;

  abstract loadTemplates: () => Promise<void>;

  abstract setTemplateId: (templateId: string) => void;

  abstract setTemplateName: (templateName: string) => void;

  abstract setTemplateDisplayName: (templateDisplayName: string) => void;

  abstract setTemplateSpaceId: (templateSpaceId: string) => void;

  abstract setTemplateIncludeConfig: (templateIncludeConfig: boolean) => void;

  abstract setShareSpaceId: (shareSpaceId: string) => void;

  abstract setShareIncludeConfig: (shareIncludeConfig: boolean) => void;

  abstract setImportName: (importName: string) => void;

  abstract setImportDisplayName: (importDisplayName: string) => void;

  abstract saveTemplate: () => void;

  abstract createFromTemplate: () => void;

  abstract exportShare: () => void;

  abstract previewImportArchive: (archiveBase64: string, fileName: string) => void;

  abstract confirmImport: () => void;

  abstract copyDiagnostics: () => string;

  abstract loadDetail: (spaceId: string) => Promise<void>;

  abstract poll: () => Promise<void>;

  abstract canMutate(): boolean;

  abstract isBusy(): boolean;

  abstract isManagerId(spaceId: string): boolean;

  abstract space(spaceId: string): WorkbenchSpace | undefined;

  abstract workspaceSpaces(): WorkbenchSpace[];

  abstract hasActiveJobs(): boolean;

  // Members that more than one part calls.

  protected abstract applyState(state: WorkbenchState): void;

  protected abstract workspaceIds(): string[];

  protected abstract workspaceSpacesFrom(state: WorkbenchState): WorkbenchSpace[];

  protected abstract beginSpace(space: WorkbenchSpace, startIfStopped: boolean): void;

  protected abstract continuePending(state: WorkbenchState): void;

  protected abstract clearWait(): void;


  protected abstract updateOrigin(spaceId: string): string | null;

  protected abstract submitBlueprintApply(planId: string, observation: WorkbenchProductObservation): Promise<void>;

  protected abstract submit(command: WorkbenchCommand, options?: SubmitOptions): Promise<void>;

  protected abstract mergeJob(job: WorkbenchJob): void;

  protected abstract onProductJob(job: WorkbenchJob): void;

  protected abstract noteCreated(job: WorkbenchJob, historical?: boolean): void;

  protected abstract flushAutoEnter(state: WorkbenchState): void;

  protected abstract schedulePoll(): void;

  protected abstract loadSpacePluginVersions(plugins: WorkbenchPlugin[]): void;

  protected abstract persistLocalLog(message: string): void;

  protected abstract writePersist(): void;

  protected abstract applyClientDefaults(defaults: { locale: LocalePreference; theme: ThemePreference }): void;
}
