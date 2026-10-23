/**
 * The browser environment of the workbench client.
 *
 * The default host bindings were the head of `workbench/store.ts`. They move
 * here unchanged: the controller only talks to the environment through this
 * interface, so a test can replace it without touching the client.
 */

import { defaultStorage } from "../persistence";
import type { WorkbenchEnv } from "./types";

function defaultOpenUrl(url: string): void {
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function defaultWriteClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clipboard?.writeText) throw new Error("clipboard");
  await clipboard.writeText(text);
}

function defaultDownloadFile(fileName: string, archiveBase64: string): void {
  if (typeof document === "undefined" || typeof atob !== "function") return;
  const binary = atob(archiveBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function createDefaultEnv(): WorkbenchEnv {
  return {
    uuid: () => crypto.randomUUID(),
    storage: defaultStorage(),
    hidden: () => typeof document !== "undefined" && document.hidden,
    onVisibilityChange: (listener) => {
      if (typeof document === "undefined") return () => undefined;
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    handshakeTimeoutMs: 45_000,
    startTimeoutMs: 90_000,
    openUrl: defaultOpenUrl,
    downloadFile: defaultDownloadFile,
    writeClipboard: defaultWriteClipboard,
    addMessageListener: (listener) => {
      if (typeof window === "undefined") return () => undefined;
      const wrapped = (event: MessageEvent) => listener(event);
      window.addEventListener("message", wrapped);
      return () => window.removeEventListener("message", wrapped);
    },
  };
}
