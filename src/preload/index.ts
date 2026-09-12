import { contextBridge, ipcRenderer } from "electron";
import type { BackupPreview, DiagnosticsSnapshot } from "../shared/diagnostics";
import type { MaintenanceView } from "../shared/maintenance-view";
import type { RuntimeCatalog } from "../shared/runtime";
import type { RestoreSnapshotOptions, SnapshotMeta } from "../shared/snapshots";
import type { UpgradePreview, UpgradeProgress } from "../shared/upgrade";
import type { DesktopControllerState, DesktopReleaseSpace } from "../shared/desktop-controller";
import { DESKTOP_CONTROLLER_IPC } from "../shared/desktop-controller";
import type {
  CliEnsureStatus,
  CreateProgress,
  HubSettings,
  OnboardingScan,
  PackageSource,
  InstalledPlugin,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
  PluginDownloadRequest,
  PluginInstallRequest,
  PluginInstallResult,
  PluginLibraryEntry,
  PluginQueueSnapshot,
  PluginSpaceToggleRequest,
  ProfileRecord,
  ProfileStatus,
  RuntimeStatus,
  SpaceMeta,
} from "../shared/types";

const api = {
  getControllerState: (): Promise<DesktopControllerState> => ipcRenderer.invoke(DESKTOP_CONTROLLER_IPC.get),
  acquireController: (): Promise<DesktopControllerState> => ipcRenderer.invoke(DESKTOP_CONTROLLER_IPC.acquire),
  releaseController: (): Promise<DesktopControllerState> => ipcRenderer.invoke(DESKTOP_CONTROLLER_IPC.release),
  previewControllerRelease: (): Promise<DesktopReleaseSpace[]> =>
    ipcRenderer.invoke(DESKTOP_CONTROLLER_IPC.previewRelease),
  onControllerStatus: (listener: (state: DesktopControllerState) => void): (() => void) => {
    const handler = (_event: unknown, state: DesktopControllerState) => listener(state);
    ipcRenderer.on(DESKTOP_CONTROLLER_IPC.event, handler);
    return () => ipcRenderer.off(DESKTOP_CONTROLLER_IPC.event, handler);
  },
  quitApp: (): Promise<void> => ipcRenderer.invoke("quitApp"),
  previewUpgrade: (version: string): Promise<UpgradePreview> => ipcRenderer.invoke("previewUpgrade", version),
  onMaintenanceProgress: (listener: (progress: UpgradeProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: UpgradeProgress) => listener(progress);
    ipcRenderer.on("maintenance-progress", handler);
    return () => ipcRenderer.off("maintenance-progress", handler);
  },
  getMaintenance: (): Promise<MaintenanceView> => ipcRenderer.invoke("getMaintenance"),
  getRuntimeCatalog: (): Promise<RuntimeCatalog> => ipcRenderer.invoke("getRuntimeCatalog"),
  installRuntimeVersion: (version: string): Promise<void> => ipcRenderer.invoke("installRuntimeVersion", version),
  upgradeRuntime: (version: string): Promise<void> => ipcRenderer.invoke("upgradeRuntime", version),
  createSnapshot: (): Promise<void> => ipcRenderer.invoke("createSnapshot"),
  previewSnapshot: (id: string): Promise<SnapshotMeta> => ipcRenderer.invoke("previewSnapshot", id),
  restoreSnapshot: (id: string, options?: RestoreSnapshotOptions): Promise<void> =>
    ipcRenderer.invoke("restoreSnapshot", id, options),
  deleteSnapshot: (id: string): Promise<void> => ipcRenderer.invoke("deleteSnapshot", id),
  getDiagnostics: (name: string): Promise<DiagnosticsSnapshot> => ipcRenderer.invoke("getDiagnostics", name),
  previewConfigBackup: (name: string, id: string): Promise<BackupPreview> => ipcRenderer.invoke("previewConfigBackup", name, id),
  restoreConfigBackup: (name: string, id: string): Promise<void> => ipcRenderer.invoke("restoreConfigBackup", name, id),
  listProfiles: (): Promise<ProfileRecord[]> => ipcRenderer.invoke("listProfiles"),
  getSelectedProfile: (): Promise<string | null> => ipcRenderer.invoke("getSelectedProfile"),
  getDshHome: (): Promise<string> => ipcRenderer.invoke("getDshHome"),
  getOnboarding: (): Promise<OnboardingScan> => ipcRenderer.invoke("getOnboarding"),
  confirmOnboarding: (): Promise<OnboardingScan> => ipcRenderer.invoke("confirmOnboarding"),
  getSettings: (): Promise<HubSettings> => ipcRenderer.invoke("getSettings"),
  saveSettings: (settings: HubSettings): Promise<HubSettings> =>
    ipcRenderer.invoke("saveSettings", settings),
  getPluginQueue: (): Promise<PluginQueueSnapshot> => ipcRenderer.invoke("getPluginQueue"),
  getPluginCatalog: (options?: { refresh?: boolean; url?: string }): Promise<PluginCatalogSnapshot> =>
    ipcRenderer.invoke("getPluginCatalog", options ?? {}),
  searchPluginCatalog: (query: string): Promise<PluginCatalogEntry[]> =>
    ipcRenderer.invoke("searchPluginCatalog", query),
  listProfilePlugins: (name: string): Promise<InstalledPlugin[]> =>
    ipcRenderer.invoke("listProfilePlugins", name),
  listAllProfilePlugins: (): Promise<Record<string, InstalledPlugin[]>> =>
    ipcRenderer.invoke("listAllProfilePlugins"),
  listPluginLibrary: (): Promise<PluginLibraryEntry[]> => ipcRenderer.invoke("listPluginLibrary"),
  installPlugin: (request: PluginInstallRequest): Promise<PluginInstallResult> =>
    ipcRenderer.invoke("installPlugin", request),
  downloadPlugin: (request: PluginDownloadRequest): Promise<PluginLibraryEntry> =>
    ipcRenderer.invoke("downloadPlugin", request),
  removeLibraryPlugin: (id: string): Promise<PluginLibraryEntry[]> =>
    ipcRenderer.invoke("removeLibraryPlugin", id),
  setSpacePlugin: (request: PluginSpaceToggleRequest): Promise<PluginInstallResult> =>
    ipcRenderer.invoke("setSpacePlugin", request),
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
  pickSpaceIcon: (): Promise<string | null> => ipcRenderer.invoke("pickSpaceIcon"),
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
