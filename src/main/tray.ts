import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../shared/i18n";
import type { ProfileStatus } from "../shared/types";

export interface TraySpace {
  name: string;
  displayName: string;
  status: ProfileStatus;
}

export type TrayMenuItem =
  | { type: "separator"; id?: undefined; label?: undefined; enabled?: undefined }
  | { type?: undefined; id: "show" | "stop-all" | "quit"; label: string; enabled?: boolean }
  | { type?: undefined; id: `space:${string}`; label: string; enabled: false };

export interface TrayHandle {
  available: boolean;
  refresh: () => void;
  destroy: () => void;
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
  onQuit: () => void;
}

const TRAY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFRElEQVR4nO1WeXATZRTf79tNm6Rpm6Qlpo1USw8ugdraVhA5VI5WLDLoIKgVLDoeo2MLRRkPsHLIOBwCArWIgIJ4MMKMDCqKKLWKpS3QSJsObShH7yttjibZ/dZ5m90Y0pZmxuEPZ/pmdnb32/fe977f+733lqKGZEj+t4IxRjSm4fJdFt4RQoG6QYMqSA55EIpHGGHhmSPczQ09Nv6+BrXzCsb4ZicJ1g8zqCcmT9dMSZ+FGEYm6GKME99/o0geEz0CdBBDMxJSA/li+vUOyoQQeAxLGTcJNlKNTbybUYdprUZTOWygue+eB2lVSNiVbXvXWM5U/MqzrFumCY/UP/HIUqwIVpqWrV0Ma+BDgiE8dfzk7oqLZ6T1/gMQoVPEDk+MW/XaFu20ezN8P0Mw3hdCiOWvc78Rp6sXTgoBcjaHVTd35iLV6IQJVa+uWkgcvXZ5jCEuatHc5yNnTZlXMiFDy/ZYLdI+qA/sPM8HRWpvSz6+9xzcYROe8MQLIeQVgXj4w9rsPXVrti1r+vK7TwCR1FOHamTq8AiA39Xa3kQrlSo6RKEC3Y5Tfx43Lln+MPBI4gLugwDP8yM3vbUPNofoBeKJbBcuhmaEnIocYUJV4YkbVu6Ofmrei5zV1t144Ggh6ADMQcMi9NLmII0HjhT6E5PxZ6h6UsoDmvvTZgrRKeRKb1wsx/Yhk8gVnhAufs3yHYBU/ebdq4IiNbqoJx99AYIAgrrbO1vMG3atbD9x+igE7lsJzA3OKIqKzJg2H6Js+urYHtbS3RmaNCYNCEiHKEOlvAun90kbEt8T1uXvAgJaSs8XQwCIppm6dR/lNx8+vh+CEOxEcnu3pXzzTwhJ+mZncWjS2PTT8VNk0qfgKN3t+gVzcgw5C3IBcjiB0A8oiuq92mg2f1D45p25OasVI2JG+qYS9Moyn0my15j/BiR82e/dlvIT4nI7AWpF7PAEId8MzTgbW67Vb9nzbkXW0rSe81Wlvg0FBcmCNZNTHzLmrMhyd1jaIFXCKRFCwHZXU+t1eOY5ju3DN6qfAHjROCz5roneXAHpGUbmMF+tqczOnSUEAUQjPAGy6h/PXALfTPlrl8A6YTk3INBz7uIZ1mrv7q8r9gkAiZDaa+qMoAw1KxiJl4dQNMNaejqNz+bPcbV1NIONZDdq6+qD2qnps72+EEKtx05+DWhIOjdHgPdE2Fl89icwVk9OmwHNCE4pDRypEoBQptyCpwVooUdgjHVZMxZGZ89/WWguGNMQaMfJkmMe+Afu//hf6D3Npquk7KSj7oqJVspD4gvytnmhE3u6oAeBni490fD5tzs9Nc+xsImQf9DHGF/eVPSOu6OrVRpeASGAMMKk1+m4vLHobViCfpCw/vWPhRMQQpQJsWNSvt9/wbD4sVfge917W/Psly5XCUNHtIf1a0VfbGzYd3h7INMP+74I5UVjGnLXePBIIaxFLcx6bvT2gkMw/WzVtZVYHqyIW527ddxnm3+AkqzMzpvtam5r8JCScJzDae/6o/wXiaSD/RugvisISb0aTg8BwDL0dVt17YWQUXHjZRp1pFCeTa3Xzet3rGCttu74grztcoP+DsmNvba+GsqWszusEsKBBQAijBpPmwW4h7+UvTJIFxFFDSBAuPoPPy2wmWorYXyDnbXSVNb5+9mf+2s+gf8RIU/9yiI0Ou30iZlwyQ36GKgOV0t7o7O5tcFqrClvOfrjQVtVpfPUrRDk988HwoSp1DfMA1HPOy2liRmIfyogLYQEh9CQgFi+pQl8gTW/IXNrBYkcGZIhof67/ANOZr2YakzbGAAAAABJRU5ErkJggg==";

/** Official DSH whale, 32×32 PNG. No image-generation dependency at runtime. */
export function trayIconPng(): Buffer {
  return Buffer.from(TRAY_PNG_BASE64, "base64");
}

/** Larger whale for the window / taskbar. Falls back to the tray PNG. */
export function appIconPng(): Buffer {
  const file = join(process.cwd(), "resources", "icon.png");
  if (existsSync(file)) return readFileSync(file);
  return trayIconPng();
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
