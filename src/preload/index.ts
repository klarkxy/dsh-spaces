import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_SHELL_IPC,
  type DesktopShellApi,
  type DesktopShellPreferencePatch,
  type DesktopShellPublicState,
} from "../shared/desktop-shell";

const api: DesktopShellApi = {
  platform: process.platform,
  getState: (): Promise<DesktopShellPublicState> => ipcRenderer.invoke(DESKTOP_SHELL_IPC.getState),
  prepareEnvironment: (): Promise<DesktopShellPublicState> =>
    ipcRenderer.invoke(DESKTOP_SHELL_IPC.prepareEnvironment),
  startService: (): Promise<DesktopShellPublicState> => ipcRenderer.invoke(DESKTOP_SHELL_IPC.startService),
  setPreference: (patch: DesktopShellPreferencePatch): Promise<DesktopShellPublicState> =>
    ipcRenderer.invoke(DESKTOP_SHELL_IPC.setPreference, patch),
  windowMinimize: (): Promise<void> => ipcRenderer.invoke(DESKTOP_SHELL_IPC.windowMinimize),
  windowToggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(DESKTOP_SHELL_IPC.windowToggleMaximize),
  windowClose: (): Promise<void> => ipcRenderer.invoke(DESKTOP_SHELL_IPC.windowClose),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke(DESKTOP_SHELL_IPC.windowIsMaximized),
  onState: (listener: (state: DesktopShellPublicState) => void): (() => void) => {
    const handler = (_event: unknown, state: DesktopShellPublicState) => listener(state);
    ipcRenderer.on(DESKTOP_SHELL_IPC.stateEvent, handler);
    return () => ipcRenderer.off(DESKTOP_SHELL_IPC.stateEvent, handler);
  },
  onWindowMaximized: (listener: (maximized: boolean) => void): (() => void) => {
    const handler = (_event: unknown, maximized: boolean) => listener(maximized);
    ipcRenderer.on(DESKTOP_SHELL_IPC.windowMaximizedEvent, handler);
    return () => ipcRenderer.off(DESKTOP_SHELL_IPC.windowMaximizedEvent, handler);
  },
};

contextBridge.exposeInMainWorld("dshSpaces", api);

export type { DesktopShellApi };
