import { APP_PNG_BASE64, TRAY_PNG_BASE64 } from "./brand-icons";
import { t } from "../shared/i18n";
import type { ProfileStatus } from "../shared/types";

export interface TraySpace {
  name: string;
  displayName: string;
  status: ProfileStatus;
}

export type TrayMenuItem =
  | { type: "separator"; id?: undefined; label?: undefined; enabled?: undefined }
  | { type?: undefined; id: "show" | "stop-all" | "stop-service" | "quit"; label: string; enabled?: boolean }
  | { type?: undefined; id: `space:${string}`; label: string; enabled: false };

export interface TrayHandle {
  available: boolean;
  refresh: () => void;
  destroy: () => void;
}

/** Minimal window surface used to hide to the tray without remaining on the taskbar. */
export interface TrayWindow {
  isDestroyed?: () => boolean;
  isMinimized?: () => boolean;
  restore?: () => void;
  setSkipTaskbar: (skip: boolean) => void;
  hide: () => void;
  show: () => void;
  focus: () => void;
}

/** Close must leave the taskbar. hide() alone still looks like minimize on Windows. */
export function concealWindowToTray(win: TrayWindow): void {
  win.setSkipTaskbar(true);
  win.hide();
}

export function revealWindowFromTray(win: TrayWindow): void {
  if (win.isDestroyed?.()) return;
  win.setSkipTaskbar(false);
  if (win.isMinimized?.()) win.restore?.();
  win.show();
  win.focus();
}

type TrayIcon = {
  isEmpty?: () => boolean;
};

type TrayInstance = {
  setToolTip: (text: string) => void;
  setContextMenu: (menu: unknown) => void;
  on: (event: "click", listener: () => void) => void;
  destroy: () => void;
};

export interface TrayElectron {
  Tray: {
    isSupported?: () => boolean;
    new (image: TrayIcon): TrayInstance;
  };
  Menu: {
    buildFromTemplate: (
      template: Array<{
        type?: "separator" | "normal";
        id?: string;
        label?: string;
        enabled?: boolean;
        click?: () => void;
      }>,
    ) => unknown;
  };
  nativeImage: {
    createFromBuffer: (buffer: Buffer) => TrayIcon;
  };
}

export interface TrayCallbacks {
  getSpaces: () => TraySpace[];
  onShow: () => void;
  onStopAll: () => void;
  onStopService?: () => void;
  onQuit: () => void;
}

/** Spaces artwork, 32×32 PNG. No image-generation dependency at runtime. */
export function trayIconPng(): Buffer {
  return Buffer.from(TRAY_PNG_BASE64, "base64");
}

/** Bundled 256×256 artwork for the window and taskbar, independent of cwd. */
export function appIconPng(): Buffer {
  return Buffer.from(APP_PNG_BASE64, "base64");
}

export function spaceStatusLabel(space: TraySpace): string {
  const name = space.displayName || space.name;
  if (space.status === "running") return t("tray.running", { name });
  if (space.status === "starting") return t("tray.starting", { name });
  if (space.status === "crashed") return t("tray.crashed", { name });
  return t("tray.stopped", { name });
}

export function buildTrayMenuItems(spaces: TraySpace[]): TrayMenuItem[] {
  const items: TrayMenuItem[] = [{ id: "show", label: t("tray.show") }];
  if (spaces.length > 0) {
    items.push({ type: "separator" });
    for (const space of spaces) {
      items.push({ id: `space:${space.name}`, label: spaceStatusLabel(space), enabled: false });
    }
  }
  items.push({ type: "separator" });
  items.push({ id: "stop-all", label: t("tray.stopAll") });
  items.push({ id: "stop-service", label: t("tray.stopService") });
  items.push({ id: "quit", label: t("tray.quit") });
  return items;
}

export function createAppTray(electron: TrayElectron, callbacks: TrayCallbacks): TrayHandle {
  const unavailable: TrayHandle = { available: false, refresh() {}, destroy() {} };
  try {
    if (electron.Tray.isSupported && !electron.Tray.isSupported()) return unavailable;

    const image = electron.nativeImage.createFromBuffer(trayIconPng());
    if (image.isEmpty?.()) return unavailable;

    const tray = new electron.Tray(image);
    tray.setToolTip("DSH Spaces");
    tray.on("click", () => callbacks.onShow());

    const refresh = () => {
      const template = buildTrayMenuItems(callbacks.getSpaces()).map((item) => {
        if (item.type === "separator") return { type: "separator" as const };
        const click =
          item.id === "show"
            ? () => callbacks.onShow()
            : item.id === "stop-all"
              ? () => callbacks.onStopAll()
              : item.id === "stop-service"
                ? () => callbacks.onStopService?.()
                : item.id === "quit"
                  ? () => callbacks.onQuit()
                  : undefined;
        return {
          type: "normal" as const,
          id: item.id,
          label: item.label,
          enabled: item.enabled !== false,
          click,
        };
      });
      tray.setContextMenu(electron.Menu.buildFromTemplate(template));
    };

    refresh();
    return {
      available: true,
      refresh,
      destroy: () => tray.destroy(),
    };
  } catch {
    return unavailable;
  }
}
