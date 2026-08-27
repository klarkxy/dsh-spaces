import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HubSettings, SpaceMeta } from "../shared/types";
import { createProfile } from "./create-profile";
import { resolveDshHome } from "./dsh-home";
import { onPluginQueue, pluginQueueSnapshot } from "./dsh-cli";
import { readSettings, writeSettings } from "./hub-settings";
import { confirmOnboarding } from "./onboarding";
import { PatchWriter } from "./patch-writer";
import { ProcessManager } from "./process-manager";
import { ProfileRegistry } from "./profile-registry";
import { smokeLifecycle } from "./smoke";
import { startAutoUpdate } from "./updater";
import { ViewManager } from "./view-manager";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dshHome = resolveDshHome();
const registry = new ProfileRegistry(dshHome);
const patchWriter = new PatchWriter(dshHome);
const settings = readSettings(dshHome);
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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: "DSH Spaces",
    backgroundColor: "#1e1f22",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

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
      label: running || starting ? "Already running" : "Start",
      enabled: !running && !starting,
      click: () => {
        void startAndShow(name).catch((err: unknown) => {
          uiCommand({ type: "error", message: err instanceof Error ? err.message : String(err) });
        });
      },
    },
    {
      label: "Restart",
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
      label: "Stop",
      enabled: running || starting,
      click: () => {
        views?.destroy(name);
        void processes.stop(name);
      },
    },
    { type: "separator" },
    {
      label: "Rename",
      click: () => uiCommand({ type: "rename", name }),
    },
    {
      label: "Change icon",
      click: () => uiCommand({ type: "icon", name }),
    },
    {
      label: "Open profile folder",
      click: () => {
        void shell.openPath(profile.path);
      },
    },
    { type: "separator" },
    {
      label: name === "web" ? "Delete (disabled)" : "Delete…",
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
    processes.setPortRange(currentSettings.portStart, currentSettings.portEnd);
    return currentSettings;
  });
  ipcMain.handle("getPluginQueue", () => pluginQueueSnapshot());
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
      if (name === "web") throw new Error("cannot delete web");
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
    if (!profile) throw new Error(`unknown profile ${name}`);
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
  ipcMain.handle("setRailGutter", (_event, width: number) => {
    views?.setGutter(width);
  });
}

processes.onStatus((name, status, extra) => {
  if (status === "crashed" || status === "stopped") {
    views?.destroy(name);
  }
  broadcast("profile-status", { name, status, ...extra });
});

onPluginQueue((snap) => broadcast("plugin-queue", snap));

void app.whenReady().then(async () => {
  registerIpc();
  if (process.env.DSH_SPACES_SMOKE === "1") {
    try {
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
