import { contextBridge, ipcRenderer } from "electron";
import type {
  CliEnsureStatus,
  CreateProgress,
  HubSettings,
  OnboardingScan,
  PackageSource,
  InstalledPlugin,
  PluginCatalogSnapshot,
  PluginInstallRequest,
  PluginInstallResult,
  PluginQueueSnapshot,
  ProfileRecord,
  ProfileStatus,
  RuntimeStatus,
  SpaceMeta,
} from "../shared/types";

const api = {
  listProfiles: (): Promise<ProfileRecord[]> => ipcRenderer.invoke("listProfiles"),
  getDshHome: (): Promise<string> => ipcRenderer.invoke("getDshHome"),
  getOnboarding: (): Promise<OnboardingScan> => ipcRenderer.invoke("getOnboarding"),
  confirmOnboarding: (): Promise<OnboardingScan> => ipcRenderer.invoke("confirmOnboarding"),
  getSettings: (): Promise<HubSettings> => ipcRenderer.invoke("getSettings"),
  saveSettings: (settings: HubSettings): Promise<HubSettings> =>
    ipcRenderer.invoke("saveSettings", settings),
  getPluginQueue: (): Promise<PluginQueueSnapshot> => ipcRenderer.invoke("getPluginQueue"),
  getPluginCatalog: (options?: { refresh?: boolean; url?: string }): Promise<PluginCatalogSnapshot> =>
    ipcRenderer.invoke("getPluginCatalog", options ?? {}),
  listProfilePlugins: (name: string): Promise<InstalledPlugin[]> =>
    ipcRenderer.invoke("listProfilePlugins", name),
  listAllProfilePlugins: (): Promise<Record<string, InstalledPlugin[]>> =>
    ipcRenderer.invoke("listAllProfilePlugins"),
  installPlugin: (request: PluginInstallRequest): Promise<PluginInstallResult> =>
    ipcRenderer.invoke("installPlugin", request),
  removePlugin: (profile: string, packageName: string): Promise<PluginInstallResult> =>
    ipcRenderer.invoke("removePlugin", profile, packageName),
  getCliStatus: (): Promise<CliEnsureStatus> => ipcRenderer.invoke("getCliStatus"),
  getRuntimeStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke("getRuntimeStatus"),
  ensureCli: (source?: PackageSource): Promise<string> => ipcRenderer.invoke("ensureCli", source),
  startProfile: (name: string): Promise<{ port: number }> => ipcRenderer.invoke("startProfile", name),
  stopProfile: (name: string): Promise<void> => ipcRenderer.invoke("stopProfile", name),
  restartProfile: (name: string): Promise<{ port: number }> => ipcRenderer.invoke("restartProfile", name),
  selectProfile: (name: string): Promise<{ port: number }> => ipcRenderer.invoke("selectProfile", name),
  createProfile: (name: string, displayName?: string, icon?: string): Promise<ProfileRecord[]> =>
    ipcRenderer.invoke("createProfile", name, displayName, icon),
  updateMeta: (name: string, patch: Partial<SpaceMeta>): Promise<SpaceMeta> =>
    ipcRenderer.invoke("updateMeta", name, patch),
  reorderProfiles: (names: string[]): Promise<ProfileRecord[]> =>
    ipcRenderer.invoke("reorderProfiles", names),
  deleteProfile: (name: string, options?: { deleteOfficial?: boolean }): Promise<ProfileRecord[]> =>
    ipcRenderer.invoke("deleteProfile", name, options),
  openProfileDir: (name: string): Promise<void> => ipcRenderer.invoke("openProfileDir", name),
  showProfileMenu: (name: string): Promise<void> => ipcRenderer.invoke("showProfileMenu", name),
  setOverlayOpen: (open: boolean): Promise<void> => ipcRenderer.invoke("setOverlayOpen", open),
  showRailTip: (text: string, top: number): Promise<void> =>
    ipcRenderer.invoke("showRailTip", text, top),
  hideRailTip: (): Promise<void> => ipcRenderer.invoke("hideRailTip"),
  platform: process.platform,
  windowMinimize: (): Promise<void> => ipcRenderer.invoke("windowMinimize"),
  windowToggleMaximize: (): Promise<boolean> => ipcRenderer.invoke("windowToggleMaximize"),
  windowClose: (): Promise<void> => ipcRenderer.invoke("windowClose"),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke("windowIsMaximized"),
  onWindowMaximized: (listener: (maximized: boolean) => void): (() => void) => {
    const handler = (_event: unknown, maximized: boolean) => listener(maximized);
    ipcRenderer.on("window-maximized", handler);
    return () => ipcRenderer.off("window-maximized", handler);
  },
  onStatus: (
    listener: (payload: { name: string; status: ProfileStatus; port?: number; error?: string }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: { name: string; status: ProfileStatus; port?: number; error?: string },
    ) => listener(payload);
    ipcRenderer.on("profile-status", handler);
    return () => ipcRenderer.off("profile-status", handler);
  },
  onCreateProgress: (listener: (payload: CreateProgress) => void): (() => void) => {
    const handler = (_event: unknown, payload: CreateProgress) => listener(payload);
    ipcRenderer.on("create-progress", handler);
    return () => ipcRenderer.off("create-progress", handler);
  },
  onPluginQueue: (listener: (payload: PluginQueueSnapshot) => void): (() => void) => {
    const handler = (_event: unknown, payload: PluginQueueSnapshot) => listener(payload);
    ipcRenderer.on("plugin-queue", handler);
    return () => ipcRenderer.off("plugin-queue", handler);
  },
  onCliStatus: (listener: (payload: CliEnsureStatus) => void): (() => void) => {
    const handler = (_event: unknown, payload: CliEnsureStatus) => listener(payload);
    ipcRenderer.on("cli-status", handler);
    return () => ipcRenderer.off("cli-status", handler);
  },
  onUiCommand: (
    listener: (payload: { type: string; name?: string; message?: string }) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: { type: string; name?: string; message?: string }) =>
      listener(payload);
    ipcRenderer.on("ui-command", handler);
    return () => ipcRenderer.off("ui-command", handler);
  },
};

contextBridge.exposeInMainWorld("dshSpaces", api);

export type DshSpacesApi = typeof api;
