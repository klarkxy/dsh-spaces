import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWrite } from "../../../../src/adapters/node/atomic";
import { parseControlEndpoint } from "../../../../src/adapters/node/home-controller";
import { canonicalHome } from "../../../../src/adapters/node/home-operation-lock";
import { deriveServiceEpoch, digestHomeIdentity } from "../../../../src/adapters/node/workbench-protocol";
import { parseLoopbackOrigin, parsePrivateBearer } from "./loopback";

export const SUPERVISOR_ENDPOINT_FILE = "endpoint.json";
export const SUPERVISOR_PROTOCOL_VERSION = 2 as const;

const HEX64 = /^[a-f0-9]{64}$/;

export interface SupervisorEndpoint {
  origin: string;
  bearer: string;
  protocolVersion: typeof SUPERVISOR_PROTOCOL_VERSION;
  homeId: string;
  serviceEpoch: string;
}

export type EndpointFileRead =
  | { missing: true }
  | { invalid: true; reasons: string[] }
  | { endpoint: SupervisorEndpoint };

/** Public wrapper: canonicalHome then protocol digestHomeIdentity. */
export function endpointHomeId(home: string, options: { allowRealHome?: boolean } = {}): string {
  return digestHomeIdentity(canonicalHome(home, options));
}

/** Public wrapper around protocol deriveServiceEpoch. Never store or return the nonce. */
export function endpointServiceEpoch(nonce: string): string {
  return deriveServiceEpoch(nonce);
}

export function readEndpointFile(path: string): EndpointFileRead {
  const kind = inspectEndpointPath(path);
  if (kind === "missing") return { missing: true };
  if (kind === "invalid") {
    return { invalid: true, reasons: ["Supervisor endpoint path is not a regular file."] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { invalid: true, reasons: ["Supervisor endpoint file could not be read."] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { invalid: true, reasons: ["Supervisor endpoint file is not valid JSON."] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { invalid: true, reasons: ["Supervisor endpoint file is malformed."] };
  }
  const row = parsed as Record<string, unknown>;
  if (row.version === 1) {
    return { invalid: true, reasons: ["Supervisor endpoint protocol is not supported."] };
  }
  if (row.version !== 2 || row.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION) {
    return { invalid: true, reasons: ["Supervisor endpoint protocol is not supported."] };
  }
  const origin = parseOrigin(row.origin);
  const bearer = typeof row.bearer === "string" ? parsePrivateBearer(row.bearer) : null;
  const homeId = typeof row.homeId === "string" && HEX64.test(row.homeId) ? row.homeId : null;
  const serviceEpoch =
    typeof row.serviceEpoch === "string" && HEX64.test(row.serviceEpoch) ? row.serviceEpoch : null;
  if (!origin || !bearer || !homeId || !serviceEpoch) {
    return { invalid: true, reasons: ["Supervisor endpoint file is malformed."] };
  }
  return {
    endpoint: {
      origin,
      bearer,
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      homeId,
      serviceEpoch,
    },
  };
}

export function writeEndpointFile(path: string, endpoint: SupervisorEndpoint): void {
  const origin = parseOrigin(endpoint.origin);
  const bearer = parsePrivateBearer(endpoint.bearer);
  if (!origin || !bearer) {
    throw new Error("Supervisor endpoint origin or bearer is invalid.");
  }
  if (endpoint.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION) {
    throw new Error("Supervisor endpoint protocol is not supported.");
  }
  if (!HEX64.test(endpoint.homeId) || !HEX64.test(endpoint.serviceEpoch)) {
    throw new Error("Supervisor endpoint identity digest is invalid.");
  }
  const target = assertControlledEndpointPath(path);
  const payload = `${JSON.stringify({
    version: 2,
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    homeId: endpoint.homeId,
    serviceEpoch: endpoint.serviceEpoch,
    origin,
    bearer,
  })}\n`;
  atomicWrite(target, payload);
  const read = readEndpointFile(target);
  if (!("endpoint" in read)) {
    throw new Error("Supervisor endpoint file failed verification after write.");
  }
  if (
    read.endpoint.origin !== origin ||
    read.endpoint.bearer !== bearer ||
    read.endpoint.homeId !== endpoint.homeId ||
    read.endpoint.serviceEpoch !== endpoint.serviceEpoch ||
    read.endpoint.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION
  ) {
    throw new Error("Supervisor endpoint file failed verification after write.");
  }
}

export function diagnoseEndpointResidue(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return "Supervisor endpoint file is a symlink and was not trusted.";
    if (!st.isFile()) return "Supervisor endpoint path is not a regular file.";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "Supervisor endpoint file could not be read.";
  }
  return null;
}

function inspectEndpointPath(path: string): "missing" | "invalid" | "file" {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return "invalid";
    realpathSync(path);
    return "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "invalid";
  }
}

function assertControlledEndpointPath(path: string): string {
  if (typeof path !== "string" || !path.trim() || path !== path.trim()) {
    throw new Error("Supervisor endpoint path is invalid.");
  }
  if (basename(path) !== SUPERVISOR_ENDPOINT_FILE) {
    throw new Error("Supervisor endpoint path is not a controlled endpoint.json.");
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  let realDir: string;
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error("Supervisor endpoint directory is not a real directory.");
    }
    realDir = realpathSync(dir);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Supervisor endpoint")) throw error;
    throw new Error("Supervisor endpoint directory could not be opened.");
  }
  const target = join(realDir, SUPERVISOR_ENDPOINT_FILE);
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error("Supervisor endpoint path is not a regular file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof Error && error.message.startsWith("Supervisor endpoint")) throw error;
      throw new Error("Supervisor endpoint path is not a regular file.");
    }
  }
  return target;
}

function parseOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    return new URL(parseControlEndpoint(raw)).origin;
  } catch {
    const fallback = parseLoopbackOrigin(raw);
    if (!fallback || !fallback.startsWith("http://127.0.0.1")) return null;
    return fallback;
  }
}
