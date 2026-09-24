import { appendFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "./atomic";
import { sanitizeLogText } from "./diagnostics";
import { assertNotRealHome } from "./home-guard";
import { WORKBENCH_CONTROL_DIR_NAME } from "./workbench-jobs";
import { redactPublicReason } from "../../shared/public-reason";
import type { WorkbenchLogEntry, WorkbenchLogLevel, WorkbenchLogSnapshot } from "../../shared/workbench-log";

export const WORKBENCH_LOG_FILE = "workbench-log.jsonl";
export const WORKBENCH_LOG_MAX_ENTRIES = 400;
export const WORKBENCH_LOG_MAX_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 2000;

const LEVELS = new Set<WorkbenchLogLevel>(["info", "warn", "error"]);
const AREA_RE = /^[a-z][a-z0-9.-]{0,31}$/;
const EVENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const CODE_RE = /^(?:workbench|spaces)\/[a-z0-9-]+$|^LLM_[A-Z0-9_]+$/;

export interface WorkbenchLogInput {
  level: WorkbenchLogLevel;
  area: string;
  event: string;
  message: string;
  code?: string;
}

/**
 * One append-only journal for the control process.
 * A damaged file is reported and left unchanged. Writing does not retry.
 */
export class WorkbenchLog {
  private readonly filePath: string;

  constructor(
    home: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    assertNotRealHome(home);
    this.filePath = join(home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_LOG_FILE);
  }

  read(): WorkbenchLogSnapshot {
    let stat;
    try {
      stat = lstatSync(this.filePath);
    } catch (error) {
      if (isEnoent(error)) return { entries: [], logError: null };
      return { entries: [], logError: "The workbench log could not be read." };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { entries: [], logError: "The workbench log is not a regular file and was not rewritten." };
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return { entries: [], logError: "The workbench log could not be read." };
    }
    const entries: WorkbenchLogEntry[] = [];
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line) continue;
      const parsed = parseEntry(line);
      if (!parsed) {
        return {
          entries,
          logError: `The workbench log could not be read after line ${entries.length + 1}. The file was not rewritten.`,
        };
      }
      entries.push(publicEntry(parsed));
    }
    return { entries, logError: null };
  }

  append(input: WorkbenchLogInput): WorkbenchLogEntry {
    const current = this.read();
    if (current.logError) throw new Error(current.logError);
    const entry = this.entryFrom(input);
    const next = trimEntries([...current.entries, entry]);
    const line = `${JSON.stringify(entry)}\n`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (next.length !== current.entries.length + 1) {
      atomicWrite(this.filePath, next.map((item) => `${JSON.stringify(item)}\n`).join(""));
    } else {
      appendFileSync(this.filePath, line, { encoding: "utf8", mode: 0o600 });
    }
    return entry;
  }

  private entryFrom(input: WorkbenchLogInput): WorkbenchLogEntry {
    if (!LEVELS.has(input.level)) throw new Error("The workbench log level is not valid.");
    if (!AREA_RE.test(input.area)) throw new Error("The workbench log area is not valid.");
    if (!EVENT_RE.test(input.event)) throw new Error("The workbench log event is not valid.");
    const message = redactPublicReason(sanitizeLogText(input.message), MAX_MESSAGE_CHARS);
    if (!message) throw new Error("The workbench log message is empty.");
    const entry: WorkbenchLogEntry = {
      at: this.now().toISOString(),
      level: input.level,
      area: input.area,
      event: input.event,
      message,
    };
    if (input.code && CODE_RE.test(input.code)) entry.code = input.code;
    return entry;
  }
}

function parseEntry(line: string): WorkbenchLogEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  const allowed = new Set(["at", "level", "area", "event", "message", "code"]);
  if (keys.some((key) => !allowed.has(key))) return null;
  if (typeof row.at !== "string" || row.at.length > 40) return null;
  if (typeof row.level !== "string" || !LEVELS.has(row.level as WorkbenchLogLevel)) return null;
  if (typeof row.area !== "string" || !AREA_RE.test(row.area)) return null;
  if (typeof row.event !== "string" || !EVENT_RE.test(row.event)) return null;
  if (typeof row.message !== "string" || !row.message || row.message.length > MAX_MESSAGE_CHARS) return null;
  const entry: WorkbenchLogEntry = {
    at: row.at,
    level: row.level as WorkbenchLogLevel,
    area: row.area,
    event: row.event,
    message: row.message,
  };
  if (row.code !== undefined) {
    if (typeof row.code !== "string" || !CODE_RE.test(row.code)) return null;
    entry.code = row.code;
  }
  return entry;
}

function publicEntry(entry: WorkbenchLogEntry): WorkbenchLogEntry {
  const message = redactPublicReason(sanitizeLogText(entry.message), MAX_MESSAGE_CHARS);
  return { ...entry, message: message || "[redacted]" };
}

function trimEntries(entries: WorkbenchLogEntry[]): WorkbenchLogEntry[] {
  const next = entries.slice(-WORKBENCH_LOG_MAX_ENTRIES);
  while (next.length > 1 && encodedBytes(next) > WORKBENCH_LOG_MAX_BYTES) next.shift();
  return next;
}

function encodedBytes(entries: WorkbenchLogEntry[]): number {
  let total = 0;
  for (const entry of entries) total += Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8");
  return total;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}
