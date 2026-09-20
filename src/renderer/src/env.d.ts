import type { DesktopShellApi } from "@shared/desktop-shell";

declare global {
  interface Window {
    dshSpaces: DesktopShellApi;
  }
}

export {};
