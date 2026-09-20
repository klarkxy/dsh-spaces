import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from "electron";
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
import { observeMaintenanceChild, ownsObservedChild, withChildObservation } from "./owned-process-record";
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
import type { MaintenanceView } from "../shared/maintenance-view";
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
import {
  appIconPng,
  concealWindowToTray,
  createAppTray,
  revealWindowFromTray,
  type TrayElectron,
  type TrayHandle,
} from "./tray";
import { loadPluginCatalog, searchPluginCatalog } from "./plugin-catalog";
import {
  downloadPlugin,
  installPluginToProfiles,
  listAllProfilePlugins,
  listPluginLibrary,
  listProfilePlugins,
  pluginAdd,
  pluginRemove,
  removeDownloadedPlugin,
  resolveInstallSpec,
  setSpacePlugin,
} from "./plugin-ops";
import {
  exportSpaceArchive,
  importSpaceArchive,
  previewSpaceShare,
  uniqueSpaceName,
  writeSpaceArchiveFile,
} from "./space-share";
import { createSpaceFromTemplate, listSpaceTemplates, saveSpaceTemplate } from "./space-templates";
import { createDesktopLlmHost } from "./desktop-llm";
import { FileLlmSpaceSettings } from "../adapters/node/llm-space-settings";
import { writeSpaceLlmLaunchSnapshot } from "../adapters/node/llm-snapshot";
import type { LlmApiRequest, LlmCredentialRequest } from "../shared/llm-api";

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
  const cooperativeChildren = new CooperativeChildren({
    journalHome: dshHome,
    onJournalFailure: () => desktop.revokeAdmission("The owned process record requires recovery before further changes."),
  });
  const processes = new ProcessManager(dshHome, patchWriter, settings.portStart, settings.portEnd, {
    spawn: cooperativeChildren.spawn,
    extraEnv: (name) => writeSpaceLlmLaunchSnapshot(dshHome, name),
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
  let trayHintShown = false;
  const homeControl = createDesktopHomeControl(dshHome);
  const maintenance = homeControl.maintenance;
  const desktop = createDesktopController(dshHome, {
    homeControl,
    ownsInstanceRecord: record => cooperativeChildren.ownsRecord(record) || ownsObservedChild(dshHome, record),
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
    installWorker: { file: join(__dirname, "snapshot-worker.mjs").replace("app.asar", "app.asar.unpacked"), home: dshHome },
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
    workerFile: join(__dirname, "snapshot-worker.mjs").replace("app.asar", "app.asar.unpacked"),
    observeChild: () => observeMaintenanceChild(dshHome, () => desktop.revokeAdmission("Maintenance process identity could not be verified.")),
    stopAll: () => processes.stopAll(), drainPlugins: drainPluginQueue,
    snapshots, runtimes, runtimeDescriptor: () => describeRuntime(runtimes.current()),
    onProgress: (progress) => broadcast("maintenance-progress", progress),
  });
  let diagnostics = makeDiagnostics();
  const desktopLlm = createDesktopLlmHost(dshHome, {
    listSpaceIds: () => [...new Set(["web", ...listProfiles().map((row) => row.name)])],
    statusOf: (spaceId) => {
      const status = processes.statusOf(spaceId);
      if (status === "running" || status === "starting" || status === "stopped" || status === "crashed") {
        return status;
      }
      return "unknown";
    },
    generationOf: () => 0,
    restart: async (spaceId) => {
      if (spaceId !== "web") await processes.restart(spaceId);
    },
    assertWritable: () => desktop.assertWritable("llm"),
  });

  function makeDiagnostics(): DiagnosticsService {
    return new DiagnosticsService({
      home: dshHome, profiles: listProfiles, statusOf: (name) => processes.statusOf(name),
      stop: (name) => processes.stop(name),
      isMaintenance: () => maintenance.busy && maintenance.current !== "config-restore",
    });
  }

  function assertAvailable(): void {
    if (quitInProgress) {
      throw new Error("The application is exiting. Wait for shutdown to finish.");
    }
  }

  async function mutate<T>(action: () => T | Promise<T>): Promise<T> {
    assertAvailable();
    return desktop.mutate(() => withChildObservation(
      () => observeMaintenanceChild(dshHome, () => desktop.revokeAdmission("Subprocess identity could not be verified.")), action));
  }

  function runMaintenance<T>(label: string, action: () => Promise<T>): Promise<T> {
    return desktop.runMaintenance(label, () => withChildObservation(
      () => observeMaintenanceChild(dshHome, () => desktop.revokeAdmission("Subprocess identity could not be verified.")), async () => {
      const result = await action();
      persistHomeToolchain();
      return result;
    }));
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

  function maintenanceView(): MaintenanceView {
    let error = "";
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
      views = new ViewManager(mainWindow);
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

  async function confirmExportIncludeConfig(name: string): Promise<boolean | null> {
    if (!mainWindow) return null;
    const zh = currentSettings.locale !== "en";
    const asked = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: [
        zh ? "仅插件组成" : "Plugins only",
        zh ? "附带配置" : "Include config",
        t("common.cancel"),
      ],
      cancelId: 2,
      defaultId: 0,
      title: t("menu.exportSpace"),
      message: zh ? `导出 ${name} 为空间分享包？` : `Export ${name} as a space share?`,
      detail: zh
        ? "默认不附带配置。若附带配置，保存前会预览配置内容。"
        : "Config is off by default. If you include it, you will preview the config before saving.",
    });
    if (asked.response === 2) return null;
    return asked.response === 1;
  }

  async function formatSharePreview(
    name: string,
    includeConfig: boolean,
    patch?: string,
  ): Promise<{ archive: Buffer; text: string }> {
    const profile = listProfiles().find((item) => item.name === name);
    const shared = await desktopLlm.llm({ method: "previewShare", spaceId: name }).catch(() => null);
    const llm =
      shared && typeof shared === "object" && "requirements" in shared && "adapterRequired" in shared
        ? shared
        : undefined;
    const archive = exportSpaceArchive(dshHome, name, {
      displayName: profile?.meta.displayName,
      icon: profile?.meta.icon,
      includeConfig,
      dshVersion: runtimes.current()?.version ?? null,
      llm,
    });
    const preview = previewSpaceShare(archive);
    const lines = [
      `plugins: ${
        preview.plugins
          .map((row) => `${row.packageName}@${row.resolvedVersion ?? "unknown"} (${row.source})`)
          .join(", ") || "(none)"
      }`,
      preview.unknownSources.length ? `unknown/manual: ${preview.unknownSources.join(", ")}` : "",
      `config: ${preview.hasConfig ? "yes" : "no"}`,
      preview.llmMappingRequired ? `llm requirements: ${preview.llmRequirements.length} (mapping required)` : "llm: none",
      patch ? `--- config ---\n${patch.slice(0, 4000)}` : "",
    ];
    return { archive, text: lines.filter(Boolean).join("\n") };
  }

  async function exportSpaceShare(name: string, includeConfig = false): Promise<string | null> {
    if (!mainWindow) return null;
    const profile = listProfiles().find((item) => item.name === name);
    if (!profile || name === "web") throw new Error("The web space cannot be exported.");
    const patchPath = join(dshHome, "profiles", name, "cordis.patch.yml");
    const patch = includeConfig && existsSync(patchPath) ? readFileSync(patchPath, "utf8") : undefined;
    const previewed = await formatSharePreview(name, includeConfig, patch);
    const zh = currentSettings.locale !== "en";
    const confirmed = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: [t("common.confirm"), t("common.cancel")],
      cancelId: 1,
      defaultId: 0,
      title: t("menu.exportSpace"),
      message: zh ? "导出预览" : "Export preview",
      detail: previewed.text,
    });
    if (confirmed.response !== 0) return null;
    const picked = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${profile.meta.displayName || name}.dshspace`,
      filters: [{ name: "DSH space", extensions: ["dshspace"] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    writeSpaceArchiveFile(picked.filePath, previewed.archive);
    return picked.filePath;
  }

  async function importSpaceShare(): Promise<Awaited<ReturnType<typeof importSpaceArchive>> | null> {
    if (!mainWindow) return null;
    const picked = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: "DSH space", extensions: ["dshspace"] }],
      properties: ["openFile"],
    });
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return null;
    const archive = readFileSync(file);
    return importSpaceArchive(archive, {
      listSpaceIds: () => listProfiles().map((row) => row.name),
      createSpace: async (input) => {
        await createProfile(dshHome, registry, patchWriter, input.name, input.displayName);
        if (input.icon) registry.updateMeta(input.name, { icon: sanitizeSpaceIcon(input.icon) });
      },
      installPlugin: async (spaceId, spec) => {
        desktop.assertDesktopPluginMutation([spaceId], spec);
        await pluginAdd(dshHome, spaceId, spec);
      },
      writeLlmShare: async (spaceId, manifest) => {
        const settings = new FileLlmSpaceSettings(dshHome);
        await settings.writeImport(spaceId, manifest);
      },
      dshVersion: runtimes.current()?.version ?? null,
    }, {
      writePatch: (spaceId, patch) => {
        atomicWrite(join(dshHome, "profiles", spaceId, "cordis.patch.yml"), patch);
        patchWriter.ensureWorkbenchPatch(spaceId);
      },
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
      {
        label: currentSettings.locale === "en" ? "Save as template" : "存为模板",
        enabled: name !== "web" && desktop.writable,
        click: () => {
          void mutate(() => {
            saveSpaceTemplate(dshHome, name, profile.meta.displayName || name, {
              displayName: profile.meta.displayName || name,
            });
          }).catch(reportError);
        },
      },
      {
        label: t("menu.exportSpace"),
        enabled: name !== "web" && desktop.writable,
        click: () => {
          void mutate(async () => {
            const include = await confirmExportIncludeConfig(profile.meta.displayName || name);
            if (include === null) return;
            await exportSpaceShare(name, include);
          }).catch(reportError);
        },
      },
      { label: currentSettings.locale === "en" ? "Diagnostics" : "诊断", click: () => uiCommand({ type: "diagnostics", name }) },
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
    handle("restoreConfigBackup", async () => {
      throw new Error("Configuration restore is not supported.");
    });
    handle("getMaintenance", () => maintenanceView());
    handle("getRuntimeCatalog", () => runtimes.catalog());
    handle("previewUpgrade", (_event, version: string) => upgrades.preview(version));
    handle("upgradeRuntime", (_event, version: string) => {
      assertAvailable();
      return runMaintenance("upgrade", async () => {
        await upgrades.upgrade(version);
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
    handle("restoreSnapshot", async () => {
      throw new Error("Snapshot restore is not supported.");
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
      const meta = registry.updateMeta(name, patch);
      broadcast("profile-status", { name, status: processes.statusOf(name), port: processes.portOf(name) });
      tray?.refresh();
      return meta;
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
    handle("exportSpaceShare", async (_event, name: string, includeConfig?: boolean) => {
      assertAvailable();
      return exportSpaceShare(name, includeConfig === true);
    });
    handle("importSpaceShare", async () => {
      assertAvailable();
      return importSpaceShare();
    });
    handle("listSpaceTemplates", () => listSpaceTemplates(dshHome));
    handle("createSpaceFromTemplate", async (_event, templateId: string) => {
      assertAvailable();
      const template = listSpaceTemplates(dshHome).find((row) => row.id === templateId);
      if (!template) throw new Error("That template was not found.");
      const name = uniqueSpaceName(template.displayName, listProfiles().map((row) => row.name));
      return createSpaceFromTemplate(template, name, {
        createSpace: async (input) => {
          await createProfile(dshHome, registry, patchWriter, input.name, input.displayName);
        },
        installPlugin: async (spaceId, spec) => {
          desktop.assertDesktopPluginMutation([spaceId], spec);
          await pluginAdd(dshHome, spaceId, spec);
        },
      });
    });
    handle(
      "createProfile",
      async (
        _event,
        name: string,
        displayName: string | undefined,
        icon: string | undefined,
        useSharedLlm?: boolean,
      ) => {
        desktop.assertMutableProfile(name, "create");
        await createProfile(dshHome, registry, patchWriter, name, displayName, (progress) => {
          broadcast("create-progress", progress);
        });
        if (icon) registry.updateMeta(name, { icon: sanitizeSpaceIcon(icon) });
        if (useSharedLlm === true) {
          await desktopLlm.llm({
            method: "updateSpacePolicy",
            spaceId: name,
            shared: { mode: "all" },
            expectedRevision: 0,
          });
        }
        return listProfiles();
      },
    );
    handle("llm", (_event, request: LlmApiRequest) => desktopLlm.llm(request));
    handle("llmCredential", (_event, request: LlmCredentialRequest) => desktopLlm.llmCredential(request));
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
    if (desktop.held) {
      await desktop.admitWrites();
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
