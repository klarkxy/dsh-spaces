import { lstatSync, realpathSync } from "../../../shared/node/filesystem";
/** Node-only v2 component payload. Do not import this from browser shared contracts. */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { list as listTarArchive } from "tar";
import { atomicWrite } from "../atomic";
import { assertNotRealHome, isInsideRealHome } from "../home/home-guard";
import { isExactRuntimeVersion } from "../../../shared/runtime";

export const COMPONENT_PAYLOAD_SCHEMA_VERSION = 2 as const;
export const COMPONENT_PAYLOAD_PROTOCOL_VERSION = 2 as const;
export const COMPONENT_PAYLOAD_SOURCE = "bundled" as const;
export const COMPONENT_PAYLOAD_SUPERVISOR_ENTRY = "index.js" as const;
export const COMPONENT_PAYLOAD_MANIFEST_REL = "lib/supervisor/manifest.json" as const;
export const COMPONENT_PAYLOAD_CODE = "component-payload/invalid" as const;

const DIGEST_PREFIX = "dsh-spaces-component-payload-v2:";
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMPAT_VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MANIFEST_KEYS = ["schemaVersion", "protocolVersion", "version", "entry", "components"] as const;
const COMPONENT_KEYS = ["name", "packageName", "version", "entry", "source", "protocolVersion", "files"] as const;
const FILE_KEYS = ["path", "sha256", "size"] as const;

export const COMPONENT_PAYLOAD_NAMES = [
  "supervisor",
  "manager-plugin",
  "view-bridge",
  "browser",
  "llm-bridge",
  "installation-worker",
] as const;

export type ComponentPayloadName = (typeof COMPONENT_PAYLOAD_NAMES)[number];

export const COMPONENT_PAYLOAD_PACKAGES: Record<ComponentPayloadName, string> = {
  supervisor: "@dsh-spaces/supervisor",
  "manager-plugin": "@dsh-spaces/plugin",
  "view-bridge": "@dsh-spaces/view-bridge",
  browser: "@dsh-spaces/browser",
  "llm-bridge": "@dsh-spaces/llm-bridge",
  "installation-worker": "@dsh-spaces/supervisor",
};

export const COMPONENT_PAYLOAD_ENTRIES: Record<ComponentPayloadName, string> = {
  supervisor: "lib/supervisor/index.js",
  "manager-plugin": "lib/index.js",
  "view-bridge": "lib/view-bridge/lib/index.js",
  browser: "lib/browser/lib/index.js",
  "llm-bridge": "lib/llm-bridge/lib/index.js",
  "installation-worker": "lib/supervisor/snapshot-worker.mjs",
};

/**
 * The pinned UI automation engine: playwright-core copied verbatim next to
 * the supervisor bundle so the packaged payload never resolves it through a
 * profile's node_modules. The loader (ui-playwright.ts) imports only
 * UI_ENGINE_ENTRY_PATH at this fixed position.
 */
export const UI_ENGINE_PACKAGE_VERSION = "1.62.1";
export const UI_ENGINE_DIR_REL = "lib/supervisor/ui-engine";
export const UI_ENGINE_MANIFEST_REL = `${UI_ENGINE_DIR_REL}/node_modules/playwright-core/package.json`;
export const UI_ENGINE_ENTRY_PATH = `${UI_ENGINE_DIR_REL}/node_modules/playwright-core/index.mjs`;

export const COMPONENT_PAYLOAD_REQUIRED_FILES: Record<ComponentPayloadName, readonly string[]> = {
  supervisor: [
    "lib/supervisor/package.json",
    "lib/supervisor/index.js",
    UI_ENGINE_MANIFEST_REL,
    UI_ENGINE_ENTRY_PATH,
    `${UI_ENGINE_DIR_REL}/node_modules/playwright-core/index.js`,
  ],
  "manager-plugin": [
    "package.json",
    "cordis.patch.yml",
    "lib/index.js",
    "lib/typert.host.js",
    "lib/typert.remote-client.js",
    "lib/client.js",
    "lib/space-control.js",
  ],
  "view-bridge": [
    "lib/view-bridge/package.json",
    "lib/view-bridge/cordis.patch.yml",
    "lib/view-bridge/lib/index.js",
    "lib/view-bridge/lib/client.js",
    "lib/view-bridge/lib/settings.js",
    "lib/view-bridge/lib/typert.host.js",
  ],
  browser: [
    "lib/browser/package.json", "lib/browser/cordis.patch.yml", "lib/browser/lib/index.js",
    "lib/browser/lib/client.js", "lib/browser/lib/typert.host.js",
  ],
  "llm-bridge": [
    "lib/llm-bridge/package.json", "lib/llm-bridge/cordis.patch.yml",
    "lib/llm-bridge/lib/index.js", "lib/llm-bridge/lib/auxiliary.js",
  ],
  "installation-worker": ["lib/supervisor/snapshot-worker.mjs"],
};

export const COMPONENT_PAYLOAD_OPTIONAL_FILES: Record<ComponentPayloadName, readonly string[]> = {
  supervisor: ["lib/supervisor/LICENSE"],
  "manager-plugin": ["LICENSE"],
  "view-bridge": ["lib/view-bridge/LICENSE"],
  browser: ["lib/browser/LICENSE"],
  "llm-bridge": ["lib/llm-bridge/LICENSE"],
  "installation-worker": [],
};

const IDENTITY_JSON: Record<ComponentPayloadName, string> = {
  supervisor: "lib/supervisor/package.json",
  "manager-plugin": "package.json",
  "view-bridge": "lib/view-bridge/package.json",
  browser: "lib/browser/package.json",
  "llm-bridge": "lib/llm-bridge/package.json",
  "installation-worker": "lib/supervisor/package.json",
};

export type ComponentPayloadFile = {
  path: string;
  sha256: string;
  size: number;
};

export type ComponentPayloadComponent = {
  name: ComponentPayloadName;
  packageName: string;
  version: string;
  entry: string;
  source: typeof COMPONENT_PAYLOAD_SOURCE;
  protocolVersion: typeof COMPONENT_PAYLOAD_PROTOCOL_VERSION;
  files: ComponentPayloadFile[];
};

export type ComponentPayloadComponents = {
  [K in ComponentPayloadName]: ComponentPayloadComponent;
};

export type ComponentPayloadManifest = {
  schemaVersion: typeof COMPONENT_PAYLOAD_SCHEMA_VERSION;
  protocolVersion: typeof COMPONENT_PAYLOAD_PROTOCOL_VERSION;
  version: string;
  entry: typeof COMPONENT_PAYLOAD_SUPERVISOR_ENTRY;
  components: ComponentPayloadComponents;
};

export type ValidatedComponentPayload = {
  manifest: ComponentPayloadManifest;
  digest: string;
  files: ComponentPayloadFile[];
  packageRoot: string;
  payloadRootLib: string;
};

export class ComponentPayloadError extends Error {
  readonly name = "ComponentPayloadError";
  readonly code = COMPONENT_PAYLOAD_CODE;
  constructor(message: string) {
    super(message);
  }
}

export function validateComponentPayload(payloadRootLib: string): ValidatedComponentPayload {
  const roots = resolvePayloadRoots(payloadRootLib);
  const manifestPath = joinFromRel(roots.packageRoot, COMPONENT_PAYLOAD_MANIFEST_REL);
  const listed = readRegularFile(roots.packageRoot, COMPONENT_PAYLOAD_MANIFEST_REL);
  const parsed = parseComponentPayloadManifest(JSON.parse(listed.bytes.toString("utf8")));
  assertDeclaredFiles(roots.packageRoot, parsed, manifestPath);
  return freezeResult(parsed, roots);
}

/** Build the v2 manifest from files already in the plugin package and write it. */
export function writeComponentPayloadManifest(payloadRootLib: string): ValidatedComponentPayload {
  const roots = resolvePayloadRoots(payloadRootLib);
  const components = {} as ComponentPayloadComponents;
  for (const name of COMPONENT_PAYLOAD_NAMES) {
    const identity = readPackageIdentity(roots.packageRoot, IDENTITY_JSON[name]);
    if (identity.name !== COMPONENT_PAYLOAD_PACKAGES[name]) {
      throw fail(
        `Component ${name} package name must be ${COMPONENT_PAYLOAD_PACKAGES[name]}, got ${identity.name}.`,
      );
    }
    components[name] = {
      name,
      packageName: identity.name,
      version: identity.version,
      entry: COMPONENT_PAYLOAD_ENTRIES[name],
      source: COMPONENT_PAYLOAD_SOURCE,
      protocolVersion: COMPONENT_PAYLOAD_PROTOCOL_VERSION,
      files: collectComponentFiles(roots.packageRoot, name),
    };
  }
  const manifest = normalizeManifest({
    schemaVersion: COMPONENT_PAYLOAD_SCHEMA_VERSION,
    protocolVersion: COMPONENT_PAYLOAD_PROTOCOL_VERSION,
    version: components.supervisor.version,
    entry: COMPONENT_PAYLOAD_SUPERVISOR_ENTRY,
    components,
  });
  assertDeclaredFiles(roots.packageRoot, manifest, joinFromRel(roots.packageRoot, COMPONENT_PAYLOAD_MANIFEST_REL));
  atomicWrite(joinFromRel(roots.packageRoot, COMPONENT_PAYLOAD_MANIFEST_REL), serializeManifest(manifest));
  return validateComponentPayload(roots.payloadRootLib);
}

/**
 * Copy only declared payload files into a new immutable package root and re-validate.
 * Not a generic tree copier: source src/ and node_modules are never selected.
 */
export function copyComponentPayload(sourceLib: string, destPackageRoot: string): ValidatedComponentPayload {
  const source = validateComponentPayload(sourceLib);
  if (typeof destPackageRoot !== "string" || destPackageRoot.length === 0) {
    throw fail("A destination package root is required.");
  }
  const destAbs = resolve(destPackageRoot);
  if (destAbs.includes("\0")) throw fail("Destination path contains a NUL.");
  if (isInsideRealHome(destAbs)) throw fail("Refusing to copy a component payload into the real DSH home.");
  if (contained(source.packageRoot, destAbs) || contained(destAbs, source.packageRoot)) {
    throw fail("Component payload destination must be outside the source package.");
  }

  if (existsSync(destAbs)) {
    let st;
    try {
      st = lstatSync(destAbs);
    } catch {
      throw fail("Component payload destination could not be read.");
    }
    if (st.isSymbolicLink()) throw fail("Component payload destination is a symlink or junction.");
    if (!st.isDirectory()) throw fail("Component payload destination exists and is not a directory.");
    try {
      const existing = validateComponentPayload(join(destAbs, "lib"));
      if (existing.digest === source.digest) return existing;
    } catch (error) {
      if (!(error instanceof ComponentPayloadError)) throw error;
    }
    throw fail("Component payload destination exists with different content.");
  }

  mkdirSync(destAbs, { recursive: true });
  let destReal: string;
  try {
    destReal = realDirectoryNoLink(destAbs, "destination package root");
  } catch (error) {
    throw error;
  }
  if (isInsideRealHome(destReal)) throw fail("Refusing to copy a component payload into the real DSH home.");
  if (contained(source.packageRoot, destReal) || contained(destReal, source.packageRoot)) {
    throw fail("Component payload destination must be outside the source package.");
  }

  try {
    for (const file of source.files) {
      const from = joinFromRel(source.packageRoot, file.path);
      const to = joinFromRel(destReal, file.path);
      if (!contained(destReal, to) || samePath(destReal, to)) {
        throw fail(`Copied path would escape the destination: ${file.path}`);
      }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
    atomicWrite(joinFromRel(destReal, COMPONENT_PAYLOAD_MANIFEST_REL), serializeManifest(source.manifest));
    return validateComponentPayload(join(destReal, "lib"));
  } catch (error) {
    if (error instanceof ComponentPayloadError) throw error;
    throw fail(
      `Component payload copy did not finish: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }
}

export function serializeManifest(manifest: ComponentPayloadManifest): string {
  return `${JSON.stringify(normalizeManifest(manifest), null, 2)}\n`;
}

export function computeComponentPayloadDigest(manifest: ComponentPayloadManifest): string {
  const files = declaredFiles(manifest);
  const hashes = files.map((file) => `${file.path}:${file.sha256}`).join("\n");
  return sha256(`${DIGEST_PREFIX}${JSON.stringify(stableValue(normalizeManifest(manifest)))}\n${hashes}`);
}

function freezeResult(manifest: ComponentPayloadManifest, roots: PayloadRoots): ValidatedComponentPayload {
  const normalized = normalizeManifest(manifest);
  return {
    manifest: normalized,
    digest: computeComponentPayloadDigest(normalized),
    files: declaredFiles(normalized),
    packageRoot: roots.packageRoot,
    payloadRootLib: roots.payloadRootLib,
  };
}

export function parseComponentPayloadManifest(value: unknown): ComponentPayloadManifest {
  if (!isPlainObject(value)) throw fail("Component payload manifest is not an object.");
  if (!("schemaVersion" in value)) throw fail("Component payload schemaVersion must be 2.");
  if (value.schemaVersion !== COMPONENT_PAYLOAD_SCHEMA_VERSION) {
    throw fail(`Unknown component payload schemaVersion ${String(value.schemaVersion)}.`);
  }
  if (value.protocolVersion !== COMPONENT_PAYLOAD_PROTOCOL_VERSION) {
    throw fail(`Unknown component payload protocolVersion ${String(value.protocolVersion)}.`);
  }
  assertExactKeys(value, MANIFEST_KEYS, "component payload manifest");
  if (value.entry !== COMPONENT_PAYLOAD_SUPERVISOR_ENTRY) {
    throw fail(`Supervisor compatibility entry must be ${COMPONENT_PAYLOAD_SUPERVISOR_ENTRY}.`);
  }
  if (typeof value.version !== "string" || !isExactRuntimeVersion(value.version) || !COMPAT_VERSION_RE.test(value.version)) {
    throw fail("Supervisor compatibility version must be an exact version, not a dist-tag.");
  }
  if (!isPlainObject(value.components)) throw fail("Component payload components must be an object.");
  for (const name of COMPONENT_PAYLOAD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(value.components, name)) {
      throw fail(`Component payload is missing component ${name}.`);
    }
  }
  for (const name of Object.keys(value.components)) {
    if (!isComponentName(name)) throw fail(`Unknown component payload name '${name}'.`);
  }
  const components = {} as ComponentPayloadComponents;
  for (const name of COMPONENT_PAYLOAD_NAMES) {
    components[name] = parseComponent(name, value.components[name]);
  }
  if (value.version !== components.supervisor.version) {
    throw fail("Supervisor compatibility version must match the supervisor component version.");
  }
  return normalizeManifest({
    schemaVersion: COMPONENT_PAYLOAD_SCHEMA_VERSION,
    protocolVersion: COMPONENT_PAYLOAD_PROTOCOL_VERSION,
    version: value.version,
    entry: COMPONENT_PAYLOAD_SUPERVISOR_ENTRY,
    components,
  });
}

function parseComponent(name: ComponentPayloadName, value: unknown): ComponentPayloadComponent {
  if (!isPlainObject(value)) throw fail(`Component ${name} is not an object.`);
  assertExactKeys(value, COMPONENT_KEYS, `component ${name}`);
  if (value.name !== name) throw fail(`Component ${name} name field must be ${name}.`);
  if (typeof value.packageName !== "string" || value.packageName !== COMPONENT_PAYLOAD_PACKAGES[name]) {
    throw fail(`Component ${name} package name must be ${COMPONENT_PAYLOAD_PACKAGES[name]}.`);
  }
  if (typeof value.version !== "string" || !isExactRuntimeVersion(value.version) || !COMPAT_VERSION_RE.test(value.version)) {
    throw fail(`Component ${name} version must be exact, not a dist-tag.`);
  }
  if (typeof value.entry !== "string" || value.entry !== COMPONENT_PAYLOAD_ENTRIES[name]) {
    throw fail(`Component ${name} entry must be ${COMPONENT_PAYLOAD_ENTRIES[name]}.`);
  }
  if (value.source !== COMPONENT_PAYLOAD_SOURCE) throw fail(`Component ${name} source must be bundled.`);
  if (value.protocolVersion !== COMPONENT_PAYLOAD_PROTOCOL_VERSION) {
    throw fail(`Component ${name} protocolVersion must be 2.`);
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw fail(`Component ${name} files must be a non-empty array.`);
  }
  return {
    name,
    packageName: COMPONENT_PAYLOAD_PACKAGES[name],
    version: value.version,
    entry: COMPONENT_PAYLOAD_ENTRIES[name],
    source: COMPONENT_PAYLOAD_SOURCE,
    protocolVersion: COMPONENT_PAYLOAD_PROTOCOL_VERSION,
    files: value.files.map((row, index) => parseFile(name, row, index)),
  };
}

function parseFile(name: ComponentPayloadName, value: unknown, index: number): ComponentPayloadFile {
  if (!isPlainObject(value)) throw fail(`Component ${name} file ${index} is not an object.`);
  assertExactKeys(value, FILE_KEYS, `component ${name} file ${index}`);
  if (typeof value.path !== "string") throw fail(`Component ${name} file ${index} path is invalid.`);
  const path = assertRelativePayloadPath(value.path);
  if (path === COMPONENT_PAYLOAD_MANIFEST_REL) {
    throw fail("Component payload manifest must not list itself.");
  }
  if (typeof value.sha256 !== "string" || !SHA256_RE.test(value.sha256)) {
    throw fail(`Component ${name} file ${path} sha256 must be 64 lowercase hex characters.`);
  }
  if (typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 0) {
    throw fail(`Component ${name} file ${path} size is invalid.`);
  }
  return { path, sha256: value.sha256, size: value.size };
}

function assertDeclaredFiles(packageRoot: string, manifest: ComponentPayloadManifest, manifestAbs: string): void {
  const seen = new Map<string, string>();
  const seenReal = new Map<string, string>();
  for (const name of COMPONENT_PAYLOAD_NAMES) {
    const identity = readPackageIdentity(packageRoot, IDENTITY_JSON[name]);
    if (identity.name !== manifest.components[name].packageName || identity.version !== manifest.components[name].version) {
      throw fail(`Component ${name} identity differs from its package manifest.`);
    }
    const listed = new Set(manifest.components[name].files.map((file) => file.path));
    for (const required of COMPONENT_PAYLOAD_REQUIRED_FILES[name]) {
      if (!listed.has(required)) {
        throw fail(`Component ${name} is missing required file ${required}.`);
      }
    }
    if (!listed.has(manifest.components[name].entry)) {
      throw fail(`Component ${name} does not list its entry ${manifest.components[name].entry}.`);
    }
    for (const file of manifest.components[name].files) {
      const prior = seen.get(file.path);
      if (prior) throw fail(`Duplicate component payload path ${file.path}.`);
      seen.set(file.path, name);
      if (samePath(joinFromRel(packageRoot, file.path), manifestAbs)) {
        throw fail("Component payload manifest must not list itself.");
      }
      const onDisk = readRegularFile(packageRoot, file.path);
      if (onDisk.size !== file.size) throw fail(`Component payload file size does not match: ${file.path}`);
      if (onDisk.sha256 !== file.sha256) throw fail(`Component payload file sha256 does not match: ${file.path}`);
      const realKey = process.platform === "win32" ? onDisk.real.toLowerCase() : onDisk.real;
      const realPrior = seenReal.get(realKey);
      if (realPrior) throw fail(`Duplicate component payload path ${file.path}.`);
      seenReal.set(realKey, file.path);
    }
  }
}

/**
 * Fixed-size engine scan cap. playwright-core@1.62.1 ships ~140 files; the
 * cap exists so a corrupt source tree fails the manifest write instead of
 * growing the payload unboundedly.
 */
const UI_ENGINE_SCAN_MAX_FILES = 4_096;
const UI_ENGINE_SCAN_MAX_BYTES = 64 * 1024 * 1024;

/** Every regular file under the ui-engine directory, hashed into the payload. */
function collectUiEngineFiles(packageRoot: string): ComponentPayloadFile[] {
  const root = joinFromRel(packageRoot, UI_ENGINE_DIR_REL);
  let st;
  try {
    st = lstatSync(root);
  } catch {
    throw fail(`Component supervisor is missing its ui-engine directory: ${UI_ENGINE_DIR_REL}`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw fail(`Component supervisor ui-engine is not a real directory: ${UI_ENGINE_DIR_REL}`);
  }
  const found: string[] = [];
  let totalBytes = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        throw fail(`Component supervisor ui-engine file could not be read: ${abs}`);
      }
      if (stat.isSymbolicLink()) {
        throw fail(`Component supervisor ui-engine file is a symlink or junction: ${abs}`);
      }
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      const rel = relative(packageRoot, abs).split(sep).join("/");
      found.push(rel);
      totalBytes += stat.size;
      if (found.length > UI_ENGINE_SCAN_MAX_FILES || totalBytes > UI_ENGINE_SCAN_MAX_BYTES) {
        throw fail("Component supervisor ui-engine exceeds the payload scan limits.");
      }
    }
  };
  walk(root);
  if (!found.length) {
    throw fail(`Component supervisor ui-engine directory is empty: ${UI_ENGINE_DIR_REL}`);
  }
  return found.sort((a, b) => a.localeCompare(b)).map((rel) => {
    const onDisk = readRegularFile(packageRoot, rel);
    return { path: rel, sha256: onDisk.sha256, size: onDisk.size };
  });
}

/**
 * The bundled engine manifest must declare the pinned playwright-core: any
 * other content at that position means the build copied the wrong thing.
 */
function assertUiEngineIdentity(packageRoot: string): void {
  const onDisk = readRegularFile(packageRoot, UI_ENGINE_MANIFEST_REL);
  let parsed: unknown;
  try {
    parsed = JSON.parse(onDisk.bytes.toString("utf8"));
  } catch {
    throw fail(`Component supervisor ui-engine manifest is not valid JSON: ${UI_ENGINE_MANIFEST_REL}`);
  }
  const row = parsed as { name?: unknown; version?: unknown };
  if (row?.name !== "playwright-core" || row?.version !== UI_ENGINE_PACKAGE_VERSION) {
    throw fail(
      `Component supervisor ui-engine must be playwright-core@${UI_ENGINE_PACKAGE_VERSION}, got ${String(row?.name)}@${String(row?.version)}.`,
    );
  }
}

function collectComponentFiles(packageRoot: string, name: ComponentPayloadName): ComponentPayloadFile[] {
  const files: ComponentPayloadFile[] = [];
  for (const rel of COMPONENT_PAYLOAD_REQUIRED_FILES[name]) {
    const onDisk = readRegularFile(packageRoot, rel);
    files.push({ path: rel, sha256: onDisk.sha256, size: onDisk.size });
  }
  if (name === "supervisor") {
    assertUiEngineIdentity(packageRoot);
    const listed = new Set(files.map((file) => file.path));
    files.push(...collectUiEngineFiles(packageRoot).filter((file) => !listed.has(file.path)));
  }
  for (const rel of COMPONENT_PAYLOAD_OPTIONAL_FILES[name]) {
    const abs = joinFromRel(packageRoot, rel);
    if (!existsSync(abs)) continue;
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      throw fail(`Component payload optional file could not be read: ${rel}`);
    }
    if (st.isSymbolicLink()) throw fail(`Component payload file is a symlink or junction: ${rel}`);
    if (!st.isFile()) throw fail(`Component payload optional file is not a regular file: ${rel}`);
    const onDisk = readRegularFile(packageRoot, rel);
    files.push({ path: rel, sha256: onDisk.sha256, size: onDisk.size });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function readPackageIdentity(packageRoot: string, rel: string): { name: string; version: string } {
  const onDisk = readRegularFile(packageRoot, rel);
  let parsed: unknown;
  try {
    parsed = JSON.parse(onDisk.bytes.toString("utf8"));
  } catch {
    throw fail(`Package identity ${rel} is not valid JSON.`);
  }
  if (!isPlainObject(parsed) || typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw fail(`Package identity ${rel} is missing name.`);
  }
  if (typeof parsed.version !== "string" || !isExactRuntimeVersion(parsed.version) || !COMPAT_VERSION_RE.test(parsed.version)) {
    throw fail(`Package identity ${rel} version must be exact, not a dist-tag.`);
  }
  return { name: parsed.name, version: parsed.version };
}

function declaredFiles(manifest: ComponentPayloadManifest): ComponentPayloadFile[] {
  const files: ComponentPayloadFile[] = [];
  for (const name of COMPONENT_PAYLOAD_NAMES) {
    files.push(...manifest.components[name].files);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeManifest(manifest: ComponentPayloadManifest): ComponentPayloadManifest {
  const components = {} as ComponentPayloadComponents;
  for (const name of COMPONENT_PAYLOAD_NAMES) {
    const row = manifest.components[name];
    components[name] = {
      name: row.name,
      packageName: row.packageName,
      version: row.version,
      entry: row.entry,
      source: COMPONENT_PAYLOAD_SOURCE,
      protocolVersion: COMPONENT_PAYLOAD_PROTOCOL_VERSION,
      files: [...row.files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
    };
  }
  return {
    schemaVersion: COMPONENT_PAYLOAD_SCHEMA_VERSION,
    protocolVersion: COMPONENT_PAYLOAD_PROTOCOL_VERSION,
    version: manifest.version,
    entry: COMPONENT_PAYLOAD_SUPERVISOR_ENTRY,
    components,
  };
}

type PayloadRoots = { packageRoot: string; payloadRootLib: string };

function resolvePayloadRoots(payloadRootLib: string): PayloadRoots {
  if (typeof payloadRootLib !== "string" || payloadRootLib.length === 0) {
    throw fail("A payload lib directory is required.");
  }
  if (payloadRootLib.includes("\0")) throw fail("Payload lib path contains a NUL.");
  const libAbs = resolve(payloadRootLib);
  const packageAbs = dirname(libAbs);
  // Standard plugin installation lives under profiles/<id>/node_modules. A
  // trusted product entry may read that source; copies remain outside Home.
  assertNotRealHome(packageAbs);
  assertNotRealHome(libAbs);
  const payloadRoot = realDirectoryNoLink(libAbs, "payload lib");
  const packageRoot = realDirectoryNoLink(packageAbs, "package root");
  if (!samePath(dirname(payloadRoot), packageRoot)) {
    throw fail("Payload lib is not a child of the package root.");
  }
  return { packageRoot, payloadRootLib: payloadRoot };
}

function readRegularFile(packageRoot: string, rel: string): { real: string; bytes: Buffer; sha256: string; size: number } {
  const path = assertRelativePayloadPath(rel);
  let current = packageRoot;
  for (const part of path.split("/")) {
    current = join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      throw fail(`Component payload file is missing: ${path}`);
    }
    if (st.isSymbolicLink()) throw fail(`Component payload file is a symlink or junction: ${path}`);
  }
  let st;
  try {
    st = lstatSync(current);
  } catch {
    throw fail(`Component payload file is missing: ${path}`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw fail(`Component payload file is not a regular file: ${path}`);
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    throw fail(`Component payload file could not be resolved: ${path}`);
  }
  if (!contained(packageRoot, real) || samePath(packageRoot, real)) {
    throw fail(`Component payload file escapes the package root: ${path}`);
  }
  const bytes = readFileSync(current);
  if (bytes.length !== st.size) throw fail(`Component payload file size does not match: ${path}`);
  return { real, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), size: st.size };
}

function realDirectoryNoLink(path: string, label: string): string {
  const abs = resolve(path);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw fail(`${label} is missing.`);
  }
  if (st.isSymbolicLink()) throw fail(`${label} is a symlink or junction.`);
  if (!st.isDirectory()) throw fail(`${label} is not a directory.`);
  try {
    return realpathSync(abs);
  } catch {
    throw fail(`${label} could not be resolved.`);
  }
}

function assertRelativePayloadPath(rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) throw fail("Component payload path is empty.");
  if (rel.includes("\0")) throw fail("Component payload path contains a NUL.");
  if (rel.includes("\\")) throw fail(`Component payload path must use forward slashes: ${rel}`);
  if (isAbsolute(rel) || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) {
    throw fail(`Component payload path must be relative: ${rel}`);
  }
  const parts = rel.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw fail(`Component payload path must not contain '.' or '..' segments: ${rel}`);
  }
  if (parts.some(part => part.includes(":") || /[. ]$/.test(part))) {
    throw fail(`Component payload path is not portable: ${rel}`);
  }
  return rel;
}

function joinFromRel(root: string, rel: string): string {
  return join(root, ...assertRelativePayloadPath(rel).split("/"));
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!expected.has(key)) throw fail(`${label} has unknown field ${key}.`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw fail(`${label} is missing ${key}.`);
  }
}

function isComponentName(value: string): value is ComponentPayloadName {
  return (COMPONENT_PAYLOAD_NAMES as readonly string[]).includes(value);
}

function contained(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  if (samePath(r, t)) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  if (process.platform === "win32") return t.toLowerCase().startsWith(prefix.toLowerCase());
  return t.startsWith(prefix);
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(message: string): never {
  throw new ComponentPayloadError(message);
}

const TAR_TIMEOUT_MS = 15_000;
const MAX_TAR_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_TAR_LIST_BYTES = 256 * 1024;
const DIGEST_ID_LENGTH = 32;
const PLUGIN_ARCHIVE_PREFIX = "dsh-spaces-plugin";
const VIEW_BRIDGE_ARCHIVE_PREFIX = "dsh-spaces-view-bridge";
const BROWSER_ARCHIVE_PREFIX = "dsh-spaces-browser";
const LLM_BRIDGE_ARCHIVE_PREFIX = "dsh-spaces-llm-bridge";

export type ComponentArtifactPaths = {
  pluginArtifact: string;
  viewBridgeArtifact: string;
  browserArtifact: string;
  llmBridgeArtifact: string;
};

export interface ComponentArtifactInspection {
  packageName: string;
  version: string;
  artifact: string;
  fileDigest: string;
  archiveId: string;
  files: Record<string, string>;
}

export async function validateComponentPayloadArtifacts(
  payload: ValidatedComponentPayload,
  artifacts: ComponentArtifactPaths,
): Promise<void> {
  const current = validateComponentPayload(payload.payloadRootLib);
  if (current.digest !== payload.digest) {
    fail("Selected component payload changed before startup.");
  }
  assertPackedMatchesPayload(await inspectComponentPayloadArtifacts(current, artifacts), current);
}

function bridgeFiles(payload: ValidatedComponentPayload, name: "view-bridge" | "browser" | "llm-bridge"): string[] {
  const prefix = `lib/${name}/`;
  return payload.manifest.components[name].files.map((file) => {
    if (!file.path.startsWith(prefix)) {
      fail(`Component ${name} declares a file outside its package.`);
    }
    return file.path.slice(prefix.length);
  });
}

function assertBridgeMatchesPayload(payload: ValidatedComponentPayload, name: "view-bridge" | "browser" | "llm-bridge", artifact: ComponentArtifactInspection): void {
  const component = payload.manifest.components[name];
  const prefix = `lib/${name}/`;
  if (artifact.version !== component.version || artifact.packageName !== component.packageName) {
    fail(`Packed ${name} identity does not match the staged payload.`);
  }
  for (const file of component.files) {
    if (!file.path.startsWith(prefix) || artifact.files[file.path.slice(prefix.length)] !== file.sha256) {
      fail(`Packed ${name} bytes do not match the staged payload.`);
    }
  }
}

async function inspectComponentPayloadArtifacts(payload: ValidatedComponentPayload, artifacts: ComponentArtifactPaths) {
  const [plugin, viewBridge, browser, llmBridge] = await Promise.all([
    inspectPluginArchive(artifacts.pluginArtifact),
    inspectArtifact(artifacts.viewBridgeArtifact, COMPONENT_PAYLOAD_PACKAGES["view-bridge"], bridgeFiles(payload, "view-bridge"), VIEW_BRIDGE_ARCHIVE_PREFIX),
    inspectArtifact(artifacts.browserArtifact, COMPONENT_PAYLOAD_PACKAGES.browser, bridgeFiles(payload, "browser"), BROWSER_ARCHIVE_PREFIX),
    inspectArtifact(artifacts.llmBridgeArtifact, COMPONENT_PAYLOAD_PACKAGES["llm-bridge"], bridgeFiles(payload, "llm-bridge"), LLM_BRIDGE_ARCHIVE_PREFIX),
  ]);
  return { plugin, viewBridge, browser, llmBridge };
}

function assertPackedMatchesPayload(
  packed: { plugin: ComponentArtifactInspection; viewBridge: ComponentArtifactInspection; browser: ComponentArtifactInspection; llmBridge: ComponentArtifactInspection },
  payload: ValidatedComponentPayload,
): void {
  if (packed.plugin.packageName !== COMPONENT_PAYLOAD_PACKAGES["manager-plugin"]) {
    fail("Packed plugin is not the official Spaces plugin.");
  }
  if (packed.viewBridge.packageName !== COMPONENT_PAYLOAD_PACKAGES["view-bridge"] || packed.browser.packageName !== COMPONENT_PAYLOAD_PACKAGES.browser || packed.llmBridge.packageName !== COMPONENT_PAYLOAD_PACKAGES["llm-bridge"]) {
    fail("Packed workbench artifacts are not official packages.");
  }
  if (packed.plugin.version !== payload.manifest.components["manager-plugin"].version) {
    fail("Packed plugin version does not match the staged manager plugin.");
  }
  if (packed.viewBridge.version !== payload.manifest.components["view-bridge"].version) {
    fail("Packed view-bridge version does not match the staged view-bridge.");
  }
  if (packed.llmBridge.version !== payload.manifest.components["llm-bridge"].version) {
    fail("Packed llm-bridge version does not match the staged llm-bridge.");
  }
  if (packed.browser.version !== payload.manifest.components.browser.version) {
    fail("Packed browser version does not match the staged browser.");
  }
  for (const [name, artifact] of [["view-bridge", packed.viewBridge], ["browser", packed.browser], ["llm-bridge", packed.llmBridge]] as const) {
    assertBridgeMatchesPayload(payload, name, artifact);
  }
  for (const file of payload.files) {
    if (packed.plugin.files[file.path] !== file.sha256) {
      fail("Packed workbench plugin does not match the staged payload.");
    }
  }
  for (const [rel, hash] of Object.entries(packed.plugin.files)) {
    const listed = payload.files.find((file) => file.path === rel);
    if (!listed || listed.sha256 !== hash) {
      fail("Packed workbench plugin does not match the staged payload.");
    }
  }
}

async function inspectPluginArchive(artifact: string): Promise<ComponentArtifactInspection> {
  const resolved = resolve(artifact);
  const entries = await listTarEntries(resolved);
  const root = archivePackageRoot(entries);
  const manifestBytes = await readTarEntry(resolved, `${root}${COMPONENT_PAYLOAD_MANIFEST_REL}`);
  const parsed = parseComponentPayloadManifest(JSON.parse(manifestBytes.toString("utf8")));
  const hashes: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of COMPONENT_PAYLOAD_NAMES) {
    const row = parsed.components[name];
    const listed = new Set(row.files.map((file) => file.path));
    for (const required of COMPONENT_PAYLOAD_REQUIRED_FILES[name]) {
      if (!listed.has(required)) fail(`component is missing ${required}`);
    }
    if (!listed.has(row.entry) || row.entry !== COMPONENT_PAYLOAD_ENTRIES[name]) {
      fail(`component does not list its entry: ${name}`);
    }
    for (const file of row.files) {
      if (seen.has(file.path)) fail(`duplicate component path ${file.path}`);
      seen.add(file.path);
      const bytes = await readTarEntry(resolved, `${root}${file.path}`);
      if (bytes.length !== file.size) {
        fail(`component file size does not match archive: ${file.path}`);
      }
      const digest = sha256Bytes(bytes);
      if (digest !== file.sha256) {
        fail(`component file digest does not match archive: ${file.path}`);
      }
      hashes[file.path] = digest;
    }
    const identity = parsePackageIdentity((await readTarEntry(resolved, `${root}${IDENTITY_JSON[name]}`)).toString("utf8"));
    if (!identity || identity.name !== row.packageName || identity.version !== row.version) {
      fail(`component identity does not match archive: ${name}`);
    }
  }
  const pkg = parsed.components["manager-plugin"];
  const fileDigest = sha256File(resolved);
  return {
    packageName: pkg.packageName,
    version: pkg.version,
    artifact: resolved,
    fileDigest,
    archiveId: `${PLUGIN_ARCHIVE_PREFIX}-${fileDigest.slice(0, DIGEST_ID_LENGTH)}`,
    files: hashes,
  };
}

async function inspectArtifact(
  artifact: string,
  expectedName: string,
  files: readonly string[],
  archivePrefix: string,
): Promise<ComponentArtifactInspection> {
  const resolved = resolve(artifact);
  const entries = await listTarEntries(resolved);
  const root = archivePackageRoot(entries);
  const manifestBytes = await readTarEntry(resolved, `${root}package.json`);
  const identity = parsePackageIdentity(manifestBytes.toString("utf8"));
  if (!identity || identity.name !== expectedName) {
    fail("artifact package name is not official");
  }
  const hashes: Record<string, string> = { "package.json": sha256Bytes(manifestBytes) };
  await Promise.all(
    files.filter((rel) => rel !== "package.json").map(async (rel) => {
      hashes[rel] = sha256Bytes(await readTarEntry(resolved, `${root}${rel}`));
    }),
  );
  const fileDigest = sha256File(resolved);
  return {
    packageName: identity.name,
    version: identity.version,
    artifact: resolved,
    fileDigest,
    archiveId: `${archivePrefix}-${fileDigest.slice(0, DIGEST_ID_LENGTH)}`,
    files: hashes,
  };
}

function archivePackageRoot(entries: string[]): string {
  const normalized = entries.map((entry) => entry.replaceAll("\\", "/"));
  if (normalized.includes("package/package.json")) return "package/";
  if (normalized.includes("package.json")) return "";
  fail("tarball has no package manifest");
}

function parsePackageIdentity(source: string): { name: string; version: string } | undefined {
  try {
    const parsed = JSON.parse(source) as { name?: unknown; version?: unknown };
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
    if (!name || !version) return undefined;
    return { name, version };
  } catch {
    return undefined;
  }
}

export function listTarEntries(archive: string): Promise<string[]> {
  return withTarTimeout(async () => {
    const entries: string[] = [];
    let listed = 0;
    await listTarArchive({
      file: archive,
      onentry: (entry) => {
        listed += entry.path.length + 1;
        if (listed > MAX_TAR_LIST_BYTES) {
          throw new Error("tarball listing exceeds the read limit");
        }
        const name = entry.path.replaceAll("\\", "/");
        if (name && entry.type !== "Directory" && isSafeTarEntry(name)) {
          entries.push(name);
        }
        entry.resume();
      },
    });
    return entries;
  });
}

export function readTarEntry(archive: string, entry: string): Promise<Buffer> {
  if (!isSafeTarEntry(entry)) return Promise.reject(new Error("unsafe tarball entry"));
  return withTarTimeout(async () => {
    let data: Promise<Buffer> | undefined;
    let oversized = false;
    await listTarArchive({
      file: archive,
      onentry: (current) => {
        const name = current.path.replaceAll("\\", "/");
        if (data === undefined && !oversized && name === entry) {
          if (current.size > MAX_TAR_ENTRY_BYTES) {
            oversized = true;
          } else {
            data = collectBoundedTarEntry(current);
            return;
          }
        }
        current.resume();
      },
    });
    if (oversized) throw new Error("tarball entry exceeds the read limit");
    const bytes = data ? await data : undefined;
    if (bytes === undefined) throw new Error("tarball entry could not be read");
    return bytes;
  });
}

async function collectBoundedTarEntry(entry: { size: number } & AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of entry) {
    size += chunk.length;
    if (size > MAX_TAR_ENTRY_BYTES) continue;
    chunks.push(chunk);
  }
  if (size > MAX_TAR_ENTRY_BYTES) throw new Error("tarball entry exceeds the read limit");
  return Buffer.concat(chunks);
}

function withTarTimeout<T>(run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("tarball read timed out")), TAR_TIMEOUT_MS);
  });
  return Promise.race([run(), timeout]).finally(() => clearTimeout(timer));
}

function isSafeTarEntry(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\\0") || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return false;
  }
  return normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
