/** Renderer-safe desktop Home control DTO. Never carry pid, nonce, path or token. */

export type DesktopControllerKind = "desktop" | "web";

export interface DesktopControllerState {
  ownerKind: DesktopControllerKind | null;
  /** True while this desktop process holds the Home lease, including recovery. */
  held: boolean;
  writable: boolean;
  recoveryRequired: boolean;
  reasons: string[];
  transferPending: boolean;
}

export interface DesktopReleaseSpace {
  name: string;
  displayName: string;
  status: string;
}

export const DESKTOP_CONTROLLER_IPC = {
  get: "getControllerState",
  acquire: "acquireController",
  release: "releaseController",
  previewRelease: "previewControllerRelease",
  event: "controller-status",
} as const;

export const FULL_SPACES_PACKAGE = "@dsh-spaces/plugin";

export const DESKTOP_WRITE_IPC_CHANNELS = [
  "confirmOnboarding",
  "saveSettings",
  "installPlugin",
  "removePlugin",
  "downloadPlugin",
  "removeLibraryPlugin",
  "setSpacePlugin",
  "ensureCli",
  "startProfile",
  "stopProfile",
  "restartProfile",
  "updateMeta",
  "reorderProfiles",
  "deleteProfile",
  "createProfile",
  "restoreConfigBackup",
  "upgradeRuntime",
  "installRuntimeVersion",
  "createSnapshot",
  "restoreSnapshot",
  "deleteSnapshot",
] as const;

export type DesktopWriteIpcChannel = (typeof DESKTOP_WRITE_IPC_CHANNELS)[number];

export const DESKTOP_MUTATE_IPC_CHANNELS = [
  "confirmOnboarding",
  "saveSettings",
  "installPlugin",
  "removePlugin",
  "downloadPlugin",
  "removeLibraryPlugin",
  "setSpacePlugin",
  "ensureCli",
  "stopProfile",
  "restartProfile",
  "updateMeta",
  "reorderProfiles",
  "deleteProfile",
  "createProfile",
] as const;

const WRITE_CHANNEL_SET = new Set<string>(DESKTOP_WRITE_IPC_CHANNELS);

export function isDesktopWriteIpcChannel(channel: string): boolean {
  return WRITE_CHANNEL_SET.has(channel);
}

export function isDesktopMutateIpcChannel(channel: string): boolean {
  return (DESKTOP_MUTATE_IPC_CHANNELS as readonly string[]).includes(channel);
}

export function idleDesktopControllerState(): DesktopControllerState {
  return {
    ownerKind: null,
    held: false,
    writable: false,
    recoveryRequired: false,
    reasons: [],
    transferPending: false,
  };
}

/** Auto-start only after a writable owner is known. Null means state has not loaded. */
export function shouldDesktopAutoLaunch(state: DesktopControllerState | null): boolean {
  return Boolean(state?.writable && !state.recoveryRequired && !state.transferPending);
}

export type DesktopSelectAccess = "attach" | "start" | "deny";

export function desktopSelectAccess(writable: boolean, running: boolean): DesktopSelectAccess {
  if (running) return "attach";
  if (writable) return "start";
  return "deny";
}

export function isFullSpacesManagerSpec(spec: string): boolean {
  const value = spec.trim().toLowerCase();
  if (!value) return false;
  if (value === FULL_SPACES_PACKAGE) return true;
  if (value.startsWith(`${FULL_SPACES_PACKAGE}@`)) return true;
  if (/(^|\/)@dsh-spaces\/plugin(\b|@)/.test(value)) return true;
  if (value.startsWith("npm:") && value.includes("@dsh-spaces/plugin")) return true;
  if (value.startsWith("node:") && value.includes("@dsh-spaces/plugin")) return true;
  return false;
}

export function isUnresolvedPluginAlias(spec: string): boolean {
  const value = spec.trim().toLowerCase();
  return value.startsWith("npm:") || value.startsWith("node:") || value.startsWith("file:");
}
