import type { SpaceDetail } from "../../../../src/shared/spaces-control";
import type {
  WorkbenchApi,
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
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
import { validateWorkbenchIcon } from "./icons";
import { localizeError, t, type WorkbenchLocale, type WorkbenchMessageKey } from "./i18n";
import {
  defaultStorage,
  homeSelectionId,
  isHomeSelection,
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

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const RESERVED = new Set(["web", "hub", "headless", "node_modules", "spaces-hub"]);
const ACTIVE_JOB = new Set(["queued", "running"]);

export type HomeTab = "overview" | "spaces" | "plugins" | "snapshots" | "runtime";

export type OverlayKind =
  | { type: "create" }
  | { type: "rename"; spaceId: string }
  | { type: "icon"; spaceId: string }
  | { type: "detail"; spaceId: string }
  | { type: "settings" }
  | { type: "menu"; spaceId: string; x: number; y: number }
  | null;

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
  addMessageListener(listener: (event: ViewMessageEvent) => void): () => void;
}

export interface WorkbenchUiState {
  locale: WorkbenchLocale;
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
  homeTab: HomeTab;
  detail: SpaceDetail | null;
  detailStatus: "idle" | "loading" | "ready" | "error";
  backups: WorkbenchBackup[];
  plugins: WorkbenchPlugin[];
  pluginQuery: string;
  pluginSpaceId: string;
  pluginCatalogId: string;
  pluginVersion: string;
  pluginsStatus: "idle" | "loading" | "ready" | "error";
  snapshots: WorkbenchSnapshot[];
  snapshotsStatus: "idle" | "loading" | "ready" | "error";
  runtimes: WorkbenchRuntime[];
  runtimesStatus: "idle" | "loading" | "ready" | "error";
  workbenchPackage: WorkbenchPackageRelease | null;
  workbenchPackageStatus: "idle" | "loading" | "ready" | "error";
}

function defaultOpenUrl(url: string): void {
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
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
    addMessageListener: (listener) => {
      if (typeof window === "undefined") return () => undefined;
      const wrapped = (event: MessageEvent) => listener(event);
      window.addEventListener("message", wrapped);
      return () => window.removeEventListener("message", wrapped);
    },
  };
}

export function pollDelayMs(activeJobs: boolean, hidden: boolean): number {
  if (hidden) return activeJobs ? 2000 : 4000;
  return activeJobs ? 500 : 1000;
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

export class WorkbenchController {
  readonly views = new ViewSession();
  private readonly pendingViewRequests = new Set<string>();
  private readonly env: WorkbenchEnv;
  private readonly iframeWindows = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();
  private pollTimer: unknown = null;
  private waitTimer: unknown = null;
  private unsubVisibility: (() => void) | null = null;
  private unsubMessages: (() => void) | null = null;
  private running = false;
  private stateGeneration = 0;
  private restoreId: string | null;
  private notedCreates = new Set<string>();
  private awaitingPackagePlanId: string | null = null;
  private awaitingPackageJobId: string | null = null;
  private ui: WorkbenchUiState;

  constructor(
    private readonly api: WorkbenchApi,
    env?: Partial<WorkbenchEnv>,
  ) {
    this.env = { ...createDefaultEnv(), ...env };
    const persist = readPersist(this.env.storage);
    this.restoreId = isHomeSelection(persist.selectedId) ? null : persist.selectedId;
    this.ui = {
      locale: persist.locale,
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
      homeTab: "overview",
      detail: null,
      detailStatus: "idle",
      backups: [],
      plugins: [],
      pluginQuery: "",
      pluginSpaceId: "",
      pluginCatalogId: "",
      pluginVersion: "",
      pluginsStatus: "idle",
      snapshots: [],
      snapshotsStatus: "idle",
      runtimes: [],
      runtimesStatus: "idle",
      workbenchPackage: null,
      workbenchPackageStatus: "idle",
    };
  }

  getSnapshot = (): WorkbenchUiState => this.ui;

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

  stop(): void {
    this.running = false;
    if (this.pollTimer !== null) this.env.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.clearWait();
    this.unsubVisibility?.();
    this.unsubMessages?.();
    this.unsubVisibility = null;
    this.unsubMessages = null;
  }

  setLocale = (locale: WorkbenchLocale): void => {
    this.patch({ locale });
    this.writePersist();
  };

  setHomeTab = (homeTab: HomeTab): void => {
    this.patch({ homeTab });
    if (homeTab === "plugins" && this.ui.pluginsStatus === "idle") void this.searchPlugins("");
    if (homeTab === "snapshots" && this.ui.snapshotsStatus === "idle") void this.loadSnapshots();
    if (homeTab === "runtime" && this.ui.runtimesStatus === "idle") void this.loadRuntimes();
    if (homeTab === "runtime" && this.ui.workbenchPackageStatus === "idle") void this.loadWorkbenchPackage();
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
    void this.wrap(async () => {
      const view = await this.api.view(spaceId);
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

  openSettings = (): void => this.patch({ overlay: { type: "settings" } });

  openDetail = (spaceId: string): void => {
    this.patch({ overlay: { type: "detail", spaceId } });
    void this.loadDetail(spaceId);
  };

  openMenu = (spaceId: string, x: number, y: number): void => {
    this.patch({ overlay: { type: "menu", spaceId, x, y } });
  };

  closeOverlay = (): void => this.patch({ overlay: null, planError: null });

  closePlan = (): void => this.patch({ pendingPlan: null, planError: null });

  createSpace = (input: { name: string; displayName?: string; icon?: string }): void => {
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
      input: { name, displayName: input.displayName?.trim() || undefined, icon: icon.icon || undefined },
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
    void this.wrap(async () => {
      const next = await this.api.cancel(id);
      this.mergeJob(next);
    });
  };

  acquire = (): void => {
    void this.submit({ kind: "controller.acquire" });
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

  searchPlugins = (query: string): Promise<void> => {
    this.patch({ pluginQuery: query, pluginsStatus: "loading" });
    return this.wrap(async () => {
      const plugins = await this.api.plugins(query);
      this.patch({ plugins: Array.isArray(plugins) ? plugins : [], pluginsStatus: "ready" });
    }, () => this.patch({ pluginsStatus: "error" }));
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
    this.patch({ snapshotsStatus: "loading" });
    return this.wrap(async () => {
      const snapshots = await this.api.snapshots();
      this.patch({ snapshots: Array.isArray(snapshots) ? snapshots : [], snapshotsStatus: "ready" });
    }, () => this.patch({ snapshotsStatus: "error" }));
  };

  loadRuntimes = (): Promise<void> => {
    this.patch({ runtimesStatus: "loading" });
    return this.wrap(async () => {
      const runtimes = await this.api.runtimes();
      this.patch({ runtimes: Array.isArray(runtimes) ? runtimes : [], runtimesStatus: "ready" });
    }, () => this.patch({ runtimesStatus: "error" }));
  };

  loadWorkbenchPackage = (): Promise<void> => {
    const loader = this.api.workbenchPackage;
    if (typeof loader !== "function") {
      this.patch({ workbenchPackage: null, workbenchPackageStatus: "ready" });
      return Promise.resolve();
    }
    this.patch({ workbenchPackageStatus: "loading" });
    return this.wrap(async () => {
      const release = await loader();
      this.patch({
        workbenchPackage: release?.id === "bundled-workbench" ? release : null,
        workbenchPackageStatus: "ready",
      });
    }, () => this.patch({ workbenchPackage: null, workbenchPackageStatus: "error" }));
  };

  loadDetail = (spaceId: string): Promise<void> => {
    this.patch({ detailStatus: "loading" });
    return this.wrap(async () => {
      const [detail, backups] = await Promise.all([this.api.detail(spaceId), this.api.backups(spaceId)]);
      this.patch({
        detail,
        backups: Array.isArray(backups) ? backups : [],
        detailStatus: "ready",
      });
    }, () => this.patch({ detailStatus: "error" }));
  };

  poll = async (): Promise<void> => {
    const generation = ++this.stateGeneration;
    try {
      const state = await this.api.state();
      if (generation !== this.stateGeneration) return;
      this.applyState(state);
    } catch (error) {
      if (generation !== this.stateGeneration) return;
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
    const destroyed = this.views.syncGenerations(state.spaces);
    for (const spaceId of destroyed) {
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
    this.patch({
      boot: "ready",
      error: null,
      state,
      selected,
      createdNotice: noticeId === selected || noticeRemoved ? null : this.ui.createdNotice,
      pluginSpaceId,
      frames: this.views.list(),
      visibleSpaceId: this.views.visibleSpaceId,
      viewError: this.views.viewError,
    });
    if (selectedWasRemoved) this.writePersist();
    for (const item of state.jobs) {
      this.noteCreated(item, true);
      this.onUpgradeJobUpdate(item);
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
    const requestKey = `${spaceId}:${token}`;
    if (this.pendingViewRequests.has(requestKey)) return;
    this.pendingViewRequests.add(requestKey);
    if (this.views.isCurrentToken(token)) this.armWait(token, this.env.handshakeTimeoutMs, spaceId, "handshake");
    try {
      const view: WorkbenchView = await this.api.view(spaceId);
      if (!this.views.isCurrentToken(token)) {
        this.views.applyView(spaceId, token, view);
        this.syncSelection();
        return;
      }
      this.views.applyView(spaceId, token, view);
      this.syncSelection();
    } catch {
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

  private async runPreview(request: WorkbenchPlanRequest): Promise<void> {
    this.patch({ planError: null, pendingPlan: null, commandPending: true });
    try {
      const plan = await this.api.preview(request);
      this.patch({ pendingPlan: { request, plan }, planError: null, commandPending: false, overlay: null });
    } catch (error) {
      this.patch({
        pendingPlan: null,
        planError: localizeError(this.ui.locale, errorCode(error)),
        commandPending: false,
      });
    }
  }

  private async submit(command: WorkbenchCommand): Promise<void> {
    if (command.kind !== "controller.acquire" && !this.canMutate()) {
      this.rejectReadonly();
      return;
    }
    const requestId = this.env.uuid();
    await this.wrap(async () => {
      const job = await this.api.submit(command, requestId);
      if (command.kind === "plan.execute" && command.planId === this.awaitingPackagePlanId) {
        this.awaitingPackageJobId = job.id;
      }
      this.mergeJob(job);
      this.noteCreated(job);
      await this.poll();
    });
  }

  private mergeJob(job: WorkbenchJob): void {
    const state = this.ui.state;
    if (!state) return;
    const jobs = state.jobs.filter((item) => item.id !== job.id);
    jobs.unshift(job);
    this.patch({ state: { ...state, jobs } });
    this.noteCreated(job);
    this.onUpgradeJobUpdate(job);
  }

  private noteCreated(job: WorkbenchJob, fromSnapshot = false): void {
    if (job.kind !== "space.create" || job.status !== "succeeded" || !job.result?.spaceId) return;
    if (fromSnapshot && !this.ui.state?.spaces.some(space => space.id === job.result?.spaceId)) return;
    if (this.notedCreates.has(job.result.spaceId)) return;
    this.notedCreates.add(job.result.spaceId);
    this.patch({ createdNotice: { spaceId: job.result.spaceId } });
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

  private async wrap(action: () => Promise<void>, onError?: () => void): Promise<void> {
    this.patch({ commandPending: true, commandError: null });
    try {
      await action();
      this.patch({ commandPending: false });
    } catch (error) {
      onError?.();
      this.patch({
        commandPending: false,
        commandError: localizeError(this.ui.locale, errorCode(error)),
      });
    }
  }

  private rejectReadonly(): void {
    this.patch({ commandError: localizeError(this.ui.locale, "workbench/read-only"), pendingPlan: null });
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
    writePersist(this.env.storage, {
      selectedId: this.ui.selected === "home" ? homeSelectionId() : this.ui.selected,
      locale: this.ui.locale,
    });
  }

  private patch(partial: Partial<WorkbenchUiState>): void {
    this.ui = { ...this.ui, ...partial };
    for (const listener of this.listeners) listener();
  }
}
