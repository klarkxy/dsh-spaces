import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectControlResidue, inspectHomeToolchain } from "../adapters/desktop";
import { resolveControlToolsRoot } from "../adapters/node/control-residue";
import { assertDevelopmentPath, refreshDevelopmentRuntime } from "../adapters/node/development-refresh";
import {
  DesktopServiceClient,
  type DesktopServicePublicState,
} from "../adapters/desktop/service-client";
import { parseLoopbackOrigin } from "../../packages/plugin/src/host/loopback";
import {
  DESKTOP_SHELL_IPC,
  DESKTOP_SHELL_PARTITION,
  isTrustedShellFrame,
  parseClientPreferencePatch,
  publishShellReasons,
  redactDesktopShellText,
  sameTrustedUrl,
  type DesktopShellPhase,
  type DesktopShellPublicState,
  type DesktopStartupStage,
} from "../shared/desktop-shell";
import type { WorkbenchState } from "../shared/workbench";
import { applyAppLocale, t } from "../shared/i18n";
import { WINDOW_BG } from "../shared/theme";
import type { CliEnsureStatus } from "../shared/types";
import {
  cliStatusSnapshot,
  ensureRuntime,
  findDshBin,
  getRuntimeStatus,
  onCliStatus,
  setManagedCliPrefix,
  setSelectedDshResolver,
} from "../adapters/node/dsh-cli";
import { resolveDshHome } from "./dsh-home";
import { createDesktopStartup } from "./desktop-startup";
import { createStartupProgress } from "./desktop-startup-progress";
import { authorizeProductHome } from "../adapters/node/home-guard";
import { applyNativeTheme, currentColorScheme } from "./native-theme";
import {
  shutdownWorkbenchService,
  stopFailureMessage,
  stopOwnedSpaces,
  type ShellWorkbenchPort,
} from "./desktop-shell-protocol";
import {
  applyPreferencePatch,
  coalesceInflight,
  DESKTOP_SNAPSHOTS_DIRNAME,
  ensureDesktopSnapshotRoot,
  loadShellPrefs,
  openWorkbenchSession,
  realDirectory,
  resolveSpacesPayloadRoot,
  shellPreloadPath,
  testRuntimeOverride,
  trustedShellUrl,
  verifiedToolFile,
  writeShellPrefs,
  type InflightHolder,
} from "./desktop-shell-runtime";
import { nodeExecutable, setPackageSource, setToolchainRoot } from "../adapters/node/toolchain";
import {
  appIconPng,
  concealWindowToTray,
  createAppTray,
  revealWindowFromTray,
  type TrayElectron,
  type TrayHandle,
  type TraySpace,
} from "./tray";
import { startAutoUpdate } from "./updater";
import { ViewManager } from "./view-manager";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL?.trim() || undefined;
const REFRESH_DEVELOPMENT = !app.isPackaged && process.env.DSH_SPACES_DEVELOPMENT === "1";
const TRUSTED_SHELL_URL = trustedShellUrl({
  devRendererUrl: DEV_RENDERER_URL,
  moduleDir: __dirname,
});

if (process.env.DSH_SPACES_USER_DATA) {
  const userData = resolve(process.env.DSH_SPACES_USER_DATA);
  if (REFRESH_DEVELOPMENT) assertDevelopmentPath(userData);
  mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
}

if (process.platform === "win32") {
  app.setAppUserModelId("dev.dshspaces.app");
}

if (!app.requestSingleInstanceLock()) {
  if (REFRESH_DEVELOPMENT) console.error("[dev] A development window is already open. Exit its dev command before launching another build. The running service was not changed.");
  app.exit(REFRESH_DEVELOPMENT ? 1 : 0);
} else if (REFRESH_DEVELOPMENT) {
  // Own the desktop instance BEFORE changing the service. A second invocation
  // must never stop the backend and then merely focus an obsolete shell.
  void app.whenReady().then(async () => {
    const result = await refreshDevelopmentRuntime({
      home: resolveDshHome(),
      userData: app.getPath("userData"),
      payloadRoot: resolveSpacesPayloadRoot({ packaged: false, resourcesPath: process.resourcesPath, moduleDir: __dirname }),
      log: message => console.log(`[dev] ${message}`),
    });
    console.log(`[dev] ${result.status}: ${result.digest.slice(0, 12)} (${result.home})`);
    startMain();
  }).catch(error => {
    const message = redactDesktopShellText(error instanceof Error ? error.message : String(error));
    console.error(`[dev] ${message}`);
    console.error("[dev] The development update did not finish. Opening the existing service.");
    startMain(message);
  });
} else {
  startMain();
}

function startMain(startupNotice?: string): void {
  const dshHome = resolveDshHome();
  mkdirSync(dshHome, { recursive: true });
  authorizeProductHome(dshHome);

  const userData = app.getPath("userData");
  let prefs = loadShellPrefs(userData, dshHome);
  applyAppLocale(prefs.locale);
  applyNativeTheme(prefs.theme);
  setPackageSource(prefs.packageSource);
  setManagedCliPrefix(join(userData, "dsh-cli"));
  setToolchainRoot(join(userData, "toolchain"));

  const toolchain = inspectHomeToolchain(dshHome);
  if (toolchain.kind === "verified") {
    if (toolchain.toolchainRoot && realDirectory(toolchain.toolchainRoot)) {
      setToolchainRoot(toolchain.toolchainRoot);
    }
    setSelectedDshResolver(() => toolchain.bin);
  }

  const payloadRoot = resolveSpacesPayloadRoot({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDir: __dirname,
  });
  const toolsRoot = toolchain.kind === "invalid" ? join(userData, "supervisor-tools")
    : resolveControlToolsRoot(dshHome, userData, toolchain);
  const recordedSnapshotRoot =
    toolchain.kind === "verified" && typeof toolchain.snapshotRoot === "string" && toolchain.snapshotRoot.trim()
      ? toolchain.snapshotRoot
      : "";
  const snapshotRoot = recordedSnapshotRoot || join(userData, DESKTOP_SNAPSHOTS_DIRNAME);

  const progress = createStartupProgress({
    onAdvance: () => broadcastState(),
    onLog: (line) => console.log(line),
  });
  const clientOptions = {
    home: dshHome,
    payloadRoot,
    toolsRoot,
    snapshotRoot,
    allowRealHome: app.isPackaged === true || Boolean(process.env.DSH_SPACES_ALLOW_REAL_HOME),
    onStage: (stage: DesktopStartupStage) => {
      progress.stage(stage);
    },
  };
  let client = new DesktopServiceClient(clientOptions);

  let mainWindow: BrowserWindow | null = null;
  let views: ViewManager | null = null;
  let tray: TrayHandle | null = null;
  let trayHintShown = false;
  let allowClose = false;
  let quitInProgress = false;
  let initialized = false;
  let preparing = false;
  let starting = false;
  const prepareInflight: InflightHolder<DesktopShellPublicState> = { current: null };
  const startInflight: InflightHolder<DesktopShellPublicState> = { current: null };
  let viewGeneration = 0;
  let stateSeq = 0;
  let workbenchError: string | null = startupNotice?.trim() ? startupNotice.trim() : null;
  let traySpaces: TraySpace[] = [];
  let lastService: DesktopServicePublicState = client.publicState();
  let workbenchSession: Session | null = null;
  const startup = createDesktopStartup({
    connect: connectOnce,
    status: () => lastService.status,
    canStart: () => !preparing && cliStatusSnapshot().state !== "error" &&
      toolchain.kind !== "invalid" && toolsReady(),
    start: startService,
  });

  function requireWorkbenchSession(): Session {
    if (!workbenchSession) {
      throw new Error("The workbench session is not ready.");
    }
    return workbenchSession;
  }

  function secrets(): string[] {
    return [
      dshHome,
      userData,
      payloadRoot,
      toolsRoot,
      snapshotRoot,
      toolchain.kind === "verified" ? toolchain.bin : "",
      toolchain.kind === "verified" ? toolchain.nodeExe : "",
    ].filter((row) => row.length >= 3);
  }

  function publicCli(): CliEnsureStatus {
    const snap = cliStatusSnapshot();
    return {
      ...snap,
      message: redactDesktopShellText(snap.message, secrets()),
    };
  }

  function publicReasons(extra: string[] = []): string[] {
    const residue = inspectControlResidue(dshHome);
    const rows = [
      ...(toolchain.kind === "invalid" ? [toolchain.reason] : []),
      ...residue,
      ...lastService.reasons,
      ...extra,
    ];
    return publishShellReasons(rows, secrets());
  }

  function runtimeFlags(): DesktopShellPublicState["runtime"] {
    const test = testRuntimeOverride();
    if (test) return { node: true, pnpm: true, cli: true };
    if (toolchain.kind === "verified") {
      return {
        node: Boolean(verifiedToolFile(toolchain.nodeExe)),
        pnpm: true,
        cli: Boolean(verifiedToolFile(toolchain.bin)),
      };
    }
    try {
      const status = getRuntimeStatus();
      return { node: status.node, pnpm: status.pnpm, cli: status.cli };
    } catch {
      return { node: false, pnpm: false, cli: false };
    }
  }

  function toolsReady(): boolean {
    const runtime = runtimeFlags();
    return runtime.node && runtime.cli;
  }

  function phaseOf(): DesktopShellPhase {
    if (workbenchError) return "workbench-error";
    if (preparing) return "needs-tools";
    if (starting || lastService.status === "connecting") return "connecting";
    if (lastService.status === "connected") return "connected";
    if (toolchain.kind === "invalid") return "blocked";
    if (lastService.status === "unavailable") return "unavailable";
    if (cliStatusSnapshot().state === "error" || !toolsReady()) return "needs-tools";
    return "tools-ready";
  }

  function snapshotState(): DesktopShellPublicState {
    const phase = phaseOf();
    stateSeq += 1;
    return {
      seq: stateSeq,
      phase,
      serviceStatus: lastService.status,
      startupStage: phase === "connecting" ? progress.current() : null,
      reasons: publicReasons(workbenchError ? [workbenchError] : []),
      workbenchError,
      runtime: runtimeFlags(),
      cli: publicCli(),
      locale: prefs.locale,
      theme: prefs.theme,
      packageSource: prefs.packageSource,
      canPrepare: toolchain.kind === "absent" && phase === "needs-tools" && !preparing,
      canStart: toolchain.kind !== "invalid" && toolsReady() &&
        lastService.status !== "connected" && lastService.status !== "connecting" &&
        !starting && !preparing,
      overlay: phase !== "connected",
    };
  }

  function emitState(state: DesktopShellPublicState): void {
    views?.setOverlayOpen(state.overlay);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_SHELL_IPC.stateEvent, state);
    }
  }

  function snapshotAndEmit(): DesktopShellPublicState {
    const state = snapshotState();
    emitState(state);
    return state;
  }

  function broadcastState(): void {
    snapshotAndEmit();
  }

  function assertShell(event: IpcMainInvokeEvent): void {
    const shellContents = mainWindow?.webContents;
    const frame = event.senderFrame;
    const trusted = isTrustedShellFrame({
      senderIsShell: Boolean(shellContents && event.sender === shellContents),
      isMainFrame: Boolean(frame && frame === frame.top),
      frameUrl: frame?.url ?? "",
      trustedUrl: TRUSTED_SHELL_URL,
    });
    if (!trusted) throw new Error("Unauthorized IPC sender.");
  }

  function resolveStartRuntime(): { nodeExe: string; cliBin: string } {
    const test = testRuntimeOverride();
    if (test) return test;
    if (toolchain.kind === "invalid") throw new Error(toolchain.reason);
    if (toolchain.kind === "verified") {
      const nodeExe = verifiedToolFile(toolchain.nodeExe);
      const cliBin = verifiedToolFile(toolchain.bin);
      if (!nodeExe || !cliBin) {
        throw new Error("The Home toolchain record is damaged and was not overwritten.");
      }
      return { nodeExe, cliBin };
    }
    const nodeExe = verifiedToolFile(nodeExecutable());
    const cliBin = verifiedToolFile(findDshBin());
    if (!nodeExe || !cliBin) {
      throw new Error("Install the runtime before starting the workbench service.");
    }
    return { nodeExe, cliBin };
  }

  async function presentWorkbench(): Promise<void> {
    const generation = ++viewGeneration;
    if (!views) return;
    // Tray refresh only depends on the connected status; start it concurrently
    // with the handoff mint and join before this presentation returns.
    const trayRefresh = refreshTraySpaces();
    try {
      progress.stage("load-workbench");
      const entryUrl = await client.entryUrl();
      if (generation !== viewGeneration) return;
      const origin = parseLoopbackOrigin(new URL(entryUrl).origin);
      if (!origin) throw new Error("The workbench entry origin is not a trusted loopback address.");
      if (generation !== viewGeneration || !views) return;
      workbenchError = null;
      views.presentWorkbench({
        entryUrl,
        managerOrigin: origin,
        onError: (message) => {
          workbenchError = message;
          broadcastState();
        },
      });
      progress.succeed();
    } finally {
      await trayRefresh.catch(() => {
        /* The tray keeps its last list; a refresh failure never blocks presentation. */
      });
    }
  }

  async function connectOnce(): Promise<void> {
    progress.beginConnect();
    lastService = { status: "connecting", reasons: [] };
    broadcastState();
    lastService = await client.connect();
    if (lastService.status === "connected") {
      await presentWorkbench();
    } else if (lastService.status === "unavailable") {
      progress.fail();
    }
    broadcastState();
  }

  async function prepareEnvironment(): Promise<DesktopShellPublicState> {
    return coalesceInflight(prepareInflight, async () => {
      if (toolchain.kind === "invalid") throw new Error(toolchain.reason);
      if (toolchain.kind !== "absent") {
        throw new Error("The Home toolchain is already recorded and was not overwritten.");
      }
      preparing = true;
      broadcastState();
      try {
        await ensureRuntime(prefs.packageSource);
        lastService = client.publicState();
      } catch (error) {
        preparing = false;
        broadcastState();
        throw error;
      }
      preparing = false;
      await startup.environmentPrepared();
      return snapshotAndEmit();
    });
  }

  async function startService(): Promise<DesktopShellPublicState> {
    if (lastService.status === "connected") return snapshotAndEmit();
    return coalesceInflight(startInflight, async () => {
      progress.beginStart();
      const runtime = resolveStartRuntime();
      starting = true;
      workbenchError = null;
      broadcastState();
      try {
        ensureDesktopSnapshotRoot(dshHome, snapshotRoot, { createIfMissing: !recordedSnapshotRoot });
        lastService = await client.start(runtime);
        if (lastService.status === "connected") await presentWorkbench();
        else progress.fail();
      } catch (error) {
        progress.fail();
        starting = false;
        workbenchError = redactDesktopShellText(error instanceof Error ? error.message : String(error), secrets());
        broadcastState();
        throw error;
      }
      starting = false;
      return snapshotAndEmit();
    });
  }

  async function refreshTraySpaces(): Promise<void> {
    if (lastService.status !== "connected") {
      traySpaces = [];
      tray?.refresh();
      return;
    }
    try {
      traySpaces = readTraySpaces(await client.getApi().state());
    } catch {
      /* Keep the last public list. A read failure is not a stop success. */
    }
    tray?.refresh();
  }

  function readTraySpaces(state: WorkbenchState): TraySpace[] {
    const rows: TraySpace[] = [];
    for (const row of state.spaces) {
      if (!row.id || row.id === "web") continue;
      const status =
        row.status === "running" || row.status === "starting" || row.status === "crashed"
          ? row.status
          : "stopped";
      rows.push({
        name: row.id,
        displayName: row.displayName || row.id,
        status,
      });
    }
    return rows;
  }

  function protocolApi(): ShellWorkbenchPort {
    return client.getApi();
  }

  async function confirmAndStopSpaces(): Promise<void> {
    showMainWindow();
    if (!mainWindow) return;
    const asked = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: [t("tray.stopAll"), t("common.cancel")],
      cancelId: 1,
      defaultId: 1,
      title: t("tray.stopAllTitle"),
      message: t("tray.stopAllTitle"),
      detail: t("tray.stopAllDetail"),
    });
    if (asked.response !== 0) return;
    try {
      const result = await stopOwnedSpaces(protocolApi());
      await refreshTraySpaces();
      if (result.failed) throw new Error(redactDesktopShellText(stopFailureMessage(result), secrets()));
    } catch (error) {
      reportError(error);
    }
  }

  async function confirmAndStopService(): Promise<void> {
    showMainWindow();
    if (!mainWindow) return;
    const asked = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: [t("tray.stopService"), t("common.cancel")],
      cancelId: 1,
      defaultId: 1,
      title: t("tray.stopServiceTitle"),
      message: t("tray.stopServiceTitle"),
      detail: t("tray.stopServiceDetail"),
    });
    if (asked.response !== 0) return;
    try {
      const result = await shutdownWorkbenchService(protocolApi());
      lastService = client.publicState();
      if (result.disconnected || !result.succeeded) {
        workbenchError = redactDesktopShellText(result.message, secrets());
        views?.setOverlayOpen(true);
        broadcastState();
        if (!result.succeeded) throw new Error(workbenchError);
        return;
      }
      views?.destroy();
      views = mainWindow ? new ViewManager(mainWindow, requireWorkbenchSession()) : null;
      client.dispose();
      client = new DesktopServiceClient(clientOptions);
      progress.reset();
      lastService = client.publicState();
      traySpaces = [];
      tray?.refresh();
      broadcastState();
    } catch (error) {
      lastService = client.publicState();
      reportError(error);
    }
  }

  function reportError(err: unknown): void {
    const message = redactDesktopShellText(err instanceof Error ? err.message : String(err), secrets());
    workbenchError = message;
    broadcastState();
    showMainWindow();
  }

  function preloadPath(): string {
    return shellPreloadPath(__dirname);
  }

  function createWindow(): BrowserWindow {
    const isMac = process.platform === "darwin";
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 560,
      title: "DSH Spaces",
      ...(app.isPackaged ? {} : { icon: nativeImage.createFromBuffer(appIconPng()) }),
      backgroundColor: WINDOW_BG[currentColorScheme()],
      frame: isMac,
      titleBarStyle: isMac ? "hiddenInset" : undefined,
      trafficLightPosition: isMac ? { x: 12, y: 8 } : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    if (!isMac) win.setMenuBarVisibility(false);

    const sendMaximized = () => {
      win.webContents.send(DESKTOP_SHELL_IPC.windowMaximizedEvent, win.isMaximized());
    };
    win.on("maximize", sendMaximized);
    win.on("unmaximize", sendMaximized);

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (!sameTrustedUrl(url, TRUSTED_SHELL_URL)) event.preventDefault();
    });

    if (DEV_RENDERER_URL) {
      void win.loadURL(DEV_RENDERER_URL);
    } else {
      void win.loadFile(join(__dirname, "../renderer/index.html"));
    }

    win.on("close", (event) => {
      if (allowClose) return;
      event.preventDefault();
      if (tray?.available) {
        concealWindowToTray(win);
        notifyHiddenToTray();
      } else {
        win.minimize();
      }
    });

    return win;
  }

  function showMainWindow(): void {
    if (!app.isReady() || !initialized) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createWindow();
      views = new ViewManager(mainWindow, requireWorkbenchSession());
    }
    revealWindowFromTray(mainWindow);
  }

  function notifyHiddenToTray(): void {
    if (trayHintShown || !Notification.isSupported()) return;
    trayHintShown = true;
    try {
      const toast = new Notification({
        title: t("cli.brand"),
        body: t("tray.stillRunning"),
        icon: nativeImage.createFromBuffer(appIconPng()),
      });
      toast.on("click", () => showMainWindow());
      toast.show();
    } catch {
      /* Finding the tray icon is enough if the toast cannot be shown. */
    }
  }

  function registerIpc(): void {
    const handle = (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => {
      ipcMain.handle(channel, (event, ...args) => {
        assertShell(event);
        return listener(event, ...args);
      });
    };

    handle(DESKTOP_SHELL_IPC.getState, () => snapshotAndEmit());
    handle(DESKTOP_SHELL_IPC.prepareEnvironment, () => prepareEnvironment());
    handle(DESKTOP_SHELL_IPC.startService, () => startService());
    handle(DESKTOP_SHELL_IPC.setPreference, (_event, raw) => {
      const patch = parseClientPreferencePatch(raw);
      if (!patch) throw new Error("That preference update is not allowed.");
      prefs = writeShellPrefs(userData, applyPreferencePatch(prefs, patch));
      applyAppLocale(prefs.locale);
      applyNativeTheme(prefs.theme);
      if (patch.packageSource) setPackageSource(patch.packageSource);
      return snapshotAndEmit();
    });
    handle(DESKTOP_SHELL_IPC.windowMinimize, (event) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize();
    });
    handle(DESKTOP_SHELL_IPC.windowToggleMaximize, (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return false;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    });
    handle(DESKTOP_SHELL_IPC.windowClose, (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close();
    });
    handle(DESKTOP_SHELL_IPC.windowIsMaximized, (event) => {
      return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
    });
  }

  function requestQuit(): void {
    if (allowClose || quitInProgress) return;
    quitInProgress = true;
    allowClose = true;
    views?.destroy();
    client.dispose();
    tray?.destroy();
    app.exit(0);
  }

  onCliStatus(() => {
    broadcastState();
  });
  nativeTheme.on("updated", () => {
    applyNativeTheme(prefs.theme);
  });

  app.on("second-instance", () => {
    showMainWindow();
  });

  void app.whenReady().then(async () => {
    if (process.env.DSH_SPACES_SMOKE === "1") {
      console.error(
        "SMOKE: the desktop shell no longer starts spaces inside the Electron process. Use DesktopServiceClient against a Supervisor.",
      );
      allowClose = true;
      app.exit(1);
      return;
    }
    registerIpc();
    startAutoUpdate();
    const readySession = openWorkbenchSession(app.isReady(), () =>
      session.fromPartition(DESKTOP_SHELL_PARTITION),
    );
    workbenchSession = readySession;
    initialized = true;
    mainWindow = createWindow();
    views = new ViewManager(mainWindow, readySession);
    tray = createAppTray({ Tray, Menu, nativeImage } as unknown as TrayElectron, {
      getSpaces: () => traySpaces,
      onShow: () => showMainWindow(),
      onStopAll: () => {
        void confirmAndStopSpaces();
      },
      onStopService: () => {
        void confirmAndStopService();
      },
      onQuit: () => {
        requestQuit();
      },
    });
    app.on("activate", () => {
      showMainWindow();
    });
    broadcastState();
    try {
      await startup.open();
    } catch (error) {
      progress.fail();
      lastService = client.publicState();
      if (lastService.status !== "unavailable") {
        lastService = {
          status: "unavailable",
          reasons: [error instanceof Error ? error.message : String(error)],
        };
      }
      broadcastState();
    }
  });

  app.on("window-all-closed", () => {
    if (allowClose) return;
    if (process.platform !== "darwin" && !tray?.available) {
      /* The window was minimized so it can be found again. */
    }
  });

  app.on("before-quit", (event) => {
    if (allowClose) return;
    event.preventDefault();
    requestQuit();
  });
}
