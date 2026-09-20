import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSelectedComponentPayload,
  selectComponentPayload,
  stageComponentPayload,
} from "../../../../src/adapters/node/component-selection";
import {
  COMPONENT_PAYLOAD_ENTRIES,
  validateComponentPayload,
  type ValidatedComponentPayload,
} from "../../../../src/adapters/node/component-payload";
import { bindDshCli } from "../../../../src/adapters/node/spaces-control";
import { authorizeProductHome } from "../../../../src/adapters/node/home-guard";
import { HOME_CONTROL_DIR_NAME } from "../../../../src/adapters/node/home-controller";
import { packLocalArtifacts, validateSnapshotRoot, type PackOneRequest } from "./supervisor-pack";
import { attachExistingSupervisor } from "./supervisor-attach";
import {
  diagnoseEndpointResidue,
  readEndpointFile,
  SUPERVISOR_ENDPOINT_FILE,
  type SupervisorEndpoint,
} from "./supervisor-endpoint";
import type { WorkbenchHttpFetch } from "./workbench-http";

export { SUPERVISOR_ENDPOINT_FILE, readEndpointFile, writeEndpointFile } from "./supervisor-endpoint";
export type { SupervisorEndpoint } from "./supervisor-endpoint";

export const SUPERVISOR_PAYLOAD_DIRNAME = "supervisor";
export const VIEW_BRIDGE_PAYLOAD_DIRNAME = "view-bridge";
export const LLM_BRIDGE_PAYLOAD_DIRNAME = "llm-bridge";
export const SNAPSHOT_WORKER_FILE = "snapshot-worker.mjs";

/** Matches parseSupervisorArgs in src/adapters/node/workbench-supervisor.ts. */
export const SUPERVISOR_CLI_FLAGS = {
  home: "--home",
  bin: "--bin",
  node: "--node",
  pluginArtifact: "--plugin-artifact",
  viewBridgeArtifact: "--view-bridge-artifact",
  controlToolRoot: "--control-tool-root",
  snapshotWorker: "--snapshot-worker",
  snapshotRoot: "--snapshot-root",
  llmBridgeArtifact: "--llm-bridge-artifact",
} as const;

/** Literal argv flag until primary SUPERVISOR_CLI_FLAGS / parseSupervisorArgs integration. */
export const COMPONENT_PAYLOAD_ARGV_FLAG = "--component-payload";

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
}

/**
 * Attach a live supervisor if the private endpoint authenticates and the
 * HomeController lease matches. Otherwise, for allowed roles, validate and
 * stage the full v2 component group outside Home, pack plugin/view-bridge/
 * llm-bridge tarballs from the selected package, and cold-start the supervisor CLI.
 */
export async function bootstrapSupervisor(
  options: SupervisorBootstrapOptions,
): Promise<SupervisorBootstrapResult> {
  const home = realDirectory(options.home);
  if (!home) return fail(["The DSH home is not a real directory."]);

  const attached = await attachExistingSupervisor({
    home,
    allowRealHome: options.allowRealHome === true,
    fetch: options.fetch,
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

  let selected: ValidatedComponentPayload | undefined;
  try {
    selected = readSelectedComponentPayload(home, toolsRoot, access);
  } catch (error) {
    return fail(["Selected component payload pointer is invalid.", reasonOf(error)]);
  }

  const reservation = join(toolsRoot, "coldstart.lock");
  if (!reserveColdStart(reservation)) {
    return await pollEndpoint(home, selected?.payloadRootLib ?? payloadRoot, toolsRoot, options, [
      "Another supervisor cold start is already in progress.",
    ]);
  }

  try {
    if (!selected) {
      try {
        selected = readSelectedComponentPayload(home, toolsRoot, access);
      } catch (error) {
        return fail(["Selected component payload pointer is invalid.", reasonOf(error)]);
      }
    }
    if (!selected) {
      try {
        validateComponentPayload(payloadRoot);
        const staged = stageComponentPayload(home, toolsRoot, payloadRoot, access);
        selected = selectComponentPayload(home, toolsRoot, staged.digest, access);
      } catch (error) {
        return fail(["Bundled component payload could not be staged.", reasonOf(error)]);
      }
    }
    if (!selected) return fail(["Selected component payload is missing."]);

    const destEntry = join(selected.packageRoot, ...COMPONENT_PAYLOAD_ENTRIES.supervisor.split("/"));
    const destWorker = join(selected.packageRoot, ...COMPONENT_PAYLOAD_ENTRIES["installation-worker"].split("/"));
    if (!isRealFile(destEntry) || !inside(selected.packageRoot, destEntry)) {
      return fail(["Selected supervisor entry is missing or not a real file."]);
    }
    if (!isRealFile(destWorker) || !inside(selected.packageRoot, destWorker)) {
      return fail(["Selected snapshot-worker.mjs is missing or not a real file."]);
    }

    const viewRoot = realDirectory(join(selected.payloadRootLib, VIEW_BRIDGE_PAYLOAD_DIRNAME));
    const llmRoot = realDirectory(join(selected.payloadRootLib, LLM_BRIDGE_PAYLOAD_DIRNAME));
    if (!viewRoot || !llmRoot) {
      return fail(["Installed plugin package, view-bridge, or llm-bridge payload is missing."]);
    }
    const packedArtifacts = await packLocalArtifacts({
      pluginPackageRoot: selected.packageRoot,
      viewBridgeRoot: viewRoot,
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

    const childArgv = [
      ...(options.allowRealHome ? ["--allow-real-home"] : []),
      SUPERVISOR_CLI_FLAGS.home,
      home,
      SUPERVISOR_CLI_FLAGS.bin,
      runtime.bin,
      SUPERVISOR_CLI_FLAGS.node,
      execPath,
      SUPERVISOR_CLI_FLAGS.pluginArtifact,
      packedArtifacts.pluginArtifact,
      SUPERVISOR_CLI_FLAGS.viewBridgeArtifact,
      packedArtifacts.viewBridgeArtifact,
      SUPERVISOR_CLI_FLAGS.llmBridgeArtifact,
      packedArtifacts.llmBridgeArtifact,
      SUPERVISOR_CLI_FLAGS.controlToolRoot,
      toolsRoot,
      SUPERVISOR_CLI_FLAGS.snapshotWorker,
      destWorker,
      COMPONENT_PAYLOAD_ARGV_FLAG,
      selected.payloadRootLib,
    ];
    if (snapshotRoot) childArgv.push(SUPERVISOR_CLI_FLAGS.snapshotRoot, snapshotRoot);

    const spawned = (options.spawn ?? defaultSpawn)({
      execPath,
      entry: destEntry,
      argv: childArgv,
      cwd: join(selected.payloadRootLib, SUPERVISOR_PAYLOAD_DIRNAME),
      env: { ...env, DSH_HOME: home },
    });
    if (spawned) spawned.unref();
    return await pollEndpoint(home, selected.payloadRootLib, toolsRoot, options, []);
  } catch (error) {
    return fail(["The supervisor process could not be started.", reasonOf(error)]);
  } finally {
    releaseColdStart(reservation);
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
): Promise<SupervisorBootstrapResult> {
  const endpointPath = join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUPERVISOR_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_SUPERVISOR_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const deadline = now() + timeoutMs;
  const reasons = [...extraReasons];
  while (now() < deadline) {
    const attached = await attachExistingSupervisor({
      home,
      allowRealHome: options.allowRealHome === true,
      fetch: options.fetch,
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
    const blocked = diagnoseEndpointResidue(endpointPath);
    if (blocked) reasons.push(blocked);
    await sleep(pollMs);
  }
  reasons.push("Timed out waiting for an authenticated supervisor endpoint.");
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
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function reserveColdStart(path: string): boolean {
  try {
    mkdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function releaseColdStart(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    /* reservation is advisory */
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
