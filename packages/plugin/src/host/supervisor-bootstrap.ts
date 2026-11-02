import { lstatSync, realpathSync } from "../../../../src/shared/node/filesystem";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSelectedComponentPayload,
  readSelectedPointerDigest,
  selectComponentPayload,
  stageComponentPayload,
  coldStartLockLabel,
  COLD_START_LOCK_NAME,
} from "../../../../src/adapters/node/payload/component-selection";
import {
  COMPONENT_PAYLOAD_ENTRIES,
  validateComponentPayload,
  type ValidatedComponentPayload,
} from "../../../../src/adapters/node/payload/component-payload";
import { detectDevCheckout } from "../../../../src/adapters/node/payload/dev-checkout";
import { bindDshCli } from "../../../../src/adapters/node/products/spaces-service";
import { authorizeProductHome } from "../../../../src/adapters/node/home/home-guard";
import { HOME_CONTROL_DIR_NAME, defaultPidAlive, validLaunchOwner, HomeLease } from "../../../../src/adapters/node/home/home-lease";
import { HomeOperationLock, HomeLockBusyError } from "../../../../src/adapters/node/home/home-operation-lock";
import { retirePreviousSupervisor, beginLaunchDiagnostics, readLaunchMarker, readLastSupervisorDiagnostics } from "../../../../src/adapters/node/home/supervisor-launch";
import { readSupervisorDiagnostics, reportSupervisorLaunchFailure, reportSupervisorExit } from "../../../../src/adapters/node/diagnostics/supervisor-diagnostics";
import { packLocalArtifacts, validateSnapshotRoot, type PackOneRequest } from "./supervisor-pack";
import { attachExistingSupervisor, type SupervisorAttachResult } from "./supervisor-attach";
import {
  diagnoseEndpointResidue,
  SUPERVISOR_ENDPOINT_FILE,
  type SupervisorEndpoint,
} from "../../../../src/adapters/node/home/supervisor-endpoint";
import type { WorkbenchHttpFetch } from "./workbench-http";

export { SUPERVISOR_ENDPOINT_FILE, readEndpointFile, writeEndpointFile } from "../../../../src/adapters/node/home/supervisor-endpoint";
export type { SupervisorEndpoint } from "../../../../src/adapters/node/home/supervisor-endpoint";
export { readLastSupervisorDiagnostics } from "../../../../src/adapters/node/home/supervisor-launch";

export const SUPERVISOR_PAYLOAD_DIRNAME = "supervisor";
export const VIEW_BRIDGE_PAYLOAD_DIRNAME = "view-bridge";
export const BROWSER_PAYLOAD_DIRNAME = "browser";
export const LLM_BRIDGE_PAYLOAD_DIRNAME = "llm-bridge";

/** Matches parseSupervisorArgs in src/adapters/node/workbench-supervisor.ts. */
export const SUPERVISOR_CLI_FLAGS = {
  home: "--home",
  bin: "--bin",
  node: "--node",
  pluginArtifact: "--plugin-artifact",
  viewBridgeArtifact: "--view-bridge-artifact",
  browserArtifact: "--browser-artifact",
  controlToolRoot: "--control-tool-root",
  snapshotWorker: "--snapshot-worker",
  snapshotRoot: "--snapshot-root",
  llmBridgeArtifact: "--llm-bridge-artifact",
} as const;

/** Literal argv flag until primary SUPERVISOR_CLI_FLAGS / parseSupervisorArgs integration. */
export const COMPONENT_PAYLOAD_ARGV_FLAG = "--component-payload";
export const DEV_CHECKOUT_ARGV_FLAG = "--dev-checkout";

export const DEFAULT_SUPERVISOR_TIMEOUT_MS = 240_000;
export const DEFAULT_SUPERVISOR_POLL_MS = 100;

export interface SupervisorBootstrapDiagnosis {
  connected: false;
  origin: null;
  reasons: string[];
}

export interface SupervisorBootstrapSuccess {
  connected: true;
  origin: string;
  endpoint: SupervisorEndpoint;
  payloadDir: string;
  toolsDir: string;
}

export type SupervisorBootstrapResult = SupervisorBootstrapSuccess | SupervisorBootstrapDiagnosis;

export interface SupervisorSpawnRequest {
  execPath: string;
  entry: string;
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SupervisorBootstrapOptions {
  home: string;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  payloadRoot?: string;
  toolsRoot?: string;
  snapshotRoot?: string;
  allowRealHome?: boolean;
  allowColdStart?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  fetch?: WorkbenchHttpFetch;
  spawn?: (request: SupervisorSpawnRequest) => ChildProcess | void;
  pack?: (request: PackOneRequest) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Fine-grained startup stages emitted while this caller launches the supervisor. */
  progress?: (stage: "prepare" | "launch") => void;
  /**
   * Attach verdict the caller just obtained for this Home. A missing-class
   * verdict is reused instead of probing again; anything else is re-derived.
   */
  priorDiscovery?: SupervisorAttachResult;
}

/**
 * Attach a live supervisor if the private endpoint authenticates and the
 * HomeLease matches. Otherwise, for allowed roles, validate and
 * stage the full v2 component group outside Home, pack plugin/view-bridge/
 * llm-bridge tarballs from the selected package, and cold-start the supervisor CLI.
 */
export async function bootstrapSupervisor(
  options: SupervisorBootstrapOptions,
): Promise<SupervisorBootstrapResult> {
  const home = realDirectory(options.home);
  if (!home) return fail(["The DSH home is not a real directory."]);

  // Capture before the first await: delayed openers must not retry a different
  // launch that completed or failed while discovery was in flight.
  let initialLaunch: string | undefined;
  let initiallyPreparing = false;
  let markerError: string | undefined;
  try {
    initialLaunch = readLaunchMarker(home, options.toolsRoot ?? defaultToolsRoot(home));
    const initialTools = realDirectory(options.toolsRoot ?? defaultToolsRoot(home));
    if (initialTools) {
      const initialReservation = new HomeOperationLock(initialTools).inspect();
      initiallyPreparing = initialReservation.held && "owner" in initialReservation &&
        validLaunchOwner(initialReservation.owner) &&
        initialReservation.owner.label === coldStartLockLabel(home, { allowRealHome: options.allowRealHome === true }) &&
        defaultPidAlive(initialReservation.owner.pid, initialReservation.owner.startedAt) !== "dead";
    }
  } catch (error) {
    markerError = reasonOf(error);
  }

  // The launcher already probed this Home right before requesting a cold start.
  // A missing-class verdict from that probe is reused as-is; any other shape is
  // re-derived below so blocked/stale semantics stay untouched.
  const attached: SupervisorAttachResult =
    options.priorDiscovery && "missing" in options.priorDiscovery
      ? options.priorDiscovery
      : await attachExistingSupervisor({
          home,
          allowRealHome: options.allowRealHome === true,
          fetch: options.fetch,
          timeoutMs: options.timeoutMs,
        });
  if ("endpoint" in attached) {
    return {
      connected: true,
      origin: attached.endpoint.origin,
      endpoint: attached.endpoint,
      payloadDir: options.payloadRoot ?? defaultPayloadRoot(),
      toolsDir: options.toolsRoot ?? defaultToolsRoot(home),
    };
  }
  if ("blocked" in attached) return fail(attached.reasons);
  if ("stale" in attached) return fail(attached.reasons);
  if (options.allowColdStart === false) {
    return fail(["No running workbench was found. This profile does not start a second controller."]);
  }
  if (markerError) return fail([markerError]);

  const access = { allowRealHome: options.allowRealHome === true };
  if (access.allowRealHome) authorizeProductHome(home);

  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const runtime = bindDshCli(typeof argv[1] === "string" ? argv[1] : "");
  if (!runtime) {
    return fail(["The bound DSH CLI could not be validated from the current process."]);
  }
  if (!isRealFile(execPath)) {
    return fail(["The current Node executable could not be validated."]);
  }

  const payloadRoot = realDirectory(options.payloadRoot ?? defaultPayloadRoot());
  if (!payloadRoot) {
    return fail(["Packaged supervisor payload is missing."]);
  }

  const toolsRoot = realOrCreateToolsRoot(options.toolsRoot ?? defaultToolsRoot(home), home);
  if (!toolsRoot) return fail(["Supervisor tools directory could not be created outside Home."]);

  const snapshotRoot = options.snapshotRoot ? validateSnapshotRoot(home, options.snapshotRoot) : undefined;
  if (options.snapshotRoot && !snapshotRoot) {
    return fail(["snapshotRoot must be a real directory outside snapshot-replaced Home entries."]);
  }

  let selectedPayloadDir: string | undefined;
  try {
    const pointerDigest = readSelectedPointerDigest(home, toolsRoot, access);
    selectedPayloadDir = pointerDigest ? join(toolsRoot, "components", pointerDigest, "lib") : undefined;
  } catch (error) {
    return fail(["Selected component payload pointer is invalid.", reasonOf(error)]);
  }

  // A legacy ownerless reservation cannot safely be declared dead by its age.
  if (pathExists(join(toolsRoot, COLD_START_LOCK_NAME))) {
    return fail(["A legacy startup reservation has no process identity. Ownership could not be verified."]);
  }
  const reservation = new HomeOperationLock(toolsRoot);
  if (initiallyPreparing) {
    return await pollEndpoint(home, selectedPayloadDir ?? payloadRoot, toolsRoot, options, [
      "Another supervisor cold start was already in progress when this request began.",
    ]);
  }
  const label = coldStartLockLabel(home, access);
  const preparing = reservation.inspect();
  if (preparing.held && (!("owner" in preparing) || !validLaunchOwner(preparing.owner) || preparing.owner.label !== label)) {
    return fail(["Startup reservation ownership is incomplete or does not match this Home."]);
  }
  if (preparing.held && "owner" in preparing && preparing.owner.label === label && validLaunchOwner(preparing.owner) &&
      defaultPidAlive(preparing.owner.pid, preparing.owner.startedAt) === "dead") {
    const retired = reservation.unlockDead(preparing.owner);
    if (!retired.unlocked && retired.reason !== "not-held") {
      return fail([`The previous startup reservation could not be released: ${retired.reason}.`]);
    }
  }
  let entered = false;
  let diagnosticFile: string | undefined;
  try {
    const result = await reservation.run<SupervisorBootstrapResult>(label, async () => {
      entered = true;
      // The initial discovery is bound to this launch. A failed competing launch
      // must not become a second automatic attempt by a waiter.
      const current = await attachExistingSupervisor({ home, allowRealHome: access.allowRealHome, fetch: options.fetch, timeoutMs: options.timeoutMs });
      if ("endpoint" in current) return { connected: true, origin: current.endpoint.origin, endpoint: current.endpoint, payloadDir: selectedPayloadDir ?? payloadRoot, toolsDir: toolsRoot };
      if (!("missing" in current)) return fail(current.reasons);
      if (readLaunchMarker(home, toolsRoot) !== initialLaunch) {
        return fail(["Another startup finished before this request obtained ownership. No second startup was attempted.", ...readLastSupervisorDiagnostics(home, toolsRoot)]);
      }
      options.progress?.("prepare");
      diagnosticFile = beginLaunchDiagnostics(home, toolsRoot);
      retirePreviousSupervisor(home, "missing" in attached ? attached.previousOwner : undefined, access.allowRealHome, snapshotRoot ?? undefined);
      let bundled: ValidatedComponentPayload;
      try {
        bundled = validateComponentPayload(payloadRoot);
      } catch (error) {
        return fail(["Bundled component payload could not be staged.", reasonOf(error)]);
      }
      // A source checkout runs in place: components link instead of staging a
      // copy, selecting a pointer, or packing tarballs.
      const devCheckout = detectDevCheckout(payloadRoot);
      let selected: ValidatedComponentPayload | undefined = bundled;
      if (!devCheckout) {
        let pointerDigest: string | undefined;
        try {
          pointerDigest = readSelectedPointerDigest(home, toolsRoot, access);
        } catch (error) {
          return fail(["Selected component payload pointer is invalid.", reasonOf(error)]);
        }
        if (pointerDigest === bundled.digest) {
          try {
            selected = readSelectedComponentPayload(home, toolsRoot, access);
          } catch (error) {
            return fail(["Selected component payload pointer is invalid.", reasonOf(error)]);
          }
        } else {
          try {
            const staged = stageComponentPayload(home, toolsRoot, payloadRoot, access);
            selected = selectComponentPayload(home, toolsRoot, staged.digest, access);
          } catch (error) {
            return fail(["Bundled component payload could not be staged.", reasonOf(error)]);
          }
        }
        if (!selected) return fail(["Selected component payload is missing."]);
      }

      const destEntry = join(selected.packageRoot, ...COMPONENT_PAYLOAD_ENTRIES.supervisor.split("/"));
      const destWorker = join(selected.packageRoot, ...COMPONENT_PAYLOAD_ENTRIES["installation-worker"].split("/"));
      if (!isRealFile(destEntry) || !inside(selected.packageRoot, destEntry)) {
        return fail(["Selected supervisor entry is missing or not a real file."]);
      }
      if (!isRealFile(destWorker) || !inside(selected.packageRoot, destWorker)) {
        return fail(["Selected snapshot-worker.mjs is missing or not a real file."]);
      }

      const artifactArgv: string[] = [];
      if (devCheckout) {
        artifactArgv.push(DEV_CHECKOUT_ARGV_FLAG, devCheckout);
      } else {
        const viewRoot = realDirectory(join(selected.payloadRootLib, VIEW_BRIDGE_PAYLOAD_DIRNAME));
        const browserRoot = realDirectory(join(selected.payloadRootLib, BROWSER_PAYLOAD_DIRNAME));
        const llmRoot = realDirectory(join(selected.payloadRootLib, LLM_BRIDGE_PAYLOAD_DIRNAME));
        if (!viewRoot || !browserRoot || !llmRoot) {
          return fail(["Installed plugin package, view-bridge, browser, or llm-bridge payload is missing."]);
        }
        const packedArtifacts = await packLocalArtifacts({
          pluginPackageRoot: selected.packageRoot,
          viewBridgeRoot: viewRoot,
          browserRoot,
          llmBridgeRoot: llmRoot,
          artifactDir: join(toolsRoot, "artifacts"),
          home,
          execPath,
          env,
          timeoutMs: options.timeoutMs ?? DEFAULT_SUPERVISOR_TIMEOUT_MS,
          pack: options.pack,
        });
        if ("reasons" in packedArtifacts) return fail(packedArtifacts.reasons);
        if (!packedArtifacts.llmBridgeArtifact) {
          return fail(["llm-bridge artifact was not packed from the selected payload."]);
        }
        if (!packedArtifacts.browserArtifact) {
          return fail(["browser artifact was not packed from the selected payload."]);
        }
        artifactArgv.push(
          SUPERVISOR_CLI_FLAGS.pluginArtifact,
          packedArtifacts.pluginArtifact,
          SUPERVISOR_CLI_FLAGS.viewBridgeArtifact,
          packedArtifacts.viewBridgeArtifact,
          SUPERVISOR_CLI_FLAGS.browserArtifact,
          packedArtifacts.browserArtifact,
          SUPERVISOR_CLI_FLAGS.llmBridgeArtifact,
          packedArtifacts.llmBridgeArtifact,
        );
      }

      const childArgv = [
        ...(options.allowRealHome ? ["--allow-real-home"] : []),
        SUPERVISOR_CLI_FLAGS.home,
        home,
        SUPERVISOR_CLI_FLAGS.bin,
        runtime.bin,
        SUPERVISOR_CLI_FLAGS.node,
        execPath,
        ...artifactArgv,
        SUPERVISOR_CLI_FLAGS.controlToolRoot,
        toolsRoot,
        SUPERVISOR_CLI_FLAGS.snapshotWorker,
        destWorker,
        COMPONENT_PAYLOAD_ARGV_FLAG,
        selected.payloadRootLib,
      ];
      if (snapshotRoot) childArgv.push(SUPERVISOR_CLI_FLAGS.snapshotRoot, snapshotRoot);

      const observation: { failure?: string; diagnosticFile: string } = { diagnosticFile };
      let spawned: ChildProcess | void;
      try {
        spawned = (options.spawn ?? defaultSpawn)({
        execPath,
        entry: destEntry,
        argv: childArgv,
        // A linked checkout must not pin the source lib as the process cwd;
        // dev builds replace those files in place. toolsRoot is outside Home.
        cwd: devCheckout ? toolsRoot : join(selected.payloadRootLib, SUPERVISOR_PAYLOAD_DIRNAME),
        env: { ...env, DSH_HOME: home, DSH_SPACES_SUPERVISOR_DIAGNOSTICS: diagnosticFile },
        });
      } catch (error) {
        reportSupervisorLaunchFailure(diagnosticFile, reasonOf(error));
        return fail(["The supervisor process could not be started.", ...readSupervisorDiagnostics(diagnosticFile)]);
      }
      if (spawned) {
        spawned.once("error", (error) => {
          observation.failure = "The supervisor process could not be started.";
          reportSupervisorLaunchFailure(observation.diagnosticFile, reasonOf(error));
        });
        spawned.once("exit", (code, signal) => {
          observation.failure = `The supervisor exited before startup completed (exit code: ${code ?? "unknown"}, signal: ${signal ?? "none"}).`;
          reportSupervisorExit(observation.diagnosticFile, code, signal);
        });
      }
      if (spawned) spawned.unref();
      options.progress?.("launch");
      return await pollEndpoint(home, selected.payloadRootLib, toolsRoot, options, [], observation);
    });
    if (!result.connected && diagnosticFile) reportSupervisorLaunchFailure(diagnosticFile, result.reasons.join("\n"));
    return result;
  } catch (error) {
    if (!entered && error instanceof HomeLockBusyError) {
      return await pollEndpoint(home, selectedPayloadDir ?? payloadRoot, toolsRoot, options, [
        "Another supervisor cold start is already in progress.",
      ]);
    }
    if (diagnosticFile) reportSupervisorLaunchFailure(diagnosticFile, reasonOf(error));
    return fail(["The supervisor process could not be started.", reasonOf(error)]);
  }
}

export function defaultPayloadRoot(from = import.meta.url): string {
  return dirname(fileURLToPath(from));
}

export function defaultToolsRoot(home: string): string {
  return join(resolve(home, ".."), ".dsh-spaces-tools");
}

async function pollEndpoint(
  home: string,
  payloadDir: string,
  toolsDir: string,
  options: SupervisorBootstrapOptions,
  extraReasons: string[],
  observation?: { failure?: string; diagnosticFile: string },
): Promise<SupervisorBootstrapResult> {
  const endpointPath = join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUPERVISOR_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_SUPERVISOR_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const deadline = now() + timeoutMs;
  const reasons = [...extraReasons];
  // Reusable discovery handles: construction is idempotent and every inspect()
  // re-reads on-disk state, so per-round semantics are unchanged. When the
  // lease cannot be constructed up front, fall back to per-call discovery
  // (which reports HOME_UNAVAILABLE as a blocked verdict, as before).
  let polledLease: HomeLease | undefined;
  try {
    polledLease = new HomeLease(home, { allowRealHome: options.allowRealHome === true });
  } catch {
    polledLease = undefined;
  }
  const preparation = new HomeOperationLock(toolsDir);
  while (now() < deadline) {
    if (observation?.failure) return fail([observation.failure, ...readSupervisorDiagnostics(observation.diagnosticFile)]);
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const attached: SupervisorAttachResult = await attachExistingSupervisor({
      home,
      allowRealHome: options.allowRealHome === true,
      fetch: options.fetch,
      timeoutMs: remaining,
      ...(polledLease ? { lease: polledLease } : {}),
    });
    if ("endpoint" in attached) {
      return {
        connected: true,
        origin: attached.endpoint.origin,
        endpoint: attached.endpoint,
        payloadDir,
        toolsDir,
      };
    }
    // A failed or timed-out state read is terminal. An absent endpoint while the
    // owned launch is still preparing stays a bounded observation.
    if ("stale" in attached) return fail(attached.reasons);
    if (!observation && !preparation.inspect().held) {
      return fail(["The other startup ended without a ready supervisor. No second startup was attempted.",
        ...("reasons" in attached ? attached.reasons : []), ...readLastSupervisorDiagnostics(home, toolsDir)]);
    }
    const blocked = diagnoseEndpointResidue(endpointPath);
    if (blocked) reasons.push(blocked);
    const pause = Math.min(pollMs, deadline - now());
    if (pause <= 0) break;
    await sleep(pause);
  }
  reasons.push("Timed out waiting for an authenticated supervisor endpoint.");
  reasons.push(...(observation ? readSupervisorDiagnostics(observation.diagnosticFile) : readLastSupervisorDiagnostics(home, toolsDir)));
  if (!existsSync(join(home, HOME_CONTROL_DIR_NAME))) {
    reasons.push("Control directory was not created.");
  }
  return fail(unique(reasons));
}

function defaultSpawn(request: SupervisorSpawnRequest): ChildProcess {
  const child = spawn(request.execPath, [request.entry, ...request.argv], {
    cwd: request.cwd,
    env: request.env,
    detached: true,
    // The Supervisor owns its durable diagnostics; parent-owned pipes would
    // lose output and outlive (or break when exiting) the desktop shell.
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  return child;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function fail(reasons: string[]): SupervisorBootstrapDiagnosis {
  return { connected: false, origin: null, reasons };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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

function realDirectory(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}

function realOrCreateToolsRoot(path: string, home: string): string | null {
  const resolved = resolve(path);
  if (inside(home, resolved) || samePathResolved(home, resolved)) return null;
  try {
    mkdirSync(resolved, { recursive: true });
  } catch {
    return null;
  }
  return realDirectory(resolved);
}

function inside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  if (r === t) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  const left = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  const right = process.platform === "win32" ? t.toLowerCase() : t;
  return right.startsWith(left);
}

function samePathResolved(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
