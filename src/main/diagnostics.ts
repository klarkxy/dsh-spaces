import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { t } from "../shared/i18n";
import {
  BACKUP_FILE_PREFIX,
  MAX_BACKUP_BYTES,
  MAX_LOG_BYTES,
  MAX_LOG_ENTRIES,
  type BackupPreview,
  type ConfigBackupMeta,
  type DiagnosticChannel,
  type DiagnosticLogEntry,
  type DiagnosticsSnapshot,
} from "../shared/diagnostics";
import type { ProfileRecord, ProfileStatus } from "../shared/types";
import { PROFILE_NAME_RE } from "../shared/types";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";
import { PatchWriter } from "./patch-writer";

export interface DiagnosticsServiceOptions {
  home: string;
  profiles: () => ProfileRecord[];
  statusOf: (name: string) => ProfileStatus;
  stop: (name: string) => Promise<void>;
  isMaintenance: () => boolean;
  /** Test seam. Production uses PatchWriter.verify (real dump-config). Restore always calls this. */
  verify?: (name: string) => Promise<void>;
}

interface ProfileLogs {
  entries: DiagnosticLogEntry[];
  logError?: string;
  loaded: boolean;
}

const CHAT_PAYLOAD_RE =
  /"role"\s*:\s*"(?:system|user|assistant|tool)"|"(?:messages|content|prompt|text|input_text|input_image|image_url)"\s*:/i;
const CREDENTIAL_BODY_RE =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"type"\s*:\s*"service_account"|credentials\.json|\.dsh[/\\](?:credentials|auth)/i;
const SECRET_ASSIGN_RE =
  /(["']?(?:api[_-]?key|access[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi;

export class DiagnosticsService {
  private readonly home: string;
  private readonly homeRoot: string;
  private readonly profiles: () => ProfileRecord[];
  private readonly statusOf: (name: string) => ProfileStatus;
  private readonly stop: (name: string) => Promise<void>;
  private readonly isMaintenance: () => boolean;
  private readonly verify: (name: string) => Promise<void>;
  private readonly writer: PatchWriter;
  private readonly logs = new Map<string, ProfileLogs>();
  private readonly privateKeyBlocks = new Set<string>();

  constructor(opts: DiagnosticsServiceOptions) {
    assertNotRealHome(opts.home);
    this.home = opts.home;
    this.homeRoot = existsSync(opts.home) ? realpathSync(opts.home) : resolve(opts.home);
    this.profiles = opts.profiles;
    this.statusOf = opts.statusOf;
    this.stop = opts.stop;
    this.isMaintenance = opts.isMaintenance;
    this.writer = new PatchWriter(opts.home);
    this.verify = opts.verify ?? ((name) => this.writer.verify(name));
  }

  get(name: string): DiagnosticsSnapshot {
    const profile = this.requireProfile(name);
    const stored = this.loadLogs(name);
    return {
      name,
      status: this.statusOf(name),
      lastError: profile.lastError ? sanitizeLogText(profile.lastError) : undefined,
      logs: stored.entries.slice(),
      logError: stored.logError,
      backups: name === "web" ? [] : this.listBackups(name),
      canRestore: false,
    };
  }

  record(name: string, channel: DiagnosticChannel, text: string): void {
    try {
      this.requireProfile(name);
    } catch {
      return;
    }
    if (!text) return;
    try {
      const stored = this.loadLogs(name);
      if (channel === "lifecycle" && text === "starting") {
        for (const stream of ["stdout", "stderr"]) this.privateKeyBlocks.delete(`${name}:${stream}`);
      }
      const blockKey = `${name}:${channel}`;
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) this.privateKeyBlocks.add(blockKey);
      const inPrivateKey = this.privateKeyBlocks.has(blockKey);
      if (/-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) this.privateKeyBlocks.delete(blockKey);
      const sanitized = inPrivateKey ? "[omitted credential material]" : sanitizeLogText(text);
      const entry: DiagnosticLogEntry = {
        at: new Date().toISOString(),
        channel,
        text: sanitized,
      };
      const next = boundEntries([...stored.entries, entry]);
      const trimmed =
        next.length !== stored.entries.length + 1 || next[next.length - 1]?.text !== entry.text;
      stored.entries = next;
      this.persistLogs(name, stored, trimmed ? undefined : next[next.length - 1]);
    } catch (err) {
      const stored = this.logs.get(name) ?? { entries: [], loaded: true };
      stored.loaded = true;
      stored.logError = `Could not write hub/${name}/diagnostics.log: ${errorMessage(err)}`;
      this.logs.set(name, stored);
    }
  }

  previewBackup(name: string, backupId: string): BackupPreview {
    const profile = this.requireProfile(name);
    this.assertRestorable(profile);
    const meta = this.statBackup(name, backupId);
    if (meta.tooLarge) return meta;
    const content = readFileSync(this.resolvedBackupFile(name, backupId), "utf8");
    return { ...meta, content };
  }

  async restoreBackup(_name: string, _backupId: string): Promise<void> {
    throw new Error("Configuration restore is not supported.");
  }

  private requireProfile(name: string): ProfileRecord {
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0")) {
      throw new Error(t("errors.unknownProfile", { name }));
    }
    if (name !== "web" && !PROFILE_NAME_RE.test(name)) {
      throw new Error(t("errors.unknownProfile", { name }));
    }
    const profile = this.profiles().find((item) => item.name === name);
    if (!profile) {
      throw new Error(t("errors.unknownProfile", { name }));
    }
    return profile;
  }

  private assertRestorable(profile: ProfileRecord): void {
    if (profile.name === "web" || profile.kind === "root") {
      throw new Error(t("errors.webSacred"));
    }
  }

  private loadLogs(name: string): ProfileLogs {
    const existing = this.logs.get(name);
    if (existing?.loaded) return existing;
    const stored: ProfileLogs = existing ?? { entries: [], loaded: true };
    stored.loaded = true;
    this.logs.set(name, stored);
    try {
      const dir = this.walkManaged(["hub", name], false);
      const path = join(dir, "diagnostics.log");
      let st: Stats | undefined;
      try {
        st = lstatSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return stored;
        throw err;
      }
      if (st.isSymbolicLink()) throw new Error("diagnostics.log is a symlink");
      if (!st.isFile()) throw new Error("diagnostics.log is not a regular file");
      const parentReal = realpathSync(dir);
      this.assertInsideHome(parentReal, `hub/${name}`);
      const raw = readLogTail(path, st.size);
      stored.entries = boundEntries(parseLogFile(raw));
      stored.logError = undefined;
    } catch (err) {
      stored.logError = `Could not read hub/${name}/diagnostics.log: ${errorMessage(err)}`;
    }
    return stored;
  }

  private persistLogs(name: string, stored: ProfileLogs, appended?: DiagnosticLogEntry): void {
    this.logs.set(name, stored);
    try {
      const dir = this.walkManaged(["hub", name], true);
      const path = join(dir, "diagnostics.log");
      this.assertInsideHome(realpathSync(dir), `hub/${name}`);
      let st: Stats | undefined;
      try {
        st = lstatSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (st?.isSymbolicLink()) throw new Error("diagnostics.log is a symlink");
      if (st && !st.isFile()) throw new Error("diagnostics.log is not a regular file");
      const body = stored.entries.map((entry) => JSON.stringify(entry)).join("\n");
      const encoded = body ? `${body}\n` : "";
      const encodedBytes = Buffer.byteLength(encoded, "utf8");
      const previousBytes = encodedBytes - (appended ? lineBytes(appended) : 0);
      if (
        appended &&
        !stored.logError &&
        st &&
        st.size === previousBytes &&
        st.size + lineBytes(appended) <= MAX_LOG_BYTES &&
        encodedBytes <= MAX_LOG_BYTES
      ) {
        appendFileSync(path, `${JSON.stringify(appended)}\n`, "utf8");
      } else {
        if (encodedBytes > MAX_LOG_BYTES) {
          throw new Error("bounded diagnostics log exceeded the disk limit");
        }
        atomicWrite(path, encoded);
      }
      stored.logError = undefined;
    } catch (err) {
      stored.logError = `Could not write hub/${name}/diagnostics.log: ${errorMessage(err)}`;
    }
  }

  private listBackups(name: string): ConfigBackupMeta[] {
    try {
      const dir = this.walkManaged(["profiles", name], false);
      if (!existsSync(dir)) return [];
      this.assertManagedExistingDir(dir);
      const metas: ConfigBackupMeta[] = [];
      for (const id of readdirSync(dir)) {
        if (!id.startsWith(BACKUP_FILE_PREFIX) || id === BACKUP_FILE_PREFIX) continue;
        if (id !== basename(id)) continue;
        try {
          metas.push(this.statBackup(name, id));
        } catch {
          /* skip unreadable, escaped, or non-regular files */
        }
      }
      metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return metas;
    } catch {
      return [];
    }
  }

  private statBackup(name: string, backupId: string): BackupPreview {
    const file = this.resolvedBackupFile(name, backupId);
    const st = lstatSync(file);
    return {
      id: backupId,
      createdAt: st.mtime.toISOString(),
      size: st.size,
      tooLarge: st.size > MAX_BACKUP_BYTES,
    };
  }

  private resolvedBackupFile(name: string, backupId: string): string {
    if (
      !backupId ||
      isAbsolute(backupId) ||
      backupId !== basename(backupId) ||
      backupId.includes("..") ||
      backupId.includes("\0") ||
      !backupId.startsWith(BACKUP_FILE_PREFIX) ||
      backupId.length <= BACKUP_FILE_PREFIX.length
    ) {
      throw new Error("Backup id is not a configuration backup file in this space's profile directory.");
    }
    const dir = this.walkManaged(["profiles", name], false);
    this.assertManagedExistingDir(dir);
    const file = join(dir, backupId);
    if (resolve(dirname(file)) !== resolve(dir) && !sameResolved(dirname(file), dir)) {
      throw new Error("Backup is outside the profile directory.");
    }
    let st: Stats;
    try {
      st = lstatSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Backup ${backupId} was not found.`);
      }
      throw err;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error("Backup must be a regular file in this space's profile directory.");
    }
    const realDir = realpathSync(dir);
    const realFile = realpathSync(file);
    this.assertInsideHome(realDir, `profiles/${name}`);
    this.assertInsideHome(realFile, `profiles/${name}/${backupId}`);
    if (!isInside(realDir, realFile) && !sameResolved(realFile, realDir)) {
      throw new Error("Backup is outside the profile directory.");
    }
    return file;
  }

  private walkManaged(segments: string[], create: boolean): string {
    let lexical = this.home;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (!seg || seg === "." || seg === ".." || /[\\/\0]/.test(seg)) {
        throw new Error("Invalid path segment");
      }
      lexical = join(lexical, seg);
      let st: Stats | undefined;
      try {
        st = lstatSync(lexical);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (!st) {
        if (!create) return join(lexical, ...segments.slice(i + 1));
        mkdirSync(lexical);
        st = lstatSync(lexical);
      }
      const real = realpathSync(lexical);
      this.assertInsideHome(real, segments.slice(0, i + 1).join("/"));
    }
    return lexical;
  }

  private assertManagedExistingDir(dir: string): void {
    const st = lstatSync(dir);
    if (!st.isDirectory() && !st.isSymbolicLink()) {
      throw new Error("Managed path is not a directory");
    }
    this.assertInsideHome(realpathSync(dir), dir);
  }

  private assertRegularManagedFile(file: string, label: string): void {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) throw new Error(`${label} is a symlink`);
    if (!st.isFile()) throw new Error(`${label} is not a regular file`);
    this.assertInsideHome(realpathSync(file), label);
  }

  private assertInsideHome(realPath: string, label: string): void {
    if (!isInside(this.homeRoot, realPath)) {
      throw new Error(`Refusing path outside the DSH home (${label})`);
    }
  }

  private backupCurrentPatch(patchPath: string, original: string): void {
    const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
    const bakPath = `${patchPath}.bak-${stamp}-${randomUUID()}`;
    writeFileSync(bakPath, original, { encoding: "utf8", flag: "wx" });
  }

  private rollbackPatch(patchPath: string, original: string | null): void {
    if (original !== null) {
      atomicWrite(patchPath, original);
      if (!existsSync(patchPath) || readFileSync(patchPath, "utf8") !== original) {
        throw new Error("could not restore the previous patch file");
      }
      return;
    }
    if (existsSync(patchPath)) unlinkSync(patchPath);
    if (existsSync(patchPath)) throw new Error("could not remove the candidate patch file");
  }
}

export function sanitizeLogText(text: string): string {
  if (!text) return "";
  if (CREDENTIAL_BODY_RE.test(text)) return "[omitted credential material]";
  if (CHAT_PAYLOAD_RE.test(text)) return "[omitted chat payload]";
  return redactSecrets(text);
}

function redactSecrets(text: string): string {
  return text
    .replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, "Authorization: Bearer [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/g, "Bearer [redacted]")
    .replace(SECRET_ASSIGN_RE, (full, prefix: string) => {
      const value = full.slice(prefix.length);
      if (value.startsWith('"')) return `${prefix}"[redacted]"`;
      if (value.startsWith("'")) return `${prefix}'[redacted]'`;
      return `${prefix}[redacted]`;
    })
    .replace(/\bsk-[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]");
}

function boundEntries(entries: DiagnosticLogEntry[]): DiagnosticLogEntry[] {
  const next = entries.slice(-MAX_LOG_ENTRIES);
  while (next.length > 1 && encodedBytes(next) > MAX_LOG_BYTES) next.shift();
  if (next.length === 1 && encodedBytes(next) > MAX_LOG_BYTES) {
    next[0] = fitEntry(next[0], MAX_LOG_BYTES);
  }
  return next;
}

function encodedBytes(entries: DiagnosticLogEntry[]): number {
  let total = 0;
  for (const entry of entries) total += lineBytes(entry);
  return total;
}

function lineBytes(entry: DiagnosticLogEntry): number {
  return Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8");
}

function fitEntry(entry: DiagnosticLogEntry, maxBytes: number): DiagnosticLogEntry {
  if (lineBytes(entry) <= maxBytes) return entry;
  let lo = 0;
  let hi = Buffer.byteLength(entry.text, "utf8");
  let text = "";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const probeText = truncateUtf8(entry.text, mid);
    const probe = { ...entry, text: probeText };
    if (lineBytes(probe) <= maxBytes) {
      text = probeText;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { ...entry, text };
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function parseLogFile(raw: string): DiagnosticLogEntry[] {
  const entries: DiagnosticLogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<DiagnosticLogEntry>;
      if (
        typeof parsed.at !== "string" ||
        (parsed.channel !== "stdout" && parsed.channel !== "stderr" && parsed.channel !== "lifecycle") ||
        typeof parsed.text !== "string"
      ) {
        continue;
      }
      entries.push({ at: parsed.at, channel: parsed.channel, text: sanitizeLogText(parsed.text) });
    } catch {
      /* skip corrupt line */
    }
  }
  return entries;
}

function readLogTail(path: string, size: number): string {
  if (size <= 0) return "";
  const length = size > MAX_LOG_BYTES ? MAX_LOG_BYTES : size;
  const start = size - length;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    let text = buf.subarray(0, n).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl === -1) return "";
      text = text.slice(nl + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function isInside(rootReal: string, targetReal: string): boolean {
  const root = rootReal.toLowerCase();
  const target = targetReal.toLowerCase();
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function sameResolved(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
