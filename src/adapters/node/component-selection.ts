/** Node-only selected component pointer. Owned with the launcher/lock worker; bootstrap only consumes it. */
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { atomicWrite } from "./atomic";
import { isAuthorizedProductHome, isInsideRealHome } from "./home-guard";
import {
  copyComponentPayload,
  validateComponentPayload,
  ComponentPayloadError,
  type ValidatedComponentPayload,
} from "./component-payload";
import { HomeController } from "./home-controller";
import { canonicalHome, HomeOperationLock } from "./home-operation-lock";
import { digestHomeIdentity } from "./workbench-protocol";

export const COMPONENT_SELECTION_SCHEMA_VERSION = 2 as const;
export const COMPONENT_SELECTION_CODE = "component-selection/invalid" as const;
export const COMPONENT_STAGED_DIR_NAME = "components";
export const COLD_START_LOCK_NAME = "coldstart.lock";

export function coldStartLockLabel(home: string, access?: ComponentHomeAccess): string {
  return `supervisor-start:${digestHomeIdentity(boundHome(home, access))}`;
}

const DIGEST_RE = /^[a-f0-9]{64}$/;
const POINTER_KEYS = ["schemaVersion", "homeDigest", "artifactDigest"] as const;

export class ComponentSelectionError extends Error {
  readonly name = "ComponentSelectionError";
  readonly code = COMPONENT_SELECTION_CODE;
  constructor(message: string) {
    super(message);
  }
}

export function stagedComponentDir(toolsRoot: string, digest: string): string {
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
    throw fail("Component payload digest must be 64 lowercase hex characters.");
  }
  return join(resolve(toolsRoot), COMPONENT_STAGED_DIR_NAME, digest);
}

export function selectedPointerPath(toolsRoot: string, homeDigest: string): string {
  if (typeof homeDigest !== "string" || !DIGEST_RE.test(homeDigest)) {
    throw fail("Home digest must be 64 lowercase hex characters.");
  }
  return join(resolve(toolsRoot), `selected-${homeDigest}.json`);
}

export type ComponentHomeAccess = { allowRealHome?: boolean };

export function stageComponentPayload(
  home: string,
  toolsRoot: string,
  sourceLib: string,
  access?: ComponentHomeAccess,
): ValidatedComponentPayload {
  const homeReal = boundHome(home, access);
  const toolsReal = boundToolsRoot(toolsRoot, homeReal);
  const source = validateComponentPayload(sourceLib);
  const dest = join(toolsReal, COMPONENT_STAGED_DIR_NAME, source.digest);
  assertStagingDestination(toolsReal, dest, homeReal);
  mkdirSync(join(toolsReal, COMPONENT_STAGED_DIR_NAME), { recursive: true });
  assertStagingDestination(toolsReal, dest, homeReal);
  return copyComponentPayload(source.payloadRootLib, dest);
}

export function readSelectedComponentPayload(
  home: string,
  toolsRoot: string,
  access?: ComponentHomeAccess,
): ValidatedComponentPayload | undefined {
  const homeReal = boundHome(home, access);
  const homeDigest = digestHomeIdentity(homeReal);
  const toolsReal = boundToolsRoot(toolsRoot, homeReal);
  const pointer = selectedPointerPath(toolsReal, homeDigest);
  let raw: string;
  try {
    const st = lstatSync(pointer);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw fail("Selected component payload pointer is not a regular file.");
    }
    raw = readFileSync(pointer, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof ComponentSelectionError || error instanceof ComponentPayloadError) throw error;
    throw fail("Selected component payload pointer could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fail("Selected component payload pointer is not valid JSON.");
  }
  const row = parsePointer(parsed, homeDigest);
  const lib = join(toolsReal, "components", row.artifactDigest, "lib");
  const selected = validateComponentPayload(lib);
  if (selected.digest !== row.artifactDigest) {
    throw fail("Selected component payload digest does not match the pointer.");
  }
  if (contained(homeReal, selected.packageRoot)) {
    throw fail("Selected component payload is inside Home.");
  }
  return selected;
}

export function selectComponentPayload(
  home: string,
  toolsRoot: string,
  digest: string,
  access?: ComponentHomeAccess,
): ValidatedComponentPayload {
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
    throw fail("Component payload digest must be 64 lowercase hex characters.");
  }
  const homeReal = boundHome(home, access);
  const homeDigest = digestHomeIdentity(homeReal);
  const toolsReal = boundToolsRoot(toolsRoot, homeReal);
  assertSelectionReservation(homeReal, toolsReal, access);
  const lib = join(toolsReal, COMPONENT_STAGED_DIR_NAME, digest, "lib");
  const selected = validateComponentPayload(lib);
  if (selected.digest !== digest) {
    throw fail("Staged component payload digest does not match.");
  }
  if (contained(homeReal, selected.packageRoot)) {
    throw fail("Selected component payload is inside Home.");
  }
  atomicWrite(
    selectedPointerPath(toolsReal, homeDigest),
    `${JSON.stringify(
      {
        schemaVersion: COMPONENT_SELECTION_SCHEMA_VERSION,
        homeDigest,
        artifactDigest: digest,
      },
      null,
      2,
    )}\n`,
  );
  return selected;
}

function parsePointer(value: unknown, homeDigest: string): { artifactDigest: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("Selected component payload pointer is malformed.");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== POINTER_KEYS.length || POINTER_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(row, key))) {
    throw fail("Selected component payload pointer has unknown or missing fields.");
  }
  if (row.schemaVersion !== COMPONENT_SELECTION_SCHEMA_VERSION) {
    throw fail("Selected component payload pointer schemaVersion must be 2.");
  }
  if (row.homeDigest !== homeDigest || typeof row.homeDigest !== "string" || !DIGEST_RE.test(row.homeDigest)) {
    throw fail("Selected component payload pointer is not bound to this Home.");
  }
  if (typeof row.artifactDigest !== "string" || !DIGEST_RE.test(row.artifactDigest)) {
    throw fail("Selected component payload pointer artifactDigest is invalid.");
  }
  return { artifactDigest: row.artifactDigest };
}

function homeAccess(home: string, access?: ComponentHomeAccess): { allowRealHome?: boolean } {
  if (access?.allowRealHome === true || isAuthorizedProductHome(home)) return { allowRealHome: true };
  return {};
}

function boundHome(home: string, access?: ComponentHomeAccess): string {
  try {
    return canonicalHome(home, homeAccess(home, access));
  } catch (error) {
    throw fail(error instanceof Error ? error.message : "Home is missing.");
  }
}

function boundToolsRoot(toolsRoot: string, home: string): string {
  const real = boundDir(toolsRoot, "tools root");
  if (isInsideRealHome(real)) throw fail("Refusing to use a tools root inside the real DSH home.");
  if (contained(home, real)) throw fail("Component payload tools root must be outside Home.");
  return real;
}

function assertSelectionReservation(home: string, toolsRoot: string, access?: ComponentHomeAccess): void {
  const inspection = new HomeController(home, homeAccess(home, access)).inspect();
  if (inspection.held) {
    if ("handoff" in inspection && inspection.handoff && "owner" in inspection) {
      if (inspection.owner.pid !== process.pid) {
        throw fail("Component selection requires the current launcher occupancy.");
      }
      if (inspection.handoff.phase !== "launcher") {
        throw fail("Component selection is only allowed in the launcher phase before authorization.");
      }
      return;
    }
    throw fail("Component selection is refused while another owner holds the Home.");
  }
  const reservation = new HomeOperationLock(toolsRoot).inspect();
  if (!reservation.held || !("owner" in reservation) ||
      reservation.owner.pid !== process.pid || reservation.owner.label !== coldStartLockLabel(home, access)) {
    throw fail("Component selection requires this process's cold-start reservation or launcher occupancy.");
  }
}

function assertStagingDestination(toolsReal: string, dest: string, homeReal: string): void {
  if (contained(homeReal, dest)) throw fail("Staged component payload must be outside Home.");
  let cursor = resolve(dest);
  const stop = resolve(toolsReal);
  for (;;) {
    assertExistingNotLink(cursor);
    try {
      const real = realpathSync(cursor);
      if (process.platform === "win32" ? real.toLowerCase() !== cursor.toLowerCase() : real !== cursor) {
        throw fail("Staged component path is a path alias.");
      }
      if (contained(homeReal, real)) throw fail("Staged component payload must be outside Home.");
    } catch (error) {
      if (error instanceof ComponentSelectionError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw fail("Staged component path could not be resolved.");
      }
    }
    if (process.platform === "win32" ? cursor.toLowerCase() === stop.toLowerCase() : cursor === stop) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function assertExistingNotLink(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw fail("Staged component path could not be read.");
  }
  if (st.isSymbolicLink()) throw fail("Staged component path is a symlink or junction.");
}

function boundDir(path: string, label: string): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw fail(`${label} is missing.`);
  }
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

function contained(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  if (process.platform === "win32" ? r.toLowerCase() === t.toLowerCase() : r === t) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  if (process.platform === "win32") return t.toLowerCase().startsWith(prefix.toLowerCase());
  return t.startsWith(prefix);
}

function fail(message: string): never {
  throw new ComponentSelectionError(message);
}
