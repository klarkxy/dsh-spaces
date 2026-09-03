import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAppLocale, t } from "../shared/i18n";
import { WINDOW_BG } from "../shared/theme";
import type { HubSettings, PackageSource, PluginInstallRequest, SpaceMeta } from "../shared/types";
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
} from "./dsh-cli";
import { readSettings, writeSettings } from "./hub-settings";
import { applyNativeTheme, currentColorScheme } from "./native-theme";
import { setPackageSource, setToolchainRoot } from "./toolchain";
import { confirmOnboarding } from "./onboarding";
import { PatchWriter } from "./patch-writer";
import { ProcessManager } from "./process-manager";
import { ProfileRegistry } from "./profile-registry";
import { smokeLifecycle } from "./smoke";
import { startAutoUpdate } from "./updater";
import { ViewManager } from "./view-manager";
import { loadPluginCatalog } from "./plugin-catalog";
import {
  installPluginToProfiles,
  listAllProfilePlugins,
  listProfilePlugins,
  pluginRemove,
  resolveInstallSpec,
} from "./plugin-ops";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dshHome = resolveDshHome();
const registry = new ProfileRegistry(dshHome);
const patchWriter = new PatchWriter(dshHome);
const settings = readSettings(dshHome);
applyAppLocale(settings.locale);
applyNativeTheme(settings.theme);
const processes = new ProcessManager(dshHome, patchWriter, settings.portStart, settings.portEnd);

let mainWindow: BrowserWindow | null = null;
let views: ViewManager | null = null;
let currentSettings = settings;
let quitting = false;

if (process.platform === "win32") {
  app.setAppUserModelId("dev.dshspaces.app");
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

  return win;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function uiCommand(payload: unknown): void {
  mainWindow?.webContents.send("ui-command", payload);
}

function listProfiles() {
  return registry.scan().map((profile) => ({
    ...profile,
    status: processes.statusOf(profile.name),
    port: processes.portOf(profile.name),
    lastError: processes.lastError(profile.name),
  }));
}

async function startAndShow(name: string): Promise<{ port: number }> {
  const { port } = await processes.start(name);
  views?.select(name, port);
  return { port };
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
          uiCommand({ type: "error", message: err instanceof Error ? err.message : String(err) });
        });
      },
    },
    {
      label: t("menu.restart"),
      enabled: running || crashed,
      click: () => {
        views?.destroy(name);
        void processes
          .restart(name)
          .then(({ port }) => views?.select(name, port))
          .catch((err: unknown) => {
            uiCommand({ type: "error", message: err instanceof Error ? err.message : String(err) });
          });
      },
    },
    {
      label: t("menu.stop"),
      enabled: running || starting,
      click: () => {
        views?.destroy(name);
        void processes.stop(name);
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
  ipcMain.handle("listProfiles", () => listProfiles());
  ipcMain.handle("getDshHome", () => dshHome);
  ipcMain.handle("getOnboarding", () => registry.scanOnboarding());
  ipcMain.handle("confirmOnboarding", async () => confirmOnboarding(dshHome, registry, patchWriter));
  ipcMain.handle("getSettings", () => currentSettings);
  ipcMain.handle("saveSettings", (_event, next: HubSettings) => {
    currentSettings = writeSettings(dshHome, next);
    applyAppLocale(currentSettings.locale);
    applyNativeTheme(currentSettings.theme);
    processes.setPortRange(currentSettings.portStart, currentSettings.portEnd);
    setPackageSource(currentSettings.packageSource);
    return currentSettings;
  });
  ipcMain.handle("getPluginQueue", () => pluginQueueSnapshot());
  ipcMain.handle(
    "getPluginCatalog",
    (_event, options: { refresh?: boolean; url?: string } = {}) =>
      loadPluginCatalog(dshHome, {
        refresh: options.refresh,
        url: options.url || currentSettings.catalogUrl,
      }),
  );
  ipcMain.handle("listProfilePlugins", (_event, name: string) => listProfilePlugins(dshHome, name));
  ipcMain.handle("listAllProfilePlugins", () =>
    listAllProfilePlugins(
      dshHome,
      listProfiles().map((profile) => profile.name),
    ),
  );
  ipcMain.handle("installPlugin", async (_event, request: PluginInstallRequest) => {
    const spec = await resolveInstallSpec(dshHome, request);
    return installPluginToProfiles(dshHome, request.profiles ?? [], spec, (name) => {
      const status = processes.statusOf(name);
      return status === "running" || status === "starting";
    });
  });
  ipcMain.handle("removePlugin", async (_event, profile: string, packageName: string) => {
    await pluginRemove(dshHome, profile, packageName);
    const status = processes.statusOf(profile);
    return { running: status === "running" || status === "starting" ? [profile] : [] };
  });
  ipcMain.handle("getCliStatus", () => cliStatusSnapshot());
  ipcMain.handle("getRuntimeStatus", () => getRuntimeStatus());
  ipcMain.handle("ensureCli", (_event, source?: PackageSource) => {
    const next = source ?? currentSettings.packageSource;
    currentSettings = writeSettings(dshHome, { ...currentSettings, packageSource: next });
    return ensureRuntime(next);
  });
  ipcMain.handle("startProfile", async (_event, name: string) => startAndShow(name));
  ipcMain.handle("stopProfile", async (_event, name: string) => {
    views?.destroy(name);
    await processes.stop(name);
  });
  ipcMain.handle("restartProfile", async (_event, name: string) => {
    views?.destroy(name);
    const { port } = await processes.restart(name);
    views?.select(name, port);
    return { port };
  });
  ipcMain.handle("selectProfile", async (_event, name: string) => {
    const port = processes.portOf(name);
    if (port === undefined) {
      return startAndShow(name);
    }
    views?.select(name, port);
    return { port };
  });
  ipcMain.handle("updateMeta", (_event, name: string, patch: Partial<SpaceMeta>) =>
    registry.updateMeta(name, patch),
  );
  ipcMain.handle("reorderProfiles", (_event, names: string[]) => {
    registry.reorder(names);
    return listProfiles();
  });
  ipcMain.handle(
    "deleteProfile",
    async (_event, name: string, options: { deleteOfficial?: boolean } = {}) => {
      if (name === "web") throw new Error(t("errors.cannotDeleteWeb"));
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
  ipcMain.handle("openProfileDir", async (_event, name: string) => {
    const profile = listProfiles().find((item) => item.name === name);
    if (!profile) throw new Error(t("errors.unknownProfile", { name }));
    const error = await shell.openPath(profile.path);
    if (error) throw new Error(error);
  });
  ipcMain.handle("showProfileMenu", (_event, name: string) => {
    popupProfileMenu(name);
  });
  ipcMain.handle(
    "createProfile",
    async (_event, name: string, displayName: string | undefined, icon: string | undefined) => {
      await createProfile(dshHome, registry, patchWriter, name, displayName, (progress) => {
        broadcast("create-progress", progress);
      });
      if (icon) registry.updateMeta(name, { icon });
      return listProfiles();
    },
  );
  ipcMain.handle("setOverlayOpen", (_event, open: boolean) => {
    views?.setOverlayOpen(open);
  });
  ipcMain.handle("showRailTip", (_event, text: string, top: number) => {
    views?.showTooltip(text, top);
  });
  ipcMain.handle("hideRailTip", () => {
    views?.hideTooltip();
  });
  ipcMain.handle("windowMinimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("windowToggleMaximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("windowClose", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle("windowIsMaximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
}

processes.onStatus((name, status, extra) => {
  if (status === "crashed" || status === "stopped") {
    views?.destroy(name);
  }
  broadcast("profile-status", { name, status, ...extra });
});

onPluginQueue((snap) => broadcast("plugin-queue", snap));
onCliStatus((status) => broadcast("cli-status", status));
nativeTheme.on("updated", () => {
  applyNativeTheme(currentSettings.theme);
});

void app.whenReady().then(async () => {
  setManagedCliPrefix(join(app.getPath("userData"), "dsh-cli"));
  setToolchainRoot(join(app.getPath("userData"), "toolchain"));
  setPackageSource(currentSettings.packageSource);
  registerIpc();
  if (process.env.DSH_SPACES_SMOKE === "1") {
    try {
      await ensureRuntime(currentSettings.packageSource);
      await smokeLifecycle(processes);
      console.log("SMOKE: PASS");
      quitting = true;
      app.exit(0);
    } catch (err) {
      console.error("SMOKE: FAIL", err);
      quitting = true;
      app.exit(1);
    }
    return;
  }
  startAutoUpdate();
  mainWindow = createWindow();
  views = new ViewManager(mainWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      views = new ViewManager(mainWindow);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (currentSettings.quitBehavior === "keep") return;
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void processes.stopAll().finally(() => {
    app.exit(0);
  });
});
