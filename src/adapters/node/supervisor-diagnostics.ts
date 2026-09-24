import { chmodSync, lstatSync, readFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { atomicWrite } from "./atomic";
import { sanitizeLogText } from "./diagnostics";
import { isInsideRealHome } from "./home-guard";

/** Bootstrap selects this controlled path under toolsRoot; unique file per start. */
export const SUPERVISOR_DIAGNOSTICS_ENV = "DSH_SPACES_SUPERVISOR_DIAGNOSTICS";

export const SUPERVISOR_DIAGNOSTICS_MAX_BYTES = 32 * 1024;
export const SUPERVISOR_DIAGNOSTICS_MAX_EVENTS = 64;
export const SUPERVISOR_DIAGNOSTICS_MAX_REASONS = 32;
export const SUPERVISOR_DIAGNOSTICS_MAX_REASON_CHARS = 500;

export const SUPERVISOR_DIAGNOSTICS_UNAVAILABLE = "Supervisor diagnostics are unavailable.";
export const SUPERVISOR_DIAGNOSTICS_UNREADABLE = "Supervisor diagnostics could not be read.";

const DOCUMENT_VERSION = 1;
const MAX_MESSAGE_CHARS = 2000;
const MAX_SIGNAL_CHARS = 32;
const MAX_TIMESTAMP_CHARS = 40;
const FILE_MODE = 0o600;

export type SupervisorDiagnosticStage =
  | "starting"
  | "ready"
  | "stop"
  | "failure"
  | "launch-failure"
  | "exit";

export interface SupervisorDiagnosticExitInfo {
  exit?: number | null;
  signal?: string | null;
}

export interface SupervisorDiagnosticsReporter {
  recordStarting(): void;
  recordReady(): void;
  recordNormalStop(info?: SupervisorDiagnosticExitInfo): void;
  recordFailure(error: unknown, info?: SupervisorDiagnosticExitInfo): void;
}

interface SupervisorDiagnosticEvent {
  at: string;
  stage: SupervisorDiagnosticStage;
  message?: string;
  exit?: number | null;
  signal?: string | null;
  pid?: number;
}

interface SupervisorDiagnosticDocument {
  version: typeof DOCUMENT_VERSION;
  updatedAt: string;
  stage: SupervisorDiagnosticStage;
  pid?: number;
  exit?: number | null;
  signal?: string | null;
  events: SupervisorDiagnosticEvent[];
}

const STAGES = new Set<SupervisorDiagnosticStage>([
  "starting",
  "ready",
  "stop",
  "failure",
  "launch-failure",
  "exit",
]);

const FAILURE_STAGES = new Set<SupervisorDiagnosticStage>(["failure", "launch-failure"]);

let activeReporter: SupervisorDiagnosticsReporter | undefined;
let monitorInstalled = false;
let outcomeRecorded = false;

/**
 * Bind the invoked Supervisor process to DSH_SPACES_SUPERVISOR_DIAGNOSTICS.
 * Installs uncaughtExceptionMonitor and an exit observer without changing
 * Node's default fatal exit.
 */
export function bindSupervisorDiagnostics(
  env: NodeJS.ProcessEnv = process.env,
): SupervisorDiagnosticsReporter | undefined {
  const raw = env[SUPERVISOR_DIAGNOSTICS_ENV];
  const file = typeof raw === "string" ? raw.trim() : "";
  if (!file) {
    activeReporter = undefined;
    return undefined;
  }
  const reporter = trackOutcome(createSupervisorDiagnosticsReporter(file));
  activeReporter = reporter;
  if (!monitorInstalled) {
    monitorInstalled = true;
    process.on("uncaughtExceptionMonitor", (error) => {
      try {
        activeReporter?.recordFailure(error, { exit: 1 });
      } catch {
        /* reporting must not recurse into another fatal exception */
      }
    });
    process.on("exit", (code) => {
      if (!activeReporter || outcomeRecorded) return;
      try {
        activeReporter.recordFailure("Supervisor exited without a recorded stop.", { exit: code });
      } catch {
        /* reporting must not recurse into another fatal exception */
      }
    });
  }
  return reporter;
}

export function createSupervisorDiagnosticsReporter(file: string): SupervisorDiagnosticsReporter {
  return {
    recordStarting() {
      writeEvent(file, {
        stage: "starting",
        message: "Supervisor is starting.",
      });
    },
    recordReady() {
      writeEvent(file, {
        stage: "ready",
        message: "Supervisor is ready.",
      });
    },
    recordNormalStop(info) {
      writeEvent(file, {
        stage: "stop",
        message: "Supervisor stopped.",
        exit: info?.exit,
        signal: info?.signal,
      });
    },
    recordFailure(error, info) {
      writeEvent(file, {
        stage: "failure",
        message: errorMessage(error),
        exit: info?.exit,
        signal: info?.signal,
      });
    },
  };
}

/** Parent spawn error: best-effort bounded redacted write. Never throws. Omits observer pid. */
export function reportSupervisorLaunchFailure(file: string, message: string): void {
  writeEvent(file, {
    stage: "launch-failure",
    message: typeof message === "string" && message.trim() ? message : "The supervisor process could not be started.",
    omitPid: true,
  });
}

/**
 * Parent-observed child exit. Never throws. Omits observer pid.
 * Appends an exit observation without replacing an existing failure.
 * Exit 0 after a recorded normal stop is left unchanged.
 */
export function reportSupervisorExit(file: string, code: number | null, signal: string | null): void {
  writeEvent(file, {
    stage: "exit",
    message: exitObservation(code, signal),
    exit: code,
    signal,
    omitPid: true,
    preserveStopOnZero: code === 0 && (signal == null || signal === ""),
  });
}

/** Safe bounded public reasons. Never throws. */
export function readSupervisorDiagnostics(file: string): string[] {
  try {
    if (typeof file !== "string" || !file.trim()) return [SUPERVISOR_DIAGNOSTICS_UNAVAILABLE];
    const path = requireAbsolutePath(file);
    let raw: string;
    try {
      inspectDiagnosticFile(path);
      raw = readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [SUPERVISOR_DIAGNOSTICS_UNAVAILABLE];
      return [SUPERVISOR_DIAGNOSTICS_UNREADABLE];
    }
    const document = parseDocument(raw);
    if (!document) return [SUPERVISOR_DIAGNOSTICS_UNREADABLE];
    const reasons = publicReasons(document);
    return reasons.length ? reasons : [SUPERVISOR_DIAGNOSTICS_UNAVAILABLE];
  } catch {
    return [SUPERVISOR_DIAGNOSTICS_UNREADABLE];
  }
}

function trackOutcome(reporter: SupervisorDiagnosticsReporter): SupervisorDiagnosticsReporter {
  return {
    recordStarting() {
      reporter.recordStarting();
    },
    recordReady() {
      reporter.recordReady();
    },
    recordNormalStop(info) {
      reporter.recordNormalStop(info);
      outcomeRecorded = true;
    },
    recordFailure(error, info) {
      reporter.recordFailure(error, info);
      outcomeRecorded = true;
    },
  };
}

function writeEvent(
  file: string,
  input: {
    stage: SupervisorDiagnosticStage;
    message?: string;
    exit?: number | null;
    signal?: string | null;
    omitPid?: boolean;
    preserveStopOnZero?: boolean;
  },
): void {
  try {
    if (typeof file !== "string" || !file.trim()) return;
    const path = requireAbsolutePath(file);
    const existing = loadExistingDocument(path);
    if (input.preserveStopOnZero && existing && hasNormalStop(existing)) return;
    const at = new Date().toISOString().slice(0, MAX_TIMESTAMP_CHARS);
    const event: SupervisorDiagnosticEvent = { at, stage: input.stage };
    if (!input.omitPid) event.pid = process.pid;
    const message = truncateUtf8(sanitizeSupervisorText(input.message ?? ""), MAX_MESSAGE_CHARS);
    if (message) event.message = message;
    if (input.exit !== undefined) event.exit = normalizeExit(input.exit);
    if (input.signal !== undefined) event.signal = shortSignal(input.signal);
    const document = existing ?? emptyDocument(at, event.pid);
    document.events.push(event);
    document.updatedAt = at;
    if (event.pid !== undefined) document.pid = event.pid;
    if (event.exit !== undefined) document.exit = event.exit;
    if (event.signal !== undefined) document.signal = event.signal;
    if (!(input.stage === "exit" && FAILURE_STAGES.has(document.stage))) {
      document.stage = event.stage;
    }
    persistDocument(path, boundDocument(document));
  } catch {
    /* reporting must not recurse into another fatal exception */
  }
}

function loadExistingDocument(path: string): SupervisorDiagnosticDocument | undefined {
  try {
    inspectDiagnosticFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
  const document = parseDocument(readFileSync(path, "utf8"));
  if (!document) throw new Error("diagnostic file is corrupt");
  return document;
}

function persistDocument(path: string, document: SupervisorDiagnosticDocument): void {
  atomicWrite(path, `${JSON.stringify(document)}\n`);
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    /* Windows may ignore mode; the file is still local to this run. */
  }
}

function emptyDocument(at: string, pid?: number): SupervisorDiagnosticDocument {
  return {
    version: DOCUMENT_VERSION,
    updatedAt: at,
    stage: "starting",
    pid,
    events: [],
  };
}

function boundDocument(document: SupervisorDiagnosticDocument): SupervisorDiagnosticDocument {
  const events = document.events.slice(-SUPERVISOR_DIAGNOSTICS_MAX_EVENTS);
  const next: SupervisorDiagnosticDocument = { ...document, events };
  while (next.events.length > 1 && encodedBytes(next) > SUPERVISOR_DIAGNOSTICS_MAX_BYTES) {
    next.events.shift();
  }
  return next;
}

function encodedBytes(document: SupervisorDiagnosticDocument): number {
  return Buffer.byteLength(`${JSON.stringify(document)}\n`, "utf8");
}

function parseDocument(raw: string): SupervisorDiagnosticDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const row = parsed as Partial<SupervisorDiagnosticDocument>;
  if (row.version !== DOCUMENT_VERSION) return undefined;
  if (!shortText(row.updatedAt, MAX_TIMESTAMP_CHARS)) return undefined;
  if (typeof row.stage !== "string" || !isStage(row.stage)) return undefined;
  if (!Array.isArray(row.events) || row.events.length > SUPERVISOR_DIAGNOSTICS_MAX_EVENTS) return undefined;
  const events: SupervisorDiagnosticEvent[] = [];
  for (const item of row.events) {
    const event = parseEvent(item);
    if (!event) return undefined;
    events.push(event);
  }
  const document: SupervisorDiagnosticDocument = {
    version: DOCUMENT_VERSION,
    updatedAt: row.updatedAt,
    stage: row.stage,
    events,
  };
  if (row.pid !== undefined) {
    if (typeof row.pid !== "number" || !Number.isInteger(row.pid)) return undefined;
    document.pid = row.pid;
  }
  if (row.exit !== undefined) {
    if (row.exit !== null && (typeof row.exit !== "number" || !Number.isInteger(row.exit))) return undefined;
    document.exit = row.exit;
  }
  if (row.signal !== undefined) {
    if (row.signal !== null && typeof row.signal !== "string") return undefined;
    if (typeof row.signal === "string" && row.signal.length > MAX_SIGNAL_CHARS) return undefined;
    document.signal = row.signal;
  }
  if (encodedBytes(document) > SUPERVISOR_DIAGNOSTICS_MAX_BYTES) return undefined;
  return document;
}

function parseEvent(item: unknown): SupervisorDiagnosticEvent | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const row = item as Partial<SupervisorDiagnosticEvent>;
  if (!shortText(row.at, MAX_TIMESTAMP_CHARS)) return undefined;
  if (typeof row.stage !== "string" || !isStage(row.stage)) return undefined;
  const event: SupervisorDiagnosticEvent = { at: row.at, stage: row.stage };
  if (row.message !== undefined) {
    if (typeof row.message !== "string") return undefined;
    if (Buffer.byteLength(row.message, "utf8") > MAX_MESSAGE_CHARS) return undefined;
    event.message = row.message;
  }
  if (row.pid !== undefined) {
    if (typeof row.pid !== "number" || !Number.isInteger(row.pid)) return undefined;
    event.pid = row.pid;
  }
  if (row.exit !== undefined) {
    if (row.exit !== null && (typeof row.exit !== "number" || !Number.isInteger(row.exit))) return undefined;
    event.exit = row.exit;
  }
  if (row.signal !== undefined) {
    if (row.signal !== null && typeof row.signal !== "string") return undefined;
    if (typeof row.signal === "string" && row.signal.length > MAX_SIGNAL_CHARS) return undefined;
    event.signal = row.signal;
  }
  return event;
}

function isStage(value: string): value is SupervisorDiagnosticStage {
  return STAGES.has(value as SupervisorDiagnosticStage);
}

function hasNormalStop(document: SupervisorDiagnosticDocument): boolean {
  const last = document.events.at(-1);
  return (last?.stage ?? document.stage) === "stop";
}

function publicReasons(document: SupervisorDiagnosticDocument): string[] {
  const last = document.events.at(-1);
  const stage = last?.stage ?? document.stage;
  const at = last?.at ?? document.updatedAt;
  const reasons: string[] = [];
  pushReason(reasons, `Stage: ${stage}`);
  if (at) pushReason(reasons, `At: ${at}`);
  const lastMessage = last?.message ?? "";
  if (lastMessage) pushReason(reasons, lastMessage);
  const failure = [...document.events].reverse().find((event) => FAILURE_STAGES.has(event.stage));
  if (failure && failure !== last && failure.message && failure.message !== lastMessage) {
    pushReason(reasons, `Last failure: ${failure.message}`);
  }
  const exit = last?.exit !== undefined ? last.exit : document.exit;
  const signal = last?.signal !== undefined ? last.signal : document.signal;
  if (typeof exit === "number") pushReason(reasons, `Exit code: ${exit}`);
  if (typeof signal === "string" && signal.trim()) pushReason(reasons, `Signal: ${signal}`);
  return reasons;
}

function pushReason(reasons: string[], text: string): void {
  if (reasons.length >= SUPERVISOR_DIAGNOSTICS_MAX_REASONS) return;
  const sanitized = sanitizeSupervisorText(text).trim();
  if (!sanitized) return;
  reasons.push(
    sanitized.length > SUPERVISOR_DIAGNOSTICS_MAX_REASON_CHARS
      ? sanitized.slice(0, SUPERVISOR_DIAGNOSTICS_MAX_REASON_CHARS)
      : sanitized,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "supervisor failed";
}

function exitObservation(code: number | null, signal: string | null): string {
  const parts: string[] = [];
  if (typeof code === "number") parts.push(`exit code: ${code}`);
  if (typeof signal === "string" && signal.trim()) parts.push(`signal: ${signal.trim()}`);
  return parts.length ? `Supervisor process exited (${parts.join(", ")}).` : "Supervisor process exited.";
}

function sanitizeSupervisorText(text: string): string {
  if (!text) return "";
  const credentials = text
    .replace(/\b(Authorization|Set-Cookie|Cookie)\s*:\s*[^\r\n]*/gi, "$1: [redacted]")
    .replace(/(["']?(?:bearer|authorization|cookie|set-cookie|nonce)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi, "$1[redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=_-]+/gi, "Basic [redacted]");
  return sanitizePaths(redactBootstrap(sanitizeLogText(credentials)));
}

function redactBootstrap(text: string): string {
  return text
    .replace(/\/bootstrap\/[^\s"'?&#]+/gi, "/bootstrap/[redacted]")
    .replace(/\bbootstrap=\S+/gi, "bootstrap=[redacted]")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
      if (!/\/bootstrap\//i.test(url)) return url;
      return url.replace(/\/bootstrap\/[^\s"'?&#]+/gi, "/bootstrap/[redacted]");
    });
}

function sanitizePaths(text: string): string {
  return text
    .replace(/file:\/+[^\s"'\\]+/gi, "[path]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'`<>]+/g, "[path]")
    .replace(/(?:\/(?:home|Users|tmp|var|root)\/|~\/)[^\s"'`<>]+/g, "[path]")
    .replace(/(?:^|[\s"'`(])(\/(?:[\w.+-]+\/)+[\w.+-]+)/g, (full, path: string) => full.replace(path, "[path]"));
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function shortText(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= maxChars;
}

function shortSignal(signal: string | null | undefined): string | null | undefined {
  if (signal === undefined || signal === null) return signal;
  const text = sanitizeSupervisorText(signal).trim();
  if (!text) return null;
  return text.length > MAX_SIGNAL_CHARS ? text.slice(0, MAX_SIGNAL_CHARS) : text;
}

function normalizeExit(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  return Number.isInteger(value) ? value : null;
}

function requireAbsolutePath(file: string): string {
  const trimmed = file.trim();
  if (!isAbsolute(trimmed)) throw new Error("diagnostic path must be absolute");
  return resolve(trimmed);
}

function inspectDiagnosticFile(path: string): Stats {
  if (!isAbsolute(path)) throw new Error("diagnostic path must be absolute");
  if (isInsideRealHome(path)) throw new Error("diagnostic path is inside the real DSH home");
  assertNoSymlinkAncestors(dirname(path));
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error("diagnostic file is a symlink");
  if (!st.isFile()) throw new Error("diagnostic file is not a regular file");
  if (st.size > SUPERVISOR_DIAGNOSTICS_MAX_BYTES) throw new Error("diagnostic file exceeds the size bound");
  return st;
}

function assertNoSymlinkAncestors(start: string): void {
  let current = resolve(start);
  for (;;) {
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) throw new Error("diagnostic parent is a symlink");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
