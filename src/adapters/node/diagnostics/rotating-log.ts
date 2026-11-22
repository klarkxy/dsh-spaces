import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { lexists, lstatSync, realpathSync } from "../../../shared/node/filesystem";
import {
  DEFAULT_DIAGNOSTIC_LOG_LEVEL,
  diagnosticLevelEnabled,
  type DiagnosticLogEntry,
  type DiagnosticLogInput,
  type DiagnosticLogLevel,
} from "../../../shared/diagnostic-log";
import { assertNotRealHome } from "../home/home-guard";
import { sanitizeLogText } from "./diagnostics";

export const DIAGNOSTIC_LOG_DIR = "logs";
export const DIAGNOSTIC_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_LOG_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DIAGNOSTIC_LOG_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const DIAGNOSTIC_LOG_MAX_MESSAGE_CHARS = 16_000;
export const DIAGNOSTIC_LOG_MAX_CONTEXT_CHARS = 8_000;
/** Bounded read for the first record's timestamp; one diagnostic line never exceeds it. */
export const DIAGNOSTIC_LOG_FIRST_RECORD_READ_BYTES = 64 * 1024;

const SOURCE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const EVENT_RE = /^[a-z][a-z0-9.-]{0,127}$/;
const ARCHIVE_RE = /^[a-z][a-z0-9-]{0,63}\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.\d+\.\d+\.jsonl$/;
const SECRET_QUERY_RE = /([?&](?:token|key|secret|password|bootstrap|code|sig|signature|credential)=)[^\s&#]+/gi;
const AUTH_RE = /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]*/gi;
const URL_CREDENTIAL_RE = /\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const PATH_RE = /(?:[A-Za-z]:\\|\\\\)[^\s"'`<>]+|(?:\/(?:home|Users|tmp|var|root)\/|~\/)[^\s"'`<>]+/g;
const BOOTSTRAP_RE = /\/bootstrap\/[^\s"'?&#]+/gi;
const SECRET_FIELD_RE = /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|authorization|cookie|set-cookie|nonce|session|credential|private[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi;

export interface DiagnosticLogger {
  readonly file: string;
  readonly lastWriteError: string | null;
  debug(event: string, message: string, context?: DiagnosticLogInput["context"]): boolean;
  info(event: string, message: string, context?: DiagnosticLogInput["context"]): boolean;
  error(event: string, message: string, error?: unknown, context?: DiagnosticLogInput["context"]): boolean;
  fault(event: string, message: string, error?: unknown, context?: DiagnosticLogInput["context"]): boolean;
  write(input: DiagnosticLogInput): boolean;
}

export interface RotatingDiagnosticLoggerOptions {
  allowRealHome?: boolean;
  minimumLevel?: DiagnosticLogLevel;
  now?: () => Date;
  pid?: number;
  maxFileBytes?: number;
  maxArchiveBytes?: number;
  maxAgeMs?: number;
}

export function diagnosticLogDirectory(home: string): string {
  return join(resolve(home), ".dsh-spaces-control", DIAGNOSTIC_LOG_DIR);
}

export function createDiagnosticLogger(
  home: string,
  source: string,
  options: RotatingDiagnosticLoggerOptions = {},
): DiagnosticLogger {
  return new RotatingDiagnosticLogger(home, source, options);
}

/**
 * Synchronous, append-only JSONL. A source belongs to one process; child-space
 * output is written by its Supervisor, avoiding unsynchronized file renames.
 * Rotation and pruning happen once per write, never on a retry timer.
 */
export class RotatingDiagnosticLogger implements DiagnosticLogger {
  readonly file: string;
  private lastError: string | null = null;
  /** Last on-disk size this instance observed; -1 until the first stat. */
  private lastSize = -1;
  /** Cached `at` of the first record in the active file (mtime when unparseable). */
  private firstRecordAt: number | null = null;
  private writing = false;
  private sequence = 0;
  private loggedWriteFailure = false;
  private readonly home: string;
  private readonly allowRealHome: boolean;
  private readonly directory: string;
  private readonly minimum: DiagnosticLogLevel;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly maxFileBytes: number;
  private readonly maxArchiveBytes: number;
  private readonly maxAgeMs: number;

  constructor(home: string, private readonly source: string, options: RotatingDiagnosticLoggerOptions = {}) {
    this.home = resolve(home);
    this.allowRealHome = options.allowRealHome === true;
    if (!this.allowRealHome) assertNotRealHome(this.home);
    if (!SOURCE_RE.test(source)) throw new Error("Diagnostic log source is invalid.");
    this.directory = diagnosticLogDirectory(this.home);
    this.file = join(this.directory, `${source}.jsonl`);
    this.minimum = options.minimumLevel ?? DEFAULT_DIAGNOSTIC_LOG_LEVEL;
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.maxFileBytes = options.maxFileBytes ?? DIAGNOSTIC_LOG_MAX_FILE_BYTES;
    this.maxArchiveBytes = options.maxArchiveBytes ?? DIAGNOSTIC_LOG_MAX_ARCHIVE_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? DIAGNOSTIC_LOG_MAX_AGE_MS;
  }

  get lastWriteError(): string | null {
    return this.lastError;
  }

  debug(event: string, message: string, context?: DiagnosticLogInput["context"]): boolean {
    return this.write({ level: "debug", event, message, ...(context ? { context } : {}) });
  }

  info(event: string, message: string, context?: DiagnosticLogInput["context"]): boolean {
    return this.write({ level: "info", event, message, ...(context ? { context } : {}) });
  }

  error(event: string, message: string, error?: unknown, context?: DiagnosticLogInput["context"]): boolean {
    return this.write({ level: "error", event, message, ...(error !== undefined ? { error } : {}), ...(context ? { context } : {}) });
  }

  fault(event: string, message: string, error?: unknown, context?: DiagnosticLogInput["context"]): boolean {
    return this.write({ level: "fault", event, message, ...(error !== undefined ? { error } : {}), ...(context ? { context } : {}) });
  }

  write(input: DiagnosticLogInput): boolean {
    if (!diagnosticLevelEnabled(input.level, this.minimum) || this.writing) return false;
    const at = this.now();
    let line: string;
    try {
      line = `${JSON.stringify(this.entry(input, at))}\n`;
    } catch {
      return false;
    }
    this.writing = true;
    try {
      this.openManagedDirectory();
      // Rotation is decided from on-disk state on every write: several logger
      // instances and processes append to the same file, so an in-memory
      // counter cannot see their bytes, and a re-created file can carry a
      // tunneled birthtime older than its actual first record.
      const stat = this.regularFile(this.file);
      const size = stat?.size ?? 0;
      if (!stat) {
        this.firstRecordAt = null;
      } else if (this.firstRecordAt === null || size < this.lastSize) {
        // An empty file has no first record yet; the next write reads the real one.
        this.firstRecordAt = size > 0 ? this.firstRecordTime(stat.mtimeMs) : null;
      }
      this.lastSize = size;
      const bytes = Buffer.byteLength(line);
      const firstAt = this.firstRecordAt ?? at.getTime();
      if (size > 0 && (size + bytes > this.maxFileBytes || at.getTime() - firstAt >= this.maxAgeMs)) {
        this.rotate(at);
      }
      appendFileSync(this.file, line, { encoding: "utf8", mode: 0o600 });
      this.lastSize += bytes;
      this.prune(at);
      this.lastError = null;
      this.loggedWriteFailure = false;
      return true;
    } catch (error) {
      const detail = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 500);
      this.lastError = `The local diagnostic log could not be written: ${detail}`;
      if (!this.loggedWriteFailure) {
        this.loggedWriteFailure = true;
        try {
          process.stderr.write(`DSH Spaces: ${this.lastError}. The original operation continues unchanged.\n`);
        } catch {
          // A broken stderr cannot replace the original operation's outcome.
        }
      }
      return false;
    } finally {
      this.writing = false;
    }
  }

  private entry(input: DiagnosticLogInput, at: Date): DiagnosticLogEntry {
    if (!EVENT_RE.test(input.event)) throw new Error("Diagnostic log event is invalid.");
    const entry: DiagnosticLogEntry = {
      version: 1,
      at: at.toISOString(),
      level: input.level,
      source: this.source,
      event: input.event,
      message: sanitizeDiagnosticText(input.message || "No diagnostic message was provided.", DIAGNOSTIC_LOG_MAX_MESSAGE_CHARS),
      pid: this.pid,
    };
    const context = sanitizeContext(input.context);
    if (context) entry.context = context;
    const error = sanitizeError(input.error);
    if (error) entry.error = error;
    return entry;
  }

  /**
   * `at` of the first record in the active file, from a bounded read of its
   * start. An unparseable or unreadable first record falls back to the file
   * mtime; the birthtime is never trusted because NTFS tunneling can restore
   * a deleted file's old birthtime on recreation.
   */
  private firstRecordTime(fallbackMs: number): number {
    try {
      const descriptor = openSync(this.file, "r");
      try {
        const buffer = Buffer.alloc(DIAGNOSTIC_LOG_FIRST_RECORD_READ_BYTES);
        const read = readSync(descriptor, buffer, 0, buffer.length, 0);
        const first = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0];
        const parsed: unknown = JSON.parse(first);
        const at = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { at?: unknown }).at
          : undefined;
        if (typeof at === "string") {
          const time = Date.parse(at);
          if (Number.isFinite(time)) return time;
        }
        return fallbackMs;
      } finally {
        closeSync(descriptor);
      }
    } catch {
      return fallbackMs;
    }
  }

  private rotate(at: Date): void {
    const stamp = at.toISOString().replace(/:/g, "-");
    const name = `${this.source}.${stamp}.${this.pid}.${this.sequence++}.jsonl`;
    const archive = join(this.directory, name);
    if (!ARCHIVE_RE.test(name)) {
      throw new Error("Diagnostic log archive name is invalid.");
    }
    if (lexists(archive)) throw new Error("Diagnostic log archive already exists.");
    renameSync(this.file, archive);
    this.lastSize = 0;
    this.firstRecordAt = null;
  }

  private prune(at: Date): void {
    const archives: Array<{ name: string; size: number; mtime: number }> = [];
    let total = 0;
    for (const name of readdirSync(this.directory)) {
      if (!ARCHIVE_RE.test(name) || !name.startsWith(`${this.source}.`)) continue;
      const path = join(this.directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Diagnostic log archive is not a regular file.");
      if (at.getTime() - stat.mtimeMs >= this.maxAgeMs) {
        unlinkSync(path);
        continue;
      }
      archives.push({ name, size: stat.size, mtime: stat.mtimeMs });
      total += stat.size;
    }
    archives.sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name));
    while (total > this.maxArchiveBytes && archives.length) {
      const oldest = archives.shift()!;
      unlinkSync(join(this.directory, oldest.name));
      total -= oldest.size;
    }
  }

  private openManagedDirectory(): void {
    if (lexists(this.home)) {
      const homeStat = lstatSync(this.home);
      if (homeStat.isSymbolicLink()) throw new Error("Diagnostic log Home is not a real directory.");
      if (!this.allowRealHome) assertNotRealHome(realpathSync(this.home));
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const real = realpathSync(this.directory);
    const homeReal = realpathSync(resolve(this.directory, "..", ".."));
    if (!this.allowRealHome) assertNotRealHome(homeReal);
    const controlReal = realpathSync(resolve(this.directory, ".."));
    if (!isInside(homeReal, real) || !samePath(controlReal, join(homeReal, ".dsh-spaces-control"))) {
      throw new Error("Diagnostic log directory is outside its Home.");
    }
    const stat = lstatSync(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Diagnostic log directory is not a real directory.");
  }

  private regularFile(path: string): { size: number; mtimeMs: number } | undefined {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Diagnostic log is not a regular file.");
      if (!samePath(realpathSync(path), path)) throw new Error("Diagnostic log path could not be verified.");
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export function readDiagnosticLogTail(file: string, maxBytes = 256 * 1024): string {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Diagnostic log is not a regular file.");
  const length = Math.min(stat.size, maxBytes);
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(descriptor, buffer, 0, buffer.length, stat.size - length);
    let text = buffer.subarray(0, read).toString("utf8");
    if (stat.size > length) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return text;
  } finally {
    closeSync(descriptor);
  }
}

export function installProcessDiagnosticLogging(logger: DiagnosticLogger, source = "process"): () => void {
  const uncaught = (error: unknown, origin: string) => {
    logger.fault(`${source}.${origin === "unhandledRejection" ? "unhandled-rejection" : "uncaught"}`,
      "An uncaught failure terminated the normal execution boundary.", error);
  };
  const exit = (code: number) => {
    logger.write({ level: code === 0 ? "info" : "fault", event: `${source}.exit`, message: `Process exited with code ${code}.`, context: { exitCode: code } });
  };
  process.on("uncaughtExceptionMonitor", uncaught);
  process.on("exit", exit);
  return () => {
    process.off("uncaughtExceptionMonitor", uncaught);
    process.off("exit", exit);
  };
}

export function sanitizeDiagnosticText(text: string, maxChars = DIAGNOSTIC_LOG_MAX_MESSAGE_CHARS): string {
  const sanitized = sanitizeLogText(text)
    .replace(AUTH_RE, "$1: [redacted]")
    .replace(SECRET_FIELD_RE, "$1[redacted]")
    .replace(SECRET_QUERY_RE, "$1[redacted]")
    .replace(URL_CREDENTIAL_RE, "$1[redacted]@")
    .replace(BOOTSTRAP_RE, "/bootstrap/[redacted]")
    .replace(PATH_RE, "[path]");
  return truncateUtf8(sanitized, maxChars);
}

function sanitizeContext(input: DiagnosticLogInput["context"]): DiagnosticLogEntry["context"] | undefined {
  if (!input) return undefined;
  const output: NonNullable<DiagnosticLogEntry["context"]> = {};
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    if (!/^[a-z][a-zA-Z0-9.-]{0,63}$/.test(key)) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    output[key] = typeof value === "string" ? sanitizeDiagnosticText(value, 1000) : value;
  }
  const encoded = JSON.stringify(output);
  if (encoded.length <= DIAGNOSTIC_LOG_MAX_CONTEXT_CHARS) return Object.keys(output).length ? output : undefined;
  return { omitted: true, reason: "Diagnostic context exceeded its size limit." };
}

function addCorrelation(context: DiagnosticLogInput["context"], extra: DiagnosticLogInput["context"]): DiagnosticLogInput["context"] {
  if (!context) return extra;
  if (!extra) return context;
  return { ...extra, ...context };
}

export function withDiagnosticCorrelation(logger: DiagnosticLogger, context: DiagnosticLogInput["context"]): DiagnosticLogger {
  return {
    file: logger.file,
    get lastWriteError() { return logger.lastWriteError; },
    debug: (event, message, fields) => logger.debug(event, message, addCorrelation(fields, context)),
    info: (event, message, fields) => logger.info(event, message, addCorrelation(fields, context)),
    error: (event, message, error, fields) => logger.error(event, message, error, addCorrelation(fields, context)),
    fault: (event, message, error, fields) => logger.fault(event, message, error, addCorrelation(fields, context)),
    write: input => logger.write({ ...input, context: addCorrelation(input.context, context) }),
  };
}

function sanitizeError(error: unknown): DiagnosticLogEntry["error"] | undefined {
  if (error === undefined) return undefined;
  const row = error && typeof error === "object" ? error as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown } : {};
  const message = typeof row.message === "string" ? row.message : String(error);
  const result: NonNullable<DiagnosticLogEntry["error"]> = {
    name: typeof row.name === "string" ? truncateUtf8(row.name, 100) : "Error",
    message: sanitizeDiagnosticText(message),
  };
  if (typeof row.stack === "string") result.stack = sanitizeDiagnosticText(row.stack, 24_000);
  if (typeof row.code === "string" && /^[A-Za-z0-9_/-]{1,100}$/.test(row.code)) result.code = row.code;
  return result;
}

function truncateUtf8(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "[truncated]\n";
  return `${marker}${text.slice(-Math.max(0, maxChars - marker.length))}`;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(root: string, target: string): boolean {
  if (samePath(root, target)) return true;
  const prefix = `${root.endsWith(sep) ? root : root + sep}`;
  return process.platform === "win32" ? target.toLowerCase().startsWith(prefix.toLowerCase()) : target.startsWith(prefix);
}
