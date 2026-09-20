import { BrowserWindow, WebContentsView, shell, type Session } from "electron";
import {
  consumeBootstrapIfNeeded,
  decideWindowOpen,
  decideWorkbenchNavigation,
  redactDesktopShellText,
} from "../shared/desktop-shell";
import { TITLEBAR_HEIGHT } from "../shared/layout";

export { TITLEBAR_HEIGHT };

export interface WorkbenchViewPresent {
  entryUrl: string;
  managerOrigin: string;
  onError: (message: string) => void;
}

export class ViewManager {
  private view: WebContentsView | null = null;
  private overlayOpen = false;
  private managerOrigin: string | null = null;
  private bootstrapUrl: string | null = null;
  private bootstrapConsumed = false;
  private onError: ((message: string) => void) | null = null;
  private closed = false;
  private readonly workbenchSession: Session;

  constructor(
    private readonly window: BrowserWindow,
    workbenchSession: Session,
  ) {
    this.workbenchSession = workbenchSession;
    hardenSession(this.workbenchSession);
    this.window.on("resize", () => this.layout());
    this.window.on("show", () => this.layout());
    this.window.on("restore", () => this.layout());
    this.window.on("focus", () => this.focusView());
  }

  presentWorkbench(input: WorkbenchViewPresent): void {
    if (this.closed) return;
    this.destroyView();
    this.managerOrigin = input.managerOrigin;
    this.bootstrapUrl = input.entryUrl;
    this.bootstrapConsumed = false;
    this.onError = input.onError;
    this.overlayOpen = false;

    const view = new WebContentsView({
      webPreferences: {
        session: this.workbenchSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        webSecurity: true,
        navigateOnDragDrop: false,
      },
    });
    this.view = view;
    this.window.contentView.addChildView(view);
    this.attachGuards(view);
    this.layout();
    void view.webContents.loadURL(input.entryUrl);
  }

  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open;
    this.layout();
  }

  focusView(): void {
    if (this.overlayOpen || !this.view) return;
    if (this.window.isDestroyed()) return;
    this.view.webContents.focus();
  }

  destroy(): void {
    this.closed = true;
    this.destroyView();
    this.onError = null;
  }

  private destroyView(): void {
    const view = this.view;
    this.view = null;
    this.managerOrigin = null;
    this.bootstrapUrl = null;
    this.bootstrapConsumed = false;
    if (!view) return;
    try {
      this.window.contentView.removeChildView(view);
    } catch {
      /* window may already be gone */
    }
    view.webContents.close();
  }

  private attachGuards(view: WebContentsView): void {
    const contents = view.webContents;
    contents.setVisualZoomLevelLimits(1, 3);
    contents.setWindowOpenHandler((details) => {
      const decision = decideWindowOpen({
        url: details.url,
        userInitiated: isUserNavigation(details.disposition),
      });
      if ("openExternal" in decision) {
        void shell.openExternal(details.url);
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!this.allowTopLevel(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!this.allowTopLevel(url)) event.preventDefault();
    });
    contents.on("will-frame-navigate", (event) => {
      if (event.isMainFrame) {
        if (!this.allowTopLevel(event.url)) event.preventDefault();
        return;
      }
      if (!this.managerOrigin) {
        event.preventDefault();
        return;
      }
      const nested = decideWorkbenchNavigation({
        url: event.url,
        managerOrigin: this.managerOrigin,
        bootstrapUrl: this.bootstrapUrl,
        bootstrapConsumed: this.bootstrapConsumed,
        isTopLevel: false,
      });
      if (!nested.allow) event.preventDefault();
    });
    contents.on("did-navigate", (_event, url) => {
      this.markConsumed(url);
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      this.markConsumed(url);
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      this.reportError(errorDescription || `Load failed (${errorCode})`);
    });
    contents.on("render-process-gone", (_event, details) => {
      this.reportError(details.reason || "The workbench page stopped.");
    });
    contents.on("unresponsive", () => {
      this.reportError("The workbench page stopped responding.");
    });
  }

  private allowTopLevel(url: string): boolean {
    if (!this.managerOrigin) return false;
    const decision = decideWorkbenchNavigation({
      url,
      managerOrigin: this.managerOrigin,
      bootstrapUrl: this.bootstrapUrl,
      bootstrapConsumed: this.bootstrapConsumed,
      isTopLevel: true,
    });
    if (decision.allow) {
      this.markConsumed(url);
      return true;
    }
    return false;
  }

  private markConsumed(url: string): void {
    if (!this.managerOrigin) return;
    if (
      consumeBootstrapIfNeeded({
        url,
        managerOrigin: this.managerOrigin,
        bootstrapUrl: this.bootstrapUrl,
        bootstrapConsumed: this.bootstrapConsumed,
      })
    ) {
      this.bootstrapConsumed = true;
    }
  }

  private reportError(message: string): void {
    this.overlayOpen = true;
    this.layout();
    this.onError?.(redactDesktopShellText(message));
  }

  private layout(): void {
    if (!this.view || this.window.isDestroyed()) return;
    const bounds = this.window.getContentBounds();
    const visible = !this.overlayOpen;
    this.view.setVisible(visible);
    if (!visible) return;
    this.view.setBounds({
      x: 0,
      y: TITLEBAR_HEIGHT,
      width: Math.max(0, bounds.width),
      height: Math.max(0, bounds.height - TITLEBAR_HEIGHT),
    });
  }
}

function hardenSession(target: Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
}

function isUserNavigation(disposition: string): boolean {
  return disposition === "foreground-tab" || disposition === "new-window" || disposition === "default";
}
