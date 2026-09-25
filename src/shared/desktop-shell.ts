/** Closed local-shell contract. Ports, paths, bearers and bootstrap URLs stay in main. */
import type { CliEnsureStatus, LocalePreference, PackageSource, ThemePreference } from "./types";

export const DESKTOP_SHELL_PARTITION = "dsh-spaces-workbench";
export const MAX_SHELL_REASONS = 32;
export const MAX_SHELL_REASON_CHARS = 1200;

export const DESKTOP_SHELL_IPC = {
  getState: "desktop-shell:getState",
  prepareEnvironment: "desktop-shell:prepareEnvironment",
  startService: "desktop-shell:startService",
  setPreference: "desktop-shell:setPreference",
  windowMinimize: "desktop-shell:windowMinimize",
  windowToggleMaximize: "desktop-shell:windowToggleMaximize",
  windowClose: "desktop-shell:windowClose",
  windowIsMaximized: "desktop-shell:windowIsMaximized",
  windowMaximizedEvent: "desktop-shell:windowMaximized",
  stateEvent: "desktop-shell:state",
} as const;

export type DesktopShellIpcChannel = (typeof DESKTOP_SHELL_IPC)[keyof typeof DESKTOP_SHELL_IPC];

export const DESKTOP_SHELL_INVOKE_CHANNELS = [
  DESKTOP_SHELL_IPC.getState,
  DESKTOP_SHELL_IPC.prepareEnvironment,
  DESKTOP_SHELL_IPC.startService,
  DESKTOP_SHELL_IPC.setPreference,
  DESKTOP_SHELL_IPC.windowMinimize,
  DESKTOP_SHELL_IPC.windowToggleMaximize,
  DESKTOP_SHELL_IPC.windowClose,
  DESKTOP_SHELL_IPC.windowIsMaximized,
] as const satisfies readonly DesktopShellIpcChannel[];

export const DESKTOP_SHELL_EVENT_CHANNELS = [
  DESKTOP_SHELL_IPC.windowMaximizedEvent,
  DESKTOP_SHELL_IPC.stateEvent,
] as const satisfies readonly DesktopShellIpcChannel[];

export type DesktopShellPhase =
  | "loading"
  | "needs-tools"
  | "tools-ready"
  | "connecting"
  | "connected"
  | "unavailable"
  | "blocked"
  | "workbench-error";

export type DesktopServicePublicStatus = "idle" | "connecting" | "connected" | "stopped" | "unavailable";

export type DesktopStartupStage =
  | "attach"
  | "prepare"
  | "launch"
  | "connect"
  | "load-workbench"
  | "ready";

/** Progress percentages aligned with the official DSH desktop startup phases. */
export const DESKTOP_STARTUP_STAGE_PROGRESS: Record<DesktopStartupStage, number> = {
  attach: 8,
  prepare: 24,
  launch: 56,
  connect: 82,
  "load-workbench": 92,
  ready: 100,
};

export interface DesktopShellRuntimeFlags {
  node: boolean;
  pnpm: boolean;
  cli: boolean;
}

export interface DesktopShellPublicState {
  seq: number;
  phase: DesktopShellPhase;
  serviceStatus: DesktopServicePublicStatus;
  startupStage?: DesktopStartupStage | null;
  reasons: string[];
  workbenchError: string | null;
  runtime: DesktopShellRuntimeFlags;
  cli: CliEnsureStatus;
  locale: LocalePreference;
  theme: ThemePreference;
  packageSource: PackageSource;
  canPrepare: boolean;
  canStart: boolean;
  overlay: boolean;
}

export interface DesktopShellPreferencePatch {
  locale?: LocalePreference;
  theme?: ThemePreference;
  packageSource?: PackageSource;
}

export interface DesktopShellApi {
  platform: string;
  getState(): Promise<DesktopShellPublicState>;
  onState(listener: (state: DesktopShellPublicState) => void): () => void;
  prepareEnvironment(): Promise<DesktopShellPublicState>;
  startService(): Promise<DesktopShellPublicState>;
  setPreference(patch: DesktopShellPreferencePatch): Promise<DesktopShellPublicState>;
  windowMinimize(): Promise<void>;
  windowToggleMaximize(): Promise<boolean>;
  windowClose(): Promise<void>;
  windowIsMaximized(): Promise<boolean>;
  onWindowMaximized(listener: (maximized: boolean) => void): () => void;
}

export type NavigationDecision = { allow: true } | { allow: false; reason: string };

export type WindowOpenDecision = { openExternal: true } | { deny: true; reason: string };

const LOOPBACK_HOST = "127.0.0.1";
const BOOTSTRAP_PREFIX = "/bootstrap/";
const BLOCKED_SCHEMES = new Set(["file:", "javascript:", "data:", "blob:", "about:", "chrome:", "chrome-extension:"]);

export function isDesktopShellInvokeChannel(value: string): boolean {
  return (DESKTOP_SHELL_INVOKE_CHANNELS as readonly string[]).includes(value);
}

export function parsePackageSourceValue(value: unknown): PackageSource | null {
  return value === "china" || value === "official" ? value : null;
}

export function parseLocalePreferenceValue(value: unknown): LocalePreference | null {
  return value === "system" || value === "en" || value === "zh" ? value : null;
}

export function parseThemePreferenceValue(value: unknown): ThemePreference | null {
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

export function parseClientPreferencePatch(value: unknown): DesktopShellPreferencePatch | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (key !== "locale" && key !== "theme" && key !== "packageSource") return null;
  }
  const patch: DesktopShellPreferencePatch = {};
  if ("locale" in row) {
    const locale = parseLocalePreferenceValue(row.locale);
    if (!locale) return null;
    patch.locale = locale;
  }
  if ("theme" in row) {
    const theme = parseThemePreferenceValue(row.theme);
    if (!theme) return null;
    patch.theme = theme;
  }
  if ("packageSource" in row) {
    const packageSource = parsePackageSourceValue(row.packageSource);
    if (!packageSource) return null;
    patch.packageSource = packageSource;
  }
  return patch;
}

export function sameTrustedUrl(actual: string, trusted: string): boolean {
  if (typeof actual !== "string" || typeof trusted !== "string") return false;
  if (actual === trusted) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(actual);
    b = new URL(trusted);
  } catch {
    return false;
  }
  if (a.protocol !== b.protocol) return false;
  if (a.username || a.password || b.username || b.password) return false;
  if (a.search || a.hash || b.search || b.hash) return false;
  if (a.protocol === "http:" || a.protocol === "https:") {
    return a.origin === b.origin && normalizePath(a.pathname) === normalizePath(b.pathname);
  }
  if (a.protocol === "file:") {
    return normalizeFilePath(a.pathname) === normalizeFilePath(b.pathname);
  }
  return false;
}

export function isTrustedShellFrame(input: {
  senderIsShell: boolean;
  isMainFrame: boolean;
  frameUrl: string;
  trustedUrl: string;
}): boolean {
  if (!input.senderIsShell || !input.isMainFrame) return false;
  return sameTrustedUrl(input.frameUrl, input.trustedUrl);
}

export function decideWorkbenchNavigation(input: {
  url: string;
  managerOrigin: string;
  bootstrapUrl: string | null;
  bootstrapConsumed: boolean;
  isTopLevel: boolean;
}): NavigationDecision {
  if (!input.isTopLevel) {
    const nested = inspectHttpUrl(input.url);
    if (!nested.ok) return { allow: false, reason: nested.reason };
    return { allow: true };
  }
  const parsed = inspectHttpUrl(input.url);
  if (!parsed.ok) return { allow: false, reason: parsed.reason };
  const url = parsed.url;
  if (url.origin !== input.managerOrigin) {
    return { allow: false, reason: "Top-level navigation is limited to the verified manager origin." };
  }
  if (isBootstrapPath(url.pathname)) {
    if (input.bootstrapConsumed) {
      return { allow: false, reason: "The bootstrap entry can be used only once." };
    }
    if (!input.bootstrapUrl || !sameTrustedUrl(url.href, input.bootstrapUrl)) {
      return { allow: false, reason: "The bootstrap entry does not match the minted URL." };
    }
    return { allow: true };
  }
  if (!input.bootstrapConsumed && input.bootstrapUrl) {
    const boot = inspectHttpUrl(input.bootstrapUrl);
    if (boot.ok && sameTrustedUrl(url.href, boot.url.href)) return { allow: true };
  }
  return { allow: true };
}

export function consumeBootstrapIfNeeded(input: {
  url: string;
  managerOrigin: string;
  bootstrapUrl: string | null;
  bootstrapConsumed: boolean;
}): boolean {
  if (input.bootstrapConsumed) return true;
  const parsed = inspectHttpUrl(input.url);
  if (!parsed.ok || parsed.url.origin !== input.managerOrigin) return false;
  if (isBootstrapPath(parsed.url.pathname)) return false;
  return true;
}

export function decideWindowOpen(input: { url: string; userInitiated: boolean }): WindowOpenDecision {
  if (!input.userInitiated) return { deny: true, reason: "Popup requires explicit user navigation." };
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { deny: true, reason: "The popup URL is not a valid address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { deny: true, reason: "External windows must use http or https." };
  }
  if (url.username || url.password) return { deny: true, reason: "External windows cannot carry credentials." };
  if (url.hostname === LOOPBACK_HOST || url.hostname === "localhost") {
    return { deny: true, reason: "The manager cannot open extra local windows." };
  }
  return { openExternal: true };
}

export function redactDesktopShellText(text: string, secrets: readonly string[] = []): string {
  let out = text.trim();
  const unique = [...new Set(secrets.filter((item) => item.trim().length >= 3))].sort((a, b) => b.length - a.length);
  for (const secret of unique) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  out = out
    .replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, "Authorization: Bearer [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/(?:[A-Za-z]:\\|\\\\)(?:[^\s"'`<>|\r\n]+(?: (?=[^\s"'`<>|\r\n]*\\)[^\s"'`<>|\r\n]+)*)/g, "[path]")
    .replace(/(?:\/(?:home|Users|tmp|var|root)\/|~\/)[^\s"'`<>]+/g, "[path]");
  if (out.length > MAX_SHELL_REASON_CHARS) {
    const head = 180;
    const tail = MAX_SHELL_REASON_CHARS - head - 1;
    out = `${out.slice(0, head)}…${out.slice(-tail)}`;
  }
  return out;
}

export function publishShellReasons(reasons: readonly string[], secrets: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const reason of reasons) {
    if (typeof reason !== "string" || !reason.trim()) continue;
    const text = redactDesktopShellText(reason, secrets);
    if (text) out.push(text);
    if (out.length >= MAX_SHELL_REASONS) break;
  }
  return out;
}

function inspectHttpUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "The URL is empty." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "The URL is not valid." };
  }
  if (BLOCKED_SCHEMES.has(url.protocol) || url.protocol === "file:" || url.protocol === "javascript:") {
    return { ok: false, reason: `${url.protocol.replace(":", "")} URLs are not allowed.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http(s) loopback manager URLs are allowed." };
  }
  if (url.username || url.password) return { ok: false, reason: "Manager URLs cannot carry credentials." };
  if (url.hostname !== LOOPBACK_HOST) return { ok: false, reason: "The manager origin must be 127.0.0.1." };
  return { ok: true, url };
}

function isBootstrapPath(pathname: string): boolean {
  return pathname.startsWith(BOOTSTRAP_PREFIX);
}

function normalizePath(pathname: string): string {
  if (pathname === "") return "/";
  return pathname;
}

function normalizeFilePath(pathname: string): string {
  let path = decodeURIComponent(pathname);
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return path.replace(/\\/g, "/").toLowerCase();
}
