import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { atomicWrite } from "./atomic";
import { PROFILE_NAME_RE } from "../../shared/types";

export const XP_PACKAGE_NAME = "dsh-client-ui-theme-xp";
export const XP_SUPPORTED_VERSION = "0.1.1";
export const XP_ORIGINAL_CLIENT_SHA256 =
  "64f1f7e3555237c637112091647932e1418aca5f0d3ba399e261d94a33c83ee0";
export const XP_PATCHED_CLIENT_SHA256 =
  "b87a28bc1650668e019e2588e2bac5c1259f1e0a631ca8ed2601d4be66eec8e3";
export const XP_COMPAT_RECORD_NAME = ".dsh-spaces-xp-compat.json";
export const XP_VIEW_HINT_GLOBAL = "__DSH_SPACES_VIEW__";

/** User-facing plan sentence. Hashes stay on the exported constants and the private compat record. */
export const XP_EMBED_COMPATIBILITY_NOTE =
  "当前 XP 主题不能原生在 iframe 里作为桌面运行；确认后只会为这个空间做桌面嵌入适配，内部聊天窗口保持原样。";

const ORIGINAL_ISTOPWINDOW = [
  "function isTopWindow() {",
  "\t\t\ttry {",
  "\t\t\t\treturn window.self === window.top;",
  "\t\t\t} catch (e) {",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t}",
].join("\n");

const PATCHED_ISTOPWINDOW = [
  "function isTopWindow() {",
  "\t\t\ttry {",
  "\t\t\t\tif (window.self === window.top) return true;",
  "\t\t\t} catch (e) { }",
  "\t\t\ttry {",
  "\t\t\t\tvar frame;",
  "\t\t\t\ttry { frame = window.frameElement; } catch (e) { return false; }",
  "\t\t\t\tif (frame !== null) return false;",
  `\t\t\t\tvar hint = window.${XP_VIEW_HINT_GLOBAL};`,
  "\t\t\t\tif (!hint || typeof hint !== \"object\" || Array.isArray(hint)) return false;",
  "\t\t\t\tvar parentOrigin = hint.parentOrigin;",
  "\t\t\t\tvar spaceId = hint.spaceId;",
  "\t\t\t\tvar generation = hint.generation;",
  "\t\t\t\tvar channel = hint.channel;",
  "\t\t\t\tif (typeof parentOrigin !== \"string\" || parentOrigin !== parentOrigin.trim() || !parentOrigin) return false;",
  "\t\t\t\tif (typeof spaceId !== \"string\" || spaceId !== spaceId.trim() || !spaceId) return false;",
  "\t\t\t\tif (typeof generation !== \"number\" || !Number.isSafeInteger(generation) || generation < 0) return false;",
  "\t\t\t\tif (typeof channel !== \"string\" || channel !== channel.trim() || !channel) return false;",
  "\t\t\t\tif (channel.length > 128) return false;",
  "\t\t\t\tif (spaceId !== \"web\" && !/^[a-z0-9][a-z0-9-]{0,38}$/.test(spaceId)) return false;",
  "\t\t\t\tif (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channel)) return false;",
  "\t\t\t\tvar parsed = new URL(parentOrigin);",
  "\t\t\t\tif (parsed.protocol !== \"http:\" && parsed.protocol !== \"https:\") return false;",
  "\t\t\t\tif (parsed.hostname !== \"127.0.0.1\") return false;",
  "\t\t\t\tif (parsed.username || parsed.password) return false;",
  "\t\t\t\tif (parsed.pathname !== \"/\" && parsed.pathname !== \"\") return false;",
  "\t\t\t\tif (parsed.search || parsed.hash) return false;",
  "\t\t\t\tif (parsed.origin === window.location.origin) return false;",
  "\t\t\t\treturn true;",
  "\t\t\t} catch (e) {",
  "\t\t\t\treturn false;",
  "\t\t\t}",
  "\t\t}",
].join("\n");

export type XpCompatibilityErrorCode =
  | "invalid-input"
  | "not-found"
  | "unsupported"
  | "hash-mismatch"
  | "out-of-profile";

export class XpCompatibilityError extends Error {
  readonly code: XpCompatibilityErrorCode;
  constructor(code: XpCompatibilityErrorCode, message: string) {
    super(message);
    this.name = "XpCompatibilityError";
    this.code = code;
  }
}

export interface XpEmbedCompatibilityResult {
  /** True only when this call replaced client.js. Idempotent success is false with the same hashes. */
  applied: boolean;
  packageName: string;
  version: string;
  originalSha256: string;
  patchedSha256: string;
}

interface CompatRecord {
  packageName: string;
  version: string;
  originalSha256: string;
  patchedSha256: string;
  file: "client.js";
}

export function applyXpEmbedCompatibility(home: string, spaceId: string): XpEmbedCompatibilityResult {
  if (typeof home !== "string" || !home.trim() || typeof spaceId !== "string" || !PROFILE_NAME_RE.test(spaceId)) {
    throw new XpCompatibilityError(
      "invalid-input",
      "XP embed compatibility requires a Home path and a PROFILE_NAME_RE space id; paths are not accepted.",
    );
  }

  const profile = containedProfile(home, spaceId);
  const packageDir = containedDir(join(profile.lexical, "node_modules", XP_PACKAGE_NAME), profile.real);
  const manifestPath = containedFile(join(packageDir.lexical, "package.json"), profile.real);
  const clientPath = containedFile(join(packageDir.lexical, "client.js"), profile.real);

  const manifest = readManifest(manifestPath.real);
  const originalBytes = readFileSync(clientPath.real);
  const currentSha = sha256(originalBytes);
  const source = originalBytes.toString("utf8");
  if (!originalBytes.equals(Buffer.from(source, "utf8"))) {
    throw new XpCompatibilityError("hash-mismatch", "XP client.js is not valid UTF-8 and will not be patched.");
  }

  const patchedSource = patchClientSource(source, currentSha, manifest.version);
  const patchedSha = sha256(Buffer.from(patchedSource, "utf8"));
  const wroteClient = currentSha !== patchedSha;
  const result: XpEmbedCompatibilityResult = {
    applied: wroteClient,
    packageName: XP_PACKAGE_NAME,
    version: XP_SUPPORTED_VERSION,
    originalSha256: XP_ORIGINAL_CLIENT_SHA256,
    patchedSha256: patchedSha,
  };

  if (wroteClient) atomicWrite(clientPath.real, patchedSource);
  writeCompatRecord(join(dirname(clientPath.real), XP_COMPAT_RECORD_NAME), profile.real, result);
  return result;
}

function patchClientSource(source: string, currentSha: string, version: string): string {
  if (version !== XP_SUPPORTED_VERSION) {
    throw new XpCompatibilityError(
      "unsupported",
      `Refusing to patch ${XP_PACKAGE_NAME}@${version}; only ${XP_SUPPORTED_VERSION} with pinned client.js is supported.`,
    );
  }
  if (currentSha === XP_PATCHED_CLIENT_SHA256) return source;
  if (currentSha === XP_ORIGINAL_CLIENT_SHA256) {
    if (countOccurrences(source, ORIGINAL_ISTOPWINDOW) !== 1) {
      throw new XpCompatibilityError(
        "hash-mismatch",
        `Pinned ${XP_PACKAGE_NAME} client.js does not contain exactly one isTopWindow() implementation.`,
      );
    }
    const patched = source.replace(ORIGINAL_ISTOPWINDOW, PATCHED_ISTOPWINDOW);
    if (sha256(Buffer.from(patched, "utf8")) !== XP_PATCHED_CLIENT_SHA256) {
      throw new XpCompatibilityError(
        "hash-mismatch",
        `Patching ${XP_PACKAGE_NAME}@${version} did not produce the pinned patched client.js.`,
      );
    }
    return patched;
  }
  throw new XpCompatibilityError(
    "hash-mismatch",
    `Refusing to patch ${XP_PACKAGE_NAME}@${version}: client.js SHA256 ${currentSha} is neither the pinned original nor the expected Spaces embed patch.`,
  );
}

function readManifest(path: string): { name: string; version: string } {
  let parsed: { name?: unknown; version?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  } catch {
    throw new XpCompatibilityError("unsupported", `Unable to read ${XP_PACKAGE_NAME} package.json.`);
  }
  if (parsed.name !== XP_PACKAGE_NAME) {
    throw new XpCompatibilityError(
      "unsupported",
      `Package at the XP path is ${String(parsed.name)}; callers must not invoke this adapter for other packages.`,
    );
  }
  if (typeof parsed.version !== "string" || !parsed.version) {
    throw new XpCompatibilityError("unsupported", `${XP_PACKAGE_NAME} package.json has no version.`);
  }
  return { name: parsed.name, version: parsed.version };
}

function writeCompatRecord(path: string, profileReal: string, result: XpEmbedCompatibilityResult): void {
  const record: CompatRecord = {
    packageName: result.packageName,
    version: result.version,
    originalSha256: result.originalSha256,
    patchedSha256: result.patchedSha256,
    file: "client.js",
  };
  assertLexicalInside(profileReal, path);
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
}

function containedProfile(home: string, spaceId: string): { lexical: string; real: string } {
  const homeLexical = resolve(home);
  const homeReal = existingRealDir(homeLexical) ?? homeLexical;
  const lexical = join(homeLexical, "profiles", spaceId);
  assertLexicalInside(homeReal, lexical);
  return { lexical, real: containedDir(lexical, homeReal).real };
}

function containedDir(lexical: string, root: string): { lexical: string; real: string } {
  const real = resolveExisting(lexical, root);
  try {
    if (!lstatSync(real).isDirectory()) {
      throw new XpCompatibilityError("not-found", `XP package path is not a directory: ${real}`);
    }
  } catch (error) {
    if (error instanceof XpCompatibilityError) throw error;
    throw new XpCompatibilityError("not-found", `XP package path is not a directory: ${real}`);
  }
  return { lexical: resolve(lexical), real };
}

function containedFile(lexical: string, root: string): { lexical: string; real: string } {
  const real = resolveExisting(lexical, root);
  try {
    if (!lstatSync(real).isFile()) {
      throw new XpCompatibilityError("not-found", `XP client path is not a file: ${real}`);
    }
  } catch (error) {
    if (error instanceof XpCompatibilityError) throw error;
    throw new XpCompatibilityError("not-found", `XP client path is not a file: ${real}`);
  }
  return { lexical: resolve(lexical), real };
}

function resolveExisting(lexical: string, root: string): string {
  const resolved = resolve(lexical);
  assertLexicalInside(root, resolved);
  try {
    lstatSync(resolved);
  } catch {
    throw new XpCompatibilityError("not-found", `XP package path was not found under the profile: ${resolved}`);
  }
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    throw new XpCompatibilityError("out-of-profile", `XP path could not be resolved inside the profile: ${resolved}`);
  }
  if (!inside(root, real)) {
    throw new XpCompatibilityError("out-of-profile", `XP path resolves outside the profile: ${real}`);
  }
  return real;
}

function existingRealDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return lstatSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function assertLexicalInside(root: string, target: string): void {
  const resolved = resolve(target);
  if (!inside(root, resolved)) {
    throw new XpCompatibilityError("out-of-profile", `XP path is outside the profile: ${resolved}`);
  }
}

function inside(root: string, target: string): boolean {
  const r = comparable(root);
  const t = comparable(target);
  if (r === t) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

function comparable(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function countOccurrences(source: string, snippet: string): number {
  if (!snippet) return 0;
  let count = 0;
  let from = 0;
  while (from <= source.length) {
    const at = source.indexOf(snippet, from);
    if (at < 0) return count;
    count += 1;
    from = at + snippet.length;
  }
  return count;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
