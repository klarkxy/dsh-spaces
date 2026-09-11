import { app } from "electron";
import updater from "electron-updater";

const { autoUpdater } = updater;

export function startAutoUpdate(): void {
  if (!app.isPackaged || process.env.DSH_SPACES_DISABLE_UPDATES === "1") return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  void autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
    console.warn("[updater]", err instanceof Error ? err.message : String(err));
  });
}
