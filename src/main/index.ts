import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from "electron";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWrite } from "./atomic";
import { fileURLToPath } from "node:url";
import { applyAppLocale, t } from "../shared/i18n";
import { sanitizeSpaceIcon } from "../shared/space-icon";
import { WINDOW_BG } from "../shared/theme";
import type {
  HubSettings,
  PackageSource,
  PluginDownloadRequest,
  PluginInstallRequest,
  PluginSpaceToggleRequest,
  SpaceMeta,
} from "../shared/types";
import { createProfile } from "./create-profile";
import { resolveDshHome } from "./dsh-home";
import {
  cliStatusSnapshot,
  ensureRuntime,
  getRuntimeStatus,
  onCliStatus,
  onPluginQueue,
  pluginQueueSnapshot,
  setManagedCliPrefix,
  findLegacyDshBin,
  setSelectedDshResolver,
  drainPluginQueue,
} from "./dsh-cli";
import { DiagnosticsService, sanitizeLogText } from "./diagnostics";
import { RuntimeStore } from "./runtime-store";
import { CooperativeChildren } from "../adapters/node/cooperative-children";
import { SnapshotExecutor } from "./snapshot-executor";
import {
  createDesktopController,
  createDesktopHomeControl,
  createDesktopProcessKill,
} from "../adapters/desktop";
import {
  DESKTOP_CONTROLLER_IPC,
  desktopSelectAccess,
  isDesktopMutateIpcChannel,
} from "../shared/desktop-controller";
import { CoordinatedUpgrade } from "./coordinated-upgrade";
import { describeRuntime, readRuntimeRef } from "./runtime-descriptor";
import { RestoreSession } from "./restore-session";
import type { MaintenanceView } from "../shared/maintenance-view";
import type { RestoreSnapshotOptions } from "../shared/snapshots";
import { readSettings, writeSettings } from "./hub-settings";
import { applyNativeTheme, currentColorScheme } from "./native-theme";
import { nodeExecutable, setPackageSource, setToolchainRoot, toolchainRoot } from "./toolchain";
import { confirmOnboarding } from "./onboarding";
import { PatchWriter } from "./patch-writer";
import { isStartCancelled, ProcessManager } from "./process-manager";
import { ProfileRegistry } from "./profile-registry";
import { smokeLifecycle } from "./smoke";
import { startAutoUpdate } from "./updater";
import { ViewManager } from "./view-manager";
import { pickSpaceIcon } from "./space-icon";
import { appIconPng, createAppTray, type TrayElectron, type TrayHandle } from "./tray";
import { loadPluginCatalog, searchPluginCatalog } from "./plugin-catalog";
import {
  downloadPlugin,
  installPluginToProfiles,
  listAllProfilePlugins,
  listPluginLibrary,
  listProfilePlugins,
  pluginRemove,
  removeDownloadedPlugin,
  resolveInstallSpec,
  setSpacePlugin,
} from "./plugin-ops";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.env.DSH_SPACES_USER_DATA) {
  const userData = resolve(process.env.DSH_SPACES_USER_DATA);
  mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
}

if (process.platform === "win32") {
  app.setAppUserModelId("dev.dshspaces.app");
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  startMain();
}

function startMain(): void {
  const dshHome = resolveDshHome();
  mkdirSync(dshHome, { recursive: true });
  const registry = new ProfileRegistry(dshHome);
  const patchWriter = new PatchWriter(dshHome);
  const settings = readSettings(dshHome);
  applyAppLocale(settings.locale);
  applyNativeTheme(settings.theme);
  let allowForceKill = false;
  const cooperativeChildren = new CooperativeChildren();
  const processes = new ProcessManager(dshHome, patchWriter, settings.portStart, settings.portEnd, {
    spawn: cooperativeChildren.spawn,
    kill: async (pid, kind) => {
      if (kind === "term") return cooperativeChildren.stop(pid);
      return createDesktopProcessKill(() => allowForceKill)(pid, kind);
    },
  });

  let mainWindow: BrowserWindow | null = null;
  let views: ViewManager | null = null;
  let currentSettings = settings;
  let allowClose = false;
  let quitInProgress = false;
  let initialized = false;
  let tray: TrayHandle | null = null;
  const homeControl = createDesktopHomeControl(dshHome);
  const maintenance = homeControl.maintenance;
  const desktop = createDesktopController(dshHome, {
    homeControl,
    stopOwned: async () => {
      allowForceKill = false;
      try {
        await processes.stopAll();
      } finally {
        allowForceKill = false;
      }
    },
    drainPlugins: drainPluginQueue,
    clearViews: () => {
      for (const profile of listProfiles()) views?.destroy(profile.name);
      views?.hideAll();
    },
    profileNames: () => registry.scan().map((row) => row.name),
    ownedSpaces: () =>
      listProfiles()
        .filter((profile) => profile.status === "running" || profile.status === "starting")
        .map((profile) => ({
          name: profile.name,
          displayName: profile.meta.displayName || profile.name,
          status: profile.status,
        })),
    onAdmit: () => {
      currentSettings = readSettings(dshHome);
      applyAppLocale(currentSettings.locale);
      applyNativeTheme(currentSettings.theme);
      processes.setPortRange(currentSettings.portStart, currentSettings.portEnd);
      setPackageSource(currentSettings.packageSource);
      const toolchain = desktop.homeToolchain();
      if (toolchain.kind === "verified") {
        setSelectedDshResolver(() => runtimes.current()?.bin ?? toolchain.bin);
      } else if (toolchain.kind === "absent") {
        setSelectedDshResolver(() => runtimes.current()?.bin);
      } else {
        throw new Error(toolchain.reason);
      }
      persistHomeToolchain();
    },
    onState: (state) => broadcast("controller-status", state),
  });
  desktop.acquireOnStart();
  const initialToolchain = desktop.homeToolchain();
  const sharedResources = initialToolchain.kind === "verified" ? initialToolchain : undefined;
  setManagedCliPrefix(join(app.getPath("userData"), "dsh-cli"));
  setToolchainRoot(sharedResources?.toolchainRoot ?? join(app.getPath("userData"), "toolchain"));
  const snapshotRoot = sharedResources?.snapshotRoot ?? join(app.getPath("userData"), "snapshots");
  const runtimeRoot = sharedResources?.runtimeRoot ?? join(app.getPath("userData"), "runtimes");
  const runtimes = new RuntimeStore({
    root: runtimeRoot,
    snapshotRoot,
    source: () => currentSettings.packageSource,
    legacy: () => sharedResources ? readRuntimeRef(sharedResources.bin) : readRuntimeRef(findLegacyDshBin()),
  });
  const snapshots = new SnapshotExecutor({
    home: dshHome, root: snapshotRoot,
    workerFile: join(__dirname, "snapshot-worker.mjs").replace("app.asar", "app.asar.unpacked"),
    inUse: (id) => {
      try {
        const bin = runtimes.current()?.bin;
        if (!bin) return false;
        const rel = relative(join(snapshotRoot, id), bin);
        return !rel.startsWith("..") && !isAbsolute(rel);
      }
      catch { return true; }
    },
  });
  setSelectedDshResolver(() => runtimes.current()?.bin);
  const upgrades = new CoordinatedUpgrade({
    home: dshHome, profiles: () => registry.scanOnboarding().profiles.map(row => row.name),
    stopAll: () => processes.stopAll(), drainPlugins: drainPluginQueue,
    snapshots, runtimes, runtimeDescriptor: () => describeRuntime(runtimes.current()),
    onProgress: (progress) => broadcast("maintenance-progress", progress),
  });
  let diagnostics = makeDiagnostics();
  const restore = new RestoreSession({
    snapshots,
    runtimes,
    applyRestoredSettings: () => {
      currentSettings = readSettings(dshHome);
      applyAppLocale(currentSettings.locale);
      applyNativeTheme(currentSettings.theme);
      processes.setPortRange(currentSettings.portStart, currentSettings.portEnd);
      setPackageSource(currentSettings.packageSource);
      diagnostics = makeDiagnostics();
    },
  });

  function makeDiagnostics(): DiagnosticsService {
    return new DiagnosticsService({
      home: dshHome, profiles: listProfiles, statusOf: (name) => processes.statusOf(name),
      stop: (name) => processes.stop(name),
      isMaintenance: () => maintenance.busy && maintenance.current !== "config-restore",
    });
  }

  function assertAvailable(): void {
    restore.assertAvailable(quitInProgress);
  }

  async function mutate<T>(action: () => T | Promise<T>): Promise<T> {
    assertAvailable();
    return desktop.mutate(action);
  }

  function runMaintenance<T>(label: string, action: () => Promise<T>): Promise<T> {
    return desktop.runMaintenance(label, async () => {
      const result = await action();
      persistHomeToolchain();
      return result;
    });
  }

  function persistHomeToolchain(): void {
    if (!desktop.held) return;
    const current = runtimes.current();
    const nodeExe = nodeExecutable();
    if (!current || !nodeExe) return;
    const path = join(dshHome, ".dsh-spaces-control", "toolchain.json");
    const prior = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    atomicWrite(path, `${JSON.stringify({ ...prior, version: 1, bin: current.bin,
      nodeExe, dshVersion: current.version, runtimeRoot, snapshotRoot,
      toolchainRoot: toolchainRoot(), boundAt: new Date().toISOString() }, null, 2)}\n`);
  }

  async function finishRestore(): Promise<void> {
    await restore.finishRestore();
  }

  function maintenanceView(): MaintenanceView {
    let error = restore.recoveryError;
    let inventory: MaintenanceView["inventory"] = { installed: [] };
    let stored: MaintenanceView["snapshots"] = [];
    try { inventory = runtimes.inventory(); } catch (err) { error ||= String(err); }
    try { stored = snapshots.list(); } catch (err) { error ||= String(err); }
    return { inventory, snapshots: stored, profiles: registry.scanOnboarding().profiles.map(row => row.name), operation: maintenance.current ?? undefined, error: error || undefined };
  }

  function preloadPath(): string {
    return join(__dirname, "../preload/index.mjs");
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
        sandbox: false,
      },
    });

    if (!isMac) win.setMenuBarVisibility(false);

    const sendMaximized = () => {
      win.webContents.send("window-maximized", win.isMaximized());
    };
    win.on("maximize", sendMaximized);
    win.on("unmaximize", sendMaximized);

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void win.loadFile(join(__dirname, "../renderer/index.html"));
    }

    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });

    win.on("close", (event) => {
      if (allowClose) return;
      event.preventDefault();
      if (tray?.available) win.hide();
      else win.minimize();
    });

    return win;
  }

  function showMainWindow(): void {
    if (!app.isReady() || !initialized) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createWindow();
      views = new ViewManager(mainWindow);
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload);
    }
  }

  function uiCommand(payload: unknown): void {
    mainWindow?.webContents.send("ui-command", payload);
  }

  function reportError(err: unknown): void {
    uiCommand({ type: "error", message: sanitizeLogText(err instanceof Error ? err.message : String(err)) });
  }

  function listProfiles() {
    const managerId = desktop.managerId();
    return registry.scan().filter(profile => profile.name !== managerId).map((profile) => ({
      ...profile,
      status: processes.statusOf(profile.name),
      port: processes.portOf(profile.name),
      lastError: processes.lastError(profile.name) ? sanitizeLogText(processes.lastError(profile.name)!) : undefined,
    }));
  }

  async function startAndShow(name: string): Promise<{ port: number }> {
    return mutate(async () => {
      const { port } = await processes.start(name);
      views?.select(name, port, processes.urlOf(name));
      return { port };
    });
  }

  function popupProfileMenu(name: string): void {
    const profile = listProfiles().find((item) => item.name === name);
    if (!profile || !mainWindow) return;
    const running = profile.status === "running";
    const starting = profile.status === "starting";
    const crashed = profile.status === "crashed";
    const menu = Menu.buildFromTemplate([
      {
        label: running || starting ? t("menu.alreadyRunning") : t("menu.start"),
        enabled: !running && !starting,
        click: () => {
          void startAndShow(name).catch((err: unknown) => {
            if (!isStartCancelled(err)) reportError(err);
          });
        },
      },
      {
        label: t("menu.restart"),
        enabled: running || crashed,
        click: () => {
          views?.destroy(name);
          void mutate(() => processes.restart(name))
            .then(({ port }) => views?.select(name, port, processes.urlOf(name)))
            .catch((err: unknown) => {
              if (!isStartCancelled(err)) reportError(err);
            });
        },
      },
      {
        label: t("menu.stop"),
        enabled: running || starting,
        click: () => {
          views?.destroy(name);
          void mutate(() => processes.stop(name)).catch(reportError);
        },
      },
      { type: "separator" },
      {
        label: t("menu.rename"),
        click: () => uiCommand({ type: "rename", name }),
      },
      {
        label: t("menu.changeIcon"),
        click: () => uiCommand({ type: "icon", name }),
      },
      {
        label: t("menu.openFolder"),
        click: () => {
          void shell.openPath(profile.path);
        },
      },
      {
        label: t("menu.managePlugins"),
        click: () => uiCommand({ type: "plugins", name }),
      },
      { label: currentSettings.locale === "en" ? "Diagnostics" : "诊断与配置恢复", click: () => uiCommand({ type: "diagnostics", name }) },
      { type: "separator" },
      {
        label: name === "web" ? t("menu.deleteDisabled") : t("menu.delete"),
        enabled: name !== "web",
        click: () => uiCommand({ type: "delete", name }),
      },
    ]);
    menu.popup({ window: mainWindow });
  }

  function registerIpc(): void {
    const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) => {
      ipcMain.handle(channel, (event, ...args) => isDesktopMutateIpcChannel(channel)
        ? mutate(() => listener(event, ...args)) : listener(event, ...args));
    };
    handle(DESKTOP_CONTROLLER_IPC.get, () => desktop.state());
    handle(DESKTOP_CONTROLLER_IPC.acquire, async () => {
      desktop.acquireExplicit();
      return desktop.admitWrites();
    });
    handle(DESKTOP_CONTROLLER_IPC.release, () => desktop.release());
    handle(DESKTOP_CONTROLLER_IPC.previewRelease, () => desktop.releasePreview());
    handle("getDiagnostics", (_event, name: string) => diagnostics.get(name));
    handle("quitApp", () => requestQuit());
    handle("previewConfigBackup", (_event, name: string, id: string) => diagnostics.previewBackup(name, id));
    handle("restoreConfigBackup", (_event, name: string, id: string) => {
      assertAvailable();
      return runMaintenance("config-restore", async () => {
        await drainPluginQueue();
        await diagnostics.restoreBackup(name, id);
      });
    });
    handle("getMaintenance", () => maintenanceView());
    handle("getRuntimeCatalog", () => runtimes.catalog());
    handle("previewUpgrade", (_event, version: string) => upgrades.preview(version));
    handle("upgradeRuntime", (_event, version: string) => {
      assertAvailable();
      return runMaintenance("upgrade", async () => {
        try { await upgrades.upgrade(version); await finishRestore(); }
        catch (err) {
          try { await upgrades.recover(); await finishRestore(); }
          catch (recovery) { restore.recoveryError = `Upgrade needs recovery: ${String(recovery)}`; }
          throw err;
        }
      });
    });
    handle("installRuntimeVersion", (_event, version: string) => {
      assertAvailable();
      return runMaintenance("runtime-install", async () => { await runtimes.install(version); });
    });
    handle("createSnapshot", () => {
      assertAvailable();
      return runMaintenance("snapshot", async () => {
        await drainPluginQueue(); await processes.stopAll();
        await snapshots.create(describeRuntime(runtimes.current()), "manual");
      });
    });
    handle("previewSnapshot", (_event, id: string) => snapshots.preview(id));
    handle("restoreSnapshot", (_event, id: string, options?: RestoreSnapshotOptions) => {
      if (quitInProgress) throw new Error("The application is exiting.");
      return runMaintenance("snapshot-restore", async () => {
        await drainPluginQueue(); await processes.stopAll();
        await restore.restoreSnapshot(id, {
          allowDataOnlyBackup: options?.allowDataOnlyBackup === true,
        });
      });
    });
    handle("deleteSnapshot", (_event, id: string) => {
      assertAvailable();
      return runMaintenance("snapshot-delete", async () => { await snapshots.delete(id); });
    });
    handle("listProfiles", () => listProfiles());
    handle("getSelectedProfile", () => views?.selectedName() ?? null);
    handle("getDshHome", () => dshHome);
    handle("getOnboarding", () => registry.scanOnboarding());
    handle("confirmOnboarding", async () => confirmOnboarding(dshHome, registry, patchWriter));
    handle("getSettings", () => currentSettings);
    handle("saveSettings", (_event, next: HubSettings) => {
      currentSettings = writeSettings(dshHome, next);
      applyAppLocale(currentSettings.locale);
      applyNativeTheme(currentSettings.theme);
      processes.setPortRange(currentSettings.portStart, currentSettings.portEnd);
      setPackageSource(currentSettings.packageSource);
      return currentSettings;
    });
    handle("getPluginQueue", () => pluginQueueSnapshot());
    handle(
      "getPluginCatalog",
      (_event, options: { refresh?: boolean; url?: string } = {}) => {
        const url = options.url || currentSettings.catalogUrl;
        if (!desktop.writable) {
          if (options.refresh) desktop.assertWritable("getPluginCatalog");
          return desktop.readPluginCatalog(url);
        }
        return mutate(() =>
          loadPluginCatalog(dshHome, {
            refresh: options.refresh,
            url,
          }),
        );
      },
    );
    handle("searchPluginCatalog", (_event, query: string) => {
      if (!desktop.writable) return desktop.searchPluginCatalog(query);
      return mutate(() => searchPluginCatalog(dshHome, query));
    });
    handle("listProfilePlugins", (_event, name: string) => listProfilePlugins(dshHome, name));
    handle("listAllProfilePlugins", () =>
      listAllProfilePlugins(
        dshHome,
        listProfiles().map((profile) => profile.name),
      ),
    );
    handle("listPluginLibrary", () => {
      if (!desktop.writable) return desktop.readPluginLibrary();
      return mutate(() =>
        listPluginLibrary(
          dshHome,
          listProfiles().map((profile) => profile.name),
        ),
      );
    });
    handle("installPlugin", async (_event, request: PluginInstallRequest) => {
      const spec = await resolveInstallSpec(dshHome, request);
      desktop.assertDesktopPluginMutation(request.profiles ?? [], spec);
      return installPluginToProfiles(dshHome, request.profiles ?? [], spec, (name) => {
        const status = processes.statusOf(name);
        return status === "running" || status === "starting";
      });
    });
    handle("downloadPlugin", async (_event, request: PluginDownloadRequest) => {
      const spec = await resolveInstallSpec(dshHome, request);
      desktop.assertOrdinaryPluginSpec(spec);
      return downloadPlugin(dshHome, request);
    });
    handle("removeLibraryPlugin", (_event, id: string) =>
      removeDownloadedPlugin(
        dshHome,
        id,
        listProfiles().map((profile) => profile.name),
      ),
    );
    handle("setSpacePlugin", async (_event, request: PluginSpaceToggleRequest) => {
      desktop.assertDesktopPluginMutation([request.profile], request.id);
      return setSpacePlugin(dshHome, request.profile, request.id, request.enabled, (name) => {
        const status = processes.statusOf(name);
        return status === "running" || status === "starting";
      });
    });
    handle("removePlugin", async (_event, profile: string, packageName: string) => {
      desktop.assertDesktopPluginMutation([profile], packageName);
      await pluginRemove(dshHome, profile, packageName);
      const status = processes.statusOf(profile);
      return { running: status === "running" || status === "starting" ? [profile] : [] };
    });
    handle("getCliStatus", () => cliStatusSnapshot());
    handle("getRuntimeStatus", () => getRuntimeStatus());
    handle("ensureCli", (_event, source?: PackageSource) => {
      const next = source ?? currentSettings.packageSource;
      currentSettings = writeSettings(dshHome, { ...currentSettings, packageSource: next });
      return ensureRuntime(next);
    });
    handle("startProfile", async (_event, name: string) => startAndShow(name));
    handle("stopProfile", async (_event, name: string) => {
      views?.destroy(name);
      await processes.stop(name);
    });
    handle("restartProfile", async (_event, name: string) => {
      views?.destroy(name);
      const { port } = await processes.restart(name);
      views?.select(name, port, processes.urlOf(name));
      return { port };
    });
    handle("selectProfile", async (_event, name: string) => {
      assertAvailable();
      if (maintenance.busy) throw new Error("A maintenance operation is in progress.");
      const port = processes.portOf(name);
      const running = port !== undefined && processes.statusOf(name) === "running";
      const access = desktopSelectAccess(desktop.writable, running);
      if (access === "deny") desktop.assertWritable("selectProfile");
      if (access === "start") {
        views?.hideAll();
        return startAndShow(name);
      }
      views?.select(name, port!, processes.urlOf(name));
      return { port: port! };
    });
    handle("pickSpaceIcon", (event) => pickSpaceIcon(event.sender));
    handle("updateMeta", (_event, name: string, patch: Partial<SpaceMeta>) => {
      if ("displayName" in patch) desktop.assertMutableProfile(name, "rename");
      if ("icon" in patch) patch = { ...patch, icon: sanitizeSpaceIcon(patch.icon) };
      return registry.updateMeta(name, patch);
    });
    handle("reorderProfiles", (_event, names: string[]) => {
      registry.reorder(names);
      return listProfiles();
    });
    handle(
      "deleteProfile",
      async (_event, name: string, options: { deleteOfficial?: boolean } = {}) => {
        if (name === "web") throw new Error(t("errors.cannotDeleteWeb"));
        desktop.assertMutableProfile(name, "delete");
        views?.destroy(name);
        await processes.stop(name);
        registry.removeHubData(name);
        registry.removeMeta(name);
        if (options.deleteOfficial) {
          registry.removeOfficialProfile(name);
        }
        return listProfiles();
      },
    );
    handle("openProfileDir", async (_event, name: string) => {
      const profile = listProfiles().find((item) => item.name === name);
      if (!profile) throw new Error(t("errors.unknownProfile", { name }));
      const error = await shell.openPath(profile.path);
      if (error) throw new Error(error);
    });
    handle("showProfileMenu", (_event, name: string) => {
      popupProfileMenu(name);
    });
    handle(
      "createProfile",
      async (_event, name: string, displayName: string | undefined, icon: string | undefined) => {
        desktop.assertMutableProfile(name, "create");
        await createProfile(dshHome, registry, patchWriter, name, displayName, (progress) => {
          broadcast("create-progress", progress);
        });
        if (icon) registry.updateMeta(name, { icon: sanitizeSpaceIcon(icon) });
        return listProfiles();
      },
    );
    handle("setOverlayOpen", (_event, open: boolean) => {
      views?.setOverlayOpen(open);
    });
    handle("showRailTip", (_event, text: string, top: number) => {
      views?.showTooltip(text, top);
    });
    handle("hideRailTip", () => {
      views?.hideTooltip();
    });
    handle("windowMinimize", (event) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize();
    });
    handle("windowToggleMaximize", (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return false;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    });
    handle("windowClose", (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close();
    });
    handle("windowIsMaximized", (event) => {
      return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
    });
  }

  async function requestQuit(): Promise<void> {
    if (allowClose || quitInProgress) return;
    quitInProgress = true;
    try {
      if (desktop.held) await desktop.release();
      allowClose = true;
      tray?.destroy();
      app.exit(0);
    } catch (err) {
      quitInProgress = false;
      showMainWindow();
      reportError(err);
    }
  }

  processes.onStatus((name, status, extra) => {
    if (status === "crashed" || status === "stopped") {
      views?.destroy(name);
    }
    if (desktop.writable) {
      diagnostics.record(name, "lifecycle", `${status}${extra?.error ? `: ${extra.error}` : ""}`);
    }
    broadcast("profile-status", { name, status, ...extra, error: extra?.error ? sanitizeLogText(extra.error) : undefined });
    tray?.refresh();
  });
  processes.onLog((name, channel, text) => {
    if (desktop.writable) diagnostics.record(name, channel, text);
  });

  onPluginQueue((snap) => broadcast("plugin-queue", snap));
  onCliStatus((status) => broadcast("cli-status", status));
  nativeTheme.on("updated", () => {
    applyNativeTheme(currentSettings.theme);
  });

  app.on("second-instance", () => {
    showMainWindow();
  });

  void app.whenReady().then(async () => {
    setManagedCliPrefix(join(app.getPath("userData"), "dsh-cli"));
    setToolchainRoot(sharedResources?.toolchainRoot ?? join(app.getPath("userData"), "toolchain"));
    setPackageSource(currentSettings.packageSource);
    if (desktop.held) {
      await desktop.admitWrites();
      if (desktop.writable) {
        try {
          await runMaintenance("startup-recovery", async () => {
            await upgrades.recover();
            await restore.recoverOnStartup();
          });
        } catch (err) {
          if (!restore.recoveryError) {
            restore.recoveryError = `Restore needs recovery before spaces can start: ${String(err)}`;
          }
          desktop.revokeAdmission("Interrupted restore must be recovered before new changes.");
        }
      }
    }
    registerIpc();
    if (process.env.DSH_SPACES_SMOKE === "1") {
      try {
        await runMaintenance("runtime-prep", async () => {
          await ensureRuntime(currentSettings.packageSource);
          await smokeLifecycle(processes);
        });
        console.log("SMOKE: PASS");
        allowClose = true;
        app.exit(0);
      } catch (err) {
        console.error("SMOKE: FAIL", err);
        allowClose = true;
        app.exit(1);
      }
      return;
    }
    startAutoUpdate();
    initialized = true;
    mainWindow = createWindow();
    views = new ViewManager(mainWindow);
    tray = createAppTray(
      { Tray, Menu, nativeImage } as unknown as TrayElectron,
      {
        getSpaces: () =>
          listProfiles().map((profile) => ({
            name: profile.name,
            displayName: profile.meta.displayName || profile.name,
            status: profile.status,
          })),
        onShow: () => showMainWindow(),
        onStopAll: () => {
          void mutate(() => processes.stopAll()).catch((err: unknown) => {
            showMainWindow();
            reportError(err);
          });
        },
        onQuit: () => {
          app.quit();
        },
      },
    );
    if (restore.recoveryError) mainWindow.webContents.once("did-finish-load", () => reportError(restore.recoveryError));
    app.on("activate", () => {
      showMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (allowClose) return;
    if (process.platform !== "darwin" && !tray?.available) app.quit();
  });

  app.on("before-quit", (event) => {
    if (allowClose) return;
    event.preventDefault();
    void requestQuit();
  });
}
