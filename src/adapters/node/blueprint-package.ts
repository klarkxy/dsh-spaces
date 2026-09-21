import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { Parser } from "tar/parse";
import type { ReadEntry } from "tar/read-entry";
import { assertNotRealHome, isInsideRealHome } from "./home-guard";
import {
  archiveAbsPath,
  isHubPluginArchive,
  lookupLibraryEntry,
  pluginArchiveDir,
  pluginLibraryPath,
} from "./plugin-library";
import {
  DOWNLOAD_ARCHIVE_MAX_BYTES,
  downloadPlugin,
  type PluginFetcher,
} from "./plugin-ops";
import {
  type BlueprintPackage,
  type BlueprintPackageSource,
} from "../../shared/blueprint";
import { isBareNpmPackageName } from "../../shared/plugin";
import { isExactRuntimeVersion } from "../../shared/runtime";

export type { BlueprintPackage, BlueprintPackageSource };

export type PreparedBlueprintPackage = {
  archivePath: string;
  name: string;
  version: string;
  integrity: string;
  hasBundle: boolean;
  bundlePatch?: string;
  lifecycleScripts: string[];
};

export type BlueprintPackageErrorCode =
  | "github-unsupported"
  | "source-unsupported"
  | "invalid-name"
  | "invalid-version"
  | "invalid-integrity"
  | "integrity-mismatch"
  | "identity-mismatch"
  | "archive-escape"
  | "archive-missing"
  | "archive-too-large"
  | "archive-corrupt"
  | "manifest-missing"
  | "manifest-invalid"
  | "bundle-patch-missing"
  | "bundle-patch-invalid"
  | "download-failed";

export class BlueprintPackageError extends Error {
  readonly code: BlueprintPackageErrorCode;

  constructor(code: BlueprintPackageErrorCode, message: string) {
    super(message);
    this.name = "BlueprintPackageError";
    this.code = code;
  }
}

const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;
const TAR_TIMEOUT_MS = 15_000;
const MAX_TAR_UNCOMPRESSED = DOWNLOAD_ARCHIVE_MAX_BYTES;
const MAX_TAR_MEMBERS = 65_536;
const MAX_TAR_META = 1 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAX_PATCH_BYTES = 1 * 1024 * 1024;
const INTEGRITY_RE = /^sha512-([A-Za-z0-9+/]{86}==)$/;
const PACKAGE_MANIFEST = "package/package.json";
const ROOT_MANIFEST = "package.json";

const ERROR_MESSAGE: Record<BlueprintPackageErrorCode, string> = {
  "github-unsupported": "Blueprint GitHub package source is not supported.",
  "source-unsupported": "Blueprint package source is not supported.",
  "invalid-name": "Blueprint package name is invalid.",
  "invalid-version": "Blueprint package version must be exact.",
  "invalid-integrity": "Blueprint package integrity is invalid.",
  "integrity-mismatch": "Blueprint package integrity does not match the archive.",
  "identity-mismatch": "Blueprint package identity does not match the archive manifest.",
  "archive-escape": "Blueprint package archive is not a regular file in the Home plugin cache.",
  "archive-missing": "Blueprint package archive is missing.",
  "archive-too-large": "Blueprint package archive exceeds the size limit.",
  "archive-corrupt": "Blueprint package archive is corrupt.",
  "manifest-missing": "Blueprint package manifest is missing.",
  "manifest-invalid": "Blueprint package manifest is invalid.",
  "bundle-patch-missing": "Blueprint package bundle patch is missing.",
  "bundle-patch-invalid": "Blueprint package bundle patch is invalid.",
  "download-failed": "Blueprint package download failed.",
};

export async function prepareBlueprintPackage(
  home: string,
  pkg: BlueprintPackage,
  options: { fetchImpl?: PluginFetcher; signal?: AbortSignal } = {},
): Promise<PreparedBlueprintPackage> {
  assertNotRealHome(home);
  throwIfAborted(options.signal);

  const name = readDeclaredName(pkg);
  const version = readDeclaredVersion(pkg);
  const sourceType = readSourceType(pkg);
  if (sourceType === "github") throw packageError("github-unsupported");
  if (sourceType !== "npm") throw packageError("source-unsupported");
  const expectedIntegrity = readDeclaredIntegrity(pkg);

  throwIfAborted(options.signal);
  assertPluginCacheBoundary(home, name, version);
  throwIfAborted(options.signal);
  let entry;
  try {
    entry = await downloadPlugin(
      home,
      { spec: `${name}@${version}` },
      { fetchImpl: options.fetchImpl, signal: options.signal },
    );
  } catch (error) {
    throwIfAborted(options.signal);
    if (isAbortError(error)) throw abortError();
    if (error instanceof BlueprintPackageError) throw error;
    throw packageError("download-failed");
  }

  throwIfAborted(options.signal);
  const archivePath = resolveHubPluginArchive(home, entry.tarball);
  const bytes = readArchiveBytes(archivePath);
  const integrity = sha512Sri(bytes);
  if (expectedIntegrity && !integrityEquals(expectedIntegrity, integrity)) {
    throw packageError("integrity-mismatch");
  }

  throwIfAborted(options.signal);
  const scan = await inspectArchive(bytes, options.signal);
  const manifestMember = requireRegularMember(
    scan,
    PACKAGE_MANIFEST,
    "manifest-missing",
    "manifest-invalid",
  );
  if (manifestMember.size > MAX_MANIFEST_BYTES) throw packageError("manifest-invalid");
  if ((scan.byNormalized.get(ROOT_MANIFEST) ?? []).length > 0) {
    throw packageError("manifest-invalid");
  }
  const manifestBytes = scan.manifestBody ?? Buffer.alloc(0);
  if (manifestBytes.length !== manifestMember.size) throw packageError("archive-corrupt");
  const manifest = parseSingleJsonObject(manifestBytes);
  const actualName = readObtainedString(manifest.name);
  const actualVersion = readObtainedString(manifest.version);
  if (actualName === undefined || actualVersion === undefined || actualName !== name || actualVersion !== version) {
    throw packageError("identity-mismatch");
  }

  const bundle = readBundlePatch(manifest, scan);
  const prepared: PreparedBlueprintPackage = {
    archivePath,
    name: actualName,
    version: actualVersion,
    integrity,
    hasBundle: bundle.hasBundle,
    lifecycleScripts: readLifecycleScripts(manifest),
  };
  if (bundle.bundlePatch) prepared.bundlePatch = bundle.bundlePatch;
  return prepared;
}

function packageError(code: BlueprintPackageErrorCode): BlueprintPackageError {
  return new BlueprintPackageError(code, ERROR_MESSAGE[code]);
}

function readDeclaredName(pkg: BlueprintPackage): string {
  if (!isPlainObject(pkg) || typeof pkg.name !== "string") throw packageError("invalid-name");
  const name = pkg.name.trim();
  if (!isBareNpmPackageName(name)) throw packageError("invalid-name");
  return name;
}

function readDeclaredVersion(pkg: BlueprintPackage): string {
  if (typeof pkg.version !== "string") throw packageError("invalid-version");
  const version = pkg.version.trim();
  if (!isExactRuntimeVersion(version)) throw packageError("invalid-version");
  return version;
}

function readSourceType(pkg: BlueprintPackage): string {
  const source = pkg.source;
  if (!isPlainObject(source) || typeof source.type !== "string" || !source.type.trim()) {
    throw packageError("source-unsupported");
  }
  return source.type.trim();
}

function readDeclaredIntegrity(pkg: BlueprintPackage): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(pkg, "integrity") || pkg.integrity === undefined) {
    return undefined;
  }
  if (typeof pkg.integrity !== "string") throw packageError("invalid-integrity");
  const integrity = pkg.integrity.trim();
  if (!decodeIntegrity(integrity)) throw packageError("invalid-integrity");
  return integrity;
}

function assertPluginCacheBoundary(home: string, name: string, version: string): void {
  const homeRoot = resolve(home);
  const realHome = inspectExistingNode(homeRoot, "dir");
  refuseProtectedHomeAlias(homeRoot, realHome);
  assertManagedCacheNode(homeRoot, realHome, resolve(homeRoot, "hub"), "dir");
  assertManagedCacheNode(homeRoot, realHome, resolve(pluginArchiveDir(home)), "dir");
  assertManagedCacheNode(homeRoot, realHome, resolve(pluginLibraryPath(home)), "file");
  const dest = resolve(archiveAbsPath(home, `${name}@${version}`.toLowerCase()));
  const recorded = selectedRecordedTarball(home, name, version);
  if (recorded !== undefined) {
    if (inspectRecordedCacheArchive(homeRoot, realHome, home, recorded) === "absent") {
      assertManagedCacheNode(homeRoot, realHome, dest, "file");
    }
    return;
  }
  assertManagedCacheNode(homeRoot, realHome, dest, "file");
}

function selectedRecordedTarball(home: string, name: string, version: string): string | undefined {
  const library = resolve(pluginLibraryPath(home));
  try {
    lstatSync(library);
  } catch (error) {
    if (isEnoentError(error)) return undefined;
    throw packageError("archive-escape");
  }
  let text: string;
  try {
    text = readFileSync(library, "utf8");
  } catch {
    throw packageError("download-failed");
  }
  try {
    JSON.parse(text);
  } catch {
    throw packageError("download-failed");
  }
  const existing = lookupLibraryEntry(home, `${name}@${version}`.toLowerCase());
  if (typeof existing?.tarball !== "string" || !existing.tarball.trim()) return undefined;
  return existing.tarball;
}

function inspectRecordedCacheArchive(
  homeRoot: string,
  realHome: string,
  home: string,
  recorded: string,
): "hit" | "absent" {
  const archiveRoot = resolve(pluginArchiveDir(home));
  const candidate = resolve(home, recorded);
  if (!lexicallyInside(archiveRoot, candidate) || !lexicallyInside(homeRoot, candidate)) {
    throw packageError("archive-escape");
  }
  let st;
  try {
    st = lstatSync(candidate);
  } catch (error) {
    if (isEnoentError(error)) return "absent";
    throw packageError("archive-escape");
  }
  if (st.isSymbolicLink() || !st.isFile()) throw packageError("archive-escape");
  let realFile: string;
  let realArchiveRoot: string;
  try {
    realFile = realpathSync(candidate);
    realArchiveRoot = realpathSync(archiveRoot);
  } catch {
    throw packageError("archive-escape");
  }
  if (!lexicallyInside(realHome, realFile) || !lexicallyInside(realArchiveRoot, realFile)) {
    throw packageError("archive-escape");
  }
  refuseProtectedHomeAlias(homeRoot, realFile);
  return "hit";
}

function inspectExistingNode(path: string, kind: "dir" | "file"): string {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw packageError("archive-escape");
  }
  if (st.isSymbolicLink() || (kind === "dir" ? !st.isDirectory() : !st.isFile())) {
    throw packageError("archive-escape");
  }
  let real;
  try {
    real = realpathSync(path);
  } catch {
    throw packageError("archive-escape");
  }
  return real;
}

function assertManagedCacheNode(
  homeRoot: string,
  realHome: string,
  target: string,
  kind: "dir" | "file",
): void {
  const resolved = resolve(target);
  if (!lexicallyInside(homeRoot, resolved)) throw packageError("archive-escape");
  let st;
  try {
    st = lstatSync(resolved);
  } catch (error) {
    if (!isEnoentError(error)) throw packageError("archive-escape");
    assertCreatableMissingSuffix(homeRoot, realHome, resolved);
    return;
  }
  if (st.isSymbolicLink() || (kind === "dir" ? !st.isDirectory() : !st.isFile())) {
    throw packageError("archive-escape");
  }
  let real;
  try {
    real = realpathSync(resolved);
  } catch {
    throw packageError("archive-escape");
  }
  if (!lexicallyInside(realHome, real)) throw packageError("archive-escape");
  refuseProtectedHomeAlias(homeRoot, real);
}

function assertCreatableMissingSuffix(homeRoot: string, realHome: string, target: string): void {
  let current = resolve(target);
  const root = resolve(homeRoot);
  for (;;) {
    const parent = dirname(current);
    if (parent === current) throw packageError("archive-escape");
    if (parent === root) {
      if (!lexicallyInside(root, target)) throw packageError("archive-escape");
      return;
    }
    if (!lexicallyInside(root, parent)) throw packageError("archive-escape");
    let st;
    try {
      st = lstatSync(parent);
    } catch (error) {
      if (!isEnoentError(error)) throw packageError("archive-escape");
      current = parent;
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw packageError("archive-escape");
    let realParent;
    try {
      realParent = realpathSync(parent);
    } catch {
      throw packageError("archive-escape");
    }
    if (!lexicallyInside(realHome, realParent)) throw packageError("archive-escape");
    refuseProtectedHomeAlias(root, realParent);
    if (!lexicallyInside(parent, target)) throw packageError("archive-escape");
    return;
  }
}

function refuseProtectedHomeAlias(declaredHome: string, realPath: string): void {
  if (!isInsideRealHome(declaredHome) && isInsideRealHome(realPath)) {
    throw packageError("archive-escape");
  }
}

function isEnoentError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

function resolveHubPluginArchive(home: string, recorded: string | undefined): string {
  if (typeof recorded !== "string" || !recorded.trim()) throw packageError("archive-missing");
  const homeRoot = resolve(home);
  const archiveRoot = resolve(pluginArchiveDir(home));
  const candidate = isAbsolute(recorded.trim()) ? resolve(recorded.trim()) : resolve(home, recorded.trim());
  if (!lexicallyInside(archiveRoot, candidate) || !lexicallyInside(homeRoot, candidate)) {
    throw packageError("archive-escape");
  }
  if (!isHubPluginArchive(home, candidate)) {
    throw existsAsAny(candidate) ? packageError("archive-escape") : packageError("archive-missing");
  }

  let st;
  try {
    st = lstatSync(candidate);
  } catch {
    throw packageError("archive-missing");
  }
  if (st.isSymbolicLink() || !st.isFile()) throw packageError("archive-escape");
  if (st.size <= 0) throw packageError("archive-corrupt");
  if (st.size > DOWNLOAD_ARCHIVE_MAX_BYTES) throw packageError("archive-too-large");

  let realFile: string;
  let realHome: string;
  let realArchiveRoot: string;
  try {
    realFile = realpathSync(candidate);
    realHome = realpathSync(homeRoot);
    realArchiveRoot = realpathSync(archiveRoot);
  } catch {
    throw packageError("archive-escape");
  }
  if (!lexicallyInside(realHome, realFile) || !lexicallyInside(realArchiveRoot, realFile)) {
    throw packageError("archive-escape");
  }

  let realSt;
  try {
    realSt = lstatSync(realFile);
  } catch {
    throw packageError("archive-missing");
  }
  if (realSt.isSymbolicLink() || !realSt.isFile()) throw packageError("archive-escape");
  return realFile;
}

function readArchiveBytes(archivePath: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(archivePath);
  } catch {
    throw packageError("archive-corrupt");
  }
  if (bytes.length <= 0) throw packageError("archive-corrupt");
  if (bytes.length > DOWNLOAD_ARCHIVE_MAX_BYTES) throw packageError("archive-too-large");
  return bytes;
}

function requireRegularMember(
  entries: TarIndex,
  normalizedPath: string,
  missing: BlueprintPackageErrorCode,
  invalid: BlueprintPackageErrorCode,
): TarMember {
  const hits = entries.byNormalized.get(normalizedPath) ?? [];
  if (hits.length === 0) throw packageError(missing);
  if (hits.length !== 1) throw packageError(invalid);
  const member = hits[0];
  if (
    member.kind !== "file"
    || member.linkname
    || member.size < 0
    || !isSafeTarEntry(member.name)
    || normalizeTarPath(member.name) !== normalizedPath
  ) {
    throw packageError(invalid);
  }
  return member;
}

function readBundlePatch(
  manifest: Record<string, unknown>,
  entries: TarIndex,
): { hasBundle: boolean; bundlePatch?: string } {
  if (!isPlainObject(manifest.dsh) || !Object.prototype.hasOwnProperty.call(manifest.dsh, "bundle")) {
    return { hasBundle: false };
  }
  const bundle = manifest.dsh.bundle;
  if (!isPlainObject(bundle)) throw packageError("bundle-patch-invalid");
  if (!Object.prototype.hasOwnProperty.call(bundle, "patch") || bundle.patch === undefined) {
    throw packageError("bundle-patch-missing");
  }
  if (typeof bundle.patch !== "string") throw packageError("bundle-patch-invalid");
  const rel = normalizePackageRelative(bundle.patch);
  const member = requireRegularMember(entries, `package/${rel}`, "bundle-patch-missing", "bundle-patch-invalid");
  if (member.size > MAX_PATCH_BYTES) throw packageError("bundle-patch-invalid");
  return { hasBundle: true, bundlePatch: rel };
}

function normalizePackageRelative(value: string): string {
  let rel = value.trim().replaceAll("\\", "/");
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("/")) {
    throw packageError("bundle-patch-invalid");
  }
  const parts = rel.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw packageError("bundle-patch-invalid");
  }
  return parts.join("/");
}

function readLifecycleScripts(manifest: Record<string, unknown>): string[] {
  if (!isPlainObject(manifest.scripts)) return [];
  const scripts = manifest.scripts;
  return LIFECYCLE_SCRIPTS.filter((name) => Object.prototype.hasOwnProperty.call(scripts, name));
}

function parseSingleJsonObject(bytes: Buffer): Record<string, unknown> {
  if (bytes.includes(0)) throw packageError("manifest-invalid");
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  const trimmed = bytes.subarray(offset).toString("utf8").trim();
  if (!trimmed) throw packageError("manifest-invalid");
  let wrapped: unknown;
  try {
    wrapped = JSON.parse(`[${trimmed}]`) as unknown;
  } catch {
    throw packageError("manifest-invalid");
  }
  if (!Array.isArray(wrapped) || wrapped.length !== 1 || !isPlainObject(wrapped[0])) {
    throw packageError("manifest-invalid");
  }
  return wrapped[0];
}

function readObtainedString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sha512Sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function decodeIntegrity(value: string): Buffer | undefined {
  const match = INTEGRITY_RE.exec(value);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1], "base64");
  if (decoded.length !== 64) return undefined;
  const roundTrip = decoded.toString("base64");
  if (roundTrip !== match[1]) return undefined;
  return decoded;
}

function integrityEquals(declared: string, actual: string): boolean {
  const left = decodeIntegrity(declared);
  const right = decodeIntegrity(actual);
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

type TarKind = "file" | "hardlink" | "symlink" | "directory" | "other";

type TarMember = {
  name: string;
  kind: TarKind;
  size: number;
  linkname: string;
};

type TarIndex = {
  byNormalized: Map<string, TarMember[]>;
  manifestBody?: Buffer;
};

function inspectArchive(gzipBytes: Buffer, signal: AbortSignal | undefined): Promise<TarIndex> {
  throwIfAborted(signal);
  return new Promise((resolvePromise, reject) => {
    const gunzip = createGunzip();
    const parser = new Parser({ strict: true, maxMetaEntrySize: MAX_TAR_META });
    const byNormalized = new Map<string, TarMember[]>();
    const manifestChunks: Buffer[] = [];
    let settled = false;
    let uncompressed = 0;
    let members = 0;
    let collectingManifest = false;
    let manifestSeen = 0;
    let paused = false;

    const finish = (error?: Error, value?: TarIndex) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!gunzip.destroyed) gunzip.destroy();
      if (error) {
        try {
          parser.abort(error);
        } catch {
          /* parser may already be finished */
        }
        gunzip.removeAllListeners();
        parser.removeAllListeners();
        reject(error);
      } else {
        gunzip.removeAllListeners();
        parser.removeAllListeners();
        resolvePromise(value ?? { byNormalized });
      }
    };
    const fail = (error: Error) => finish(isAbortError(error) || signal?.aborted ? abortError() : error instanceof BlueprintPackageError ? error : packageError("archive-corrupt"));
    const onAbort = () => fail(abortError());
    const timer = setTimeout(() => fail(packageError("archive-corrupt")), TAR_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) {
        fail(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    parser.on("entry", (entry: ReadEntry) => {
      if (settled) {
        entry.resume();
        return;
      }
      members += 1;
      if (members > MAX_TAR_MEMBERS) {
        entry.resume();
        fail(packageError("archive-too-large"));
        return;
      }
      const name = normalizeTarPath(entry.path);
      const kind = tarKindFromType(entry.type);
      if (name) {
        const current = byNormalized.get(name);
        const member: TarMember = {
          name,
          kind,
          size: kind === "file" ? entry.size : 0,
          linkname: kind === "file" ? "" : (entry.linkpath ?? ""),
        };
        if (current) current.push(member);
        else byNormalized.set(name, [member]);
      }
      const takeManifest = name === PACKAGE_MANIFEST && kind === "file" && entry.size <= MAX_MANIFEST_BYTES && !collectingManifest;
      if (takeManifest) {
        collectingManifest = true;
        entry.on("data", (chunk: Buffer) => {
          if (settled) return;
          manifestSeen += chunk.length;
          if (manifestSeen > MAX_MANIFEST_BYTES) {
            fail(packageError("manifest-invalid"));
            return;
          }
          manifestChunks.push(chunk);
        });
      }
      entry.resume();
    });
    parser.on("error", (error: Error) => fail(error));
    parser.on("end", () => {
      finish(undefined, {
        byNormalized,
        manifestBody: collectingManifest ? Buffer.concat(manifestChunks, manifestSeen) : undefined,
      });
    });
    parser.on("drain", () => {
      if (!paused || settled) return;
      paused = false;
      gunzip.resume();
    });

    gunzip.on("data", (chunk: Buffer) => {
      if (settled) return;
      uncompressed += chunk.length;
      if (uncompressed > MAX_TAR_UNCOMPRESSED) {
        fail(packageError("archive-too-large"));
        return;
      }
      try {
        if (!parser.write(chunk) && !settled) {
          paused = true;
          gunzip.pause();
        }
      } catch (error) {
        fail(error instanceof Error ? error : packageError("archive-corrupt"));
      }
    });
    gunzip.on("error", (error: Error) => fail(error));
    gunzip.on("end", () => {
      if (settled) return;
      try {
        parser.end();
      } catch (error) {
        fail(error instanceof Error ? error : packageError("archive-corrupt"));
      }
    });

    try {
      gunzip.end(gzipBytes);
    } catch (error) {
      fail(error instanceof Error ? error : packageError("archive-corrupt"));
    }
  });
}

function tarKindFromType(type: string): TarKind {
  if (type === "File" || type === "OldFile") return "file";
  if (type === "Link") return "hardlink";
  if (type === "SymbolicLink") return "symlink";
  if (type === "Directory") return "directory";
  return "other";
}

function normalizeTarPath(entry: string): string {
  let normalized = entry.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

function isSafeTarEntry(entry: string): boolean {
  const normalized = normalizeTarPath(entry);
  if (!normalized || normalized.includes("\0") || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return false;
  }
  return normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function lexicallyInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function existsAsAny(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name: unknown }).name === "AbortError");
}

function abortError(): Error {
  const error = new Error("The blueprint package request was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}
