import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseControlEndpoint } from "../../../../src/adapters/node/home-controller";
import { parseLoopbackOrigin, parsePrivateBearer } from "./loopback";

export const SUPERVISOR_ENDPOINT_FILE = "endpoint.json";

export interface SupervisorEndpoint {
  origin: string;
  bearer: string;
}

export function readEndpointFile(path: string): SupervisorEndpoint | null {
  if (!isRealFile(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      origin?: unknown;
      bearer?: unknown;
    };
    if (parsed.version !== 1) return null;
    if (typeof parsed.origin !== "string" || typeof parsed.bearer !== "string") return null;
    let origin: string;
    try {
      origin = new URL(parseControlEndpoint(parsed.origin)).origin;
    } catch {
      const fallback = parseLoopbackOrigin(parsed.origin);
      if (!fallback || !fallback.startsWith("http://127.0.0.1")) return null;
      origin = fallback;
    }
    const bearer = parsePrivateBearer(parsed.bearer);
    if (!bearer) return null;
    return { origin, bearer };
  } catch {
    return null;
  }
}

export function writeEndpointFile(path: string, endpoint: SupervisorEndpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, origin: endpoint.origin, bearer: endpoint.bearer })}\n`,
  );
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

function isRealFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    realpathSync(path);
    return true;
  } catch {
    return false;
  }
}
