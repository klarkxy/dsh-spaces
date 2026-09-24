import { lstatSync, unlinkSync, mkdirSync, realpathSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readSupervisorDiagnostics } from "./supervisor-diagnostics";
import { join } from "node:path";
import { atomicWrite } from "./atomic";
import { HomeController, sameControlOwner, validLaunchOwner, parseControlEndpoint, type HomeControlOwner } from "./home-controller";
import { endpointHomeId, endpointServiceEpoch, readEndpointFile, SUPERVISOR_ENDPOINT_FILE } from "../../../packages/plugin/src/host/supervisor-endpoint";

/** Called only by a new launch, with the owner observed when that launch began. */
export function retirePreviousSupervisor(home: string, previousOwner: HomeControlOwner | undefined, allowRealHome: boolean): void {
  const controller = new HomeController(home, { allowRealHome });
  const inspection = controller.inspect();
  if (!inspection.held && !previousOwner) return;
  if (!inspection.held) throw new Error("The observed controller was already retired by another launch.");
  if (!previousOwner || !("owner" in inspection) || "handoff" in inspection ||
      (inspection.owner.kind !== "web" && !(inspection.owner.kind === "desktop" && !inspection.owner.endpoint)) ||
      inspection.liveness !== "dead" || !validLaunchOwner(inspection.owner) ||
      !sameControlOwner(inspection.owner, previousOwner)) {
    throw new Error("Controller ownership changed since this launch began. No second startup was attempted.");
  }
  const retired = controller.reclaimDead({
    expectedOwner: previousOwner,
    beforeRelease: (owner) => {
      const endpointPath = join(controller.controlDir, SUPERVISOR_ENDPOINT_FILE);
      const recorded = readEndpointFile(endpointPath);
      if ("invalid" in recorded) throw new Error(recorded.reasons.join(" "));
      if ("endpoint" in recorded && (
        owner.kind === "desktop" ||
        recorded.endpoint.homeId !== endpointHomeId(home, { allowRealHome }) ||
        recorded.endpoint.serviceEpoch !== endpointServiceEpoch(owner.nonce) ||
        !owner.endpoint || recorded.endpoint.origin !== new URL(parseControlEndpoint(owner.endpoint)).origin
      )) {
        throw new Error("The previous controller endpoint identity changed. Its records were left in place.");
      }
      // Keep the failure fact separate from the live ownership token. No jobs or
      // workspace data are changed, and no credentials enter this evidence.
      const evidence = join(controller.controlDir, "previous-controller-exit.json");
      try {
        const stat = lstatSync(evidence);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Previous controller evidence is not a regular file.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      atomicWrite(evidence, `${JSON.stringify({
        version: 1, pid: owner.pid, kind: owner.kind, startedAt: owner.startedAt,
        observedAt: new Date().toISOString(), outcome: "exited-without-releasing-lease", cause: "unknown",
      })}\n`);
      // Still under the reclaim guard: a successor cannot publish its endpoint
      // until both this endpoint and the old run occupancy have been removed.
      if ("endpoint" in recorded) unlinkSync(endpointPath);
    },
  });
  if (!retired.reclaimed) {
    throw new Error(`The previous controller could not be retired for this launch: ${retired.reason}.`);
  }
}

function diagnosticRoot(toolsRoot: string): string {
  const path = join(toolsRoot, "supervisor-diagnostics");
  if (!pathExists(path)) mkdirSync(path);
  if (!realDiagnosticDirectory(path) || !sameDiagnosticPath(realpathSync(path), path)) throw new Error("Supervisor diagnostics directory is not a real directory.");
  return path;
}

export function beginLaunchDiagnostics(home: string, toolsRoot: string): string {
  const root = diagnosticRoot(toolsRoot);
  const prefix = endpointHomeId(home, { allowRealHome: true });
  const name = `${prefix}-${randomUUID()}.json`;
  const previous = readdirSync(root).filter((entry) => entry.startsWith(prefix + "-") && /^[a-f0-9-]+\.json$/.test(entry));
  const files = previous.map((entry) => ({ path: join(root, entry), stat: lstatSync(join(root, entry)) }))
    .filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  for (const file of files.slice(7)) unlinkSync(file.path);
  const pointer = join(root, `${prefix}-latest.json`);
  if (pathExists(pointer) && !isDiagnosticFile(pointer)) throw new Error("Supervisor diagnostic pointer is not a regular file.");
  atomicWrite(pointer, JSON.stringify({ file: name }));
  return join(root, name);
}

export function readLastSupervisorDiagnostics(home: string, toolsRoot: string): string[] {
  try {
    const file = readLaunchMarker(home, toolsRoot);
    return file ? readSupervisorDiagnostics(join(toolsRoot, "supervisor-diagnostics", file)) : [];
  } catch {
    return [];
  }
}

export function readLaunchMarker(home: string, toolsRoot: string): string | undefined {
  const root = join(toolsRoot, "supervisor-diagnostics");
  if (!pathExists(root)) return undefined;
  if (!realDiagnosticDirectory(root) || !sameDiagnosticPath(realpathSync(root), root)) throw new Error("Supervisor diagnostics directory is not a real directory.");
  const prefix = endpointHomeId(home, { allowRealHome: true });
  const pointer = join(root, `${prefix}-latest.json`);
  if (!pathExists(pointer)) return undefined;
  if (!isDiagnosticFile(pointer) || lstatSync(pointer).size > 1024) throw new Error("Previous startup identity is not a regular bounded record.");
  let record;
  try {
    record = JSON.parse(readFileSync(pointer, "utf8"));
  } catch {
    throw new Error("Previous startup identity could not be read.");
  }
  if (typeof record.file !== "string" || !new RegExp(`^${prefix}-[a-f0-9-]{36}\\.json$`).test(record.file)) throw new Error("Previous startup identity is malformed.");
  return record.file;
}


function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function realDiagnosticDirectory(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}
function isDiagnosticFile(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}
function sameDiagnosticPath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
