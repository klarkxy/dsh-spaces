import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bindDshCli } from "../../../../src/adapters/node/spaces-control";
import { HOME_CONTROL_DIR_NAME } from "../../../../src/adapters/node/home-controller";
import { packLocalArtifacts, pluginPackageRootFromLib, validateSnapshotRoot, type PackOneRequest } from "./supervisor-pack";
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
} as const;

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
 * HomeController lease matches. Otherwise, for allowed roles, copy the
 * immutable program payload outside Home, pack plugin/view-bridge tarballs
 * outside Home, and cold-start the supervisor CLI with those paths.
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
  if (options.allowColdStart === false) {
    const reasons =
      "stale" in attached
        ? attached.reasons
        : ["No running workbench was found. This profile does not start a second controller."];
    return fail(reasons);
  }

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
  const packed = join(payloadRoot, SUPERVISOR_PAYLOAD_DIRNAME);
  const packedReal = realDirectory(packed);
  if (!packedReal || !inside(payloadRoot, packedReal)) {
    return fail(["Packaged supervisor payload directory is missing or not a real directory."]);
  }
  const manifest = readPayloadManifest(packedReal);
  if (!manifest) return fail(["Supervisor payload manifest.json is missing or invalid."]);
  const packedEntry = join(packedReal, manifest.entry);
  if (!isRealFile(packedEntry) || !inside(packedReal, packedEntry)) {
    return fail(["Supervisor payload entry is missing or not a real file."]);
  }
  const packedWorker = join(packedReal, SNAPSHOT_WORKER_FILE);
  if (!isRealFile(packedWorker) || !inside(packedReal, packedWorker)) {
    return fail(["Supervisor snapshot-worker.mjs is missing from the packaged payload."]);
  }

  const digest = contentId(packedReal);
  const toolsRoot = realOrCreateToolsRoot(options.toolsRoot ?? defaultToolsRoot(home), home);
  if (!toolsRoot) return fail(["Supervisor tools directory could not be created outside Home."]);
  const dest = join(toolsRoot, `${manifest.version}-${digest}`);
  try {
    installPayload(packedReal, dest);
  } catch {
    return fail(["Supervisor payload could not be copied to the tools directory."]);
  }
  const destReal = realDirectory(dest);
  if (!destReal || contentId(destReal) !== digest) {
    return fail(["Copied supervisor payload failed verification."]);
  }
  const destEntry = join(destReal, manifest.entry);
  const destWorker = join(destReal, SNAPSHOT_WORKER_FILE);
  if (!isRealFile(destEntry) || !isRealFile(destWorker)) {
    return fail(["Copied supervisor entry or snapshot-worker is not a real file."]);
  }

  const pluginRoot = pluginPackageRootFromLib(payloadRoot);
  const viewRoot = realDirectory(join(payloadRoot, VIEW_BRIDGE_PAYLOAD_DIRNAME));
  if (!pluginRoot || !viewRoot) {
    return fail(["Installed plugin package or view-bridge payload is missing."]);
  }
  const packedArtifacts = await packLocalArtifacts({
    pluginPackageRoot: pluginRoot,
    viewBridgeRoot: viewRoot,
    artifactDir: join(toolsRoot, "artifacts"),
    home,
    execPath,
    env,
    timeoutMs: options.timeoutMs ?? DEFAULT_SUPERVISOR_TIMEOUT_MS,
    pack: options.pack,
  });
  if ("reasons" in packedArtifacts) return fail(packedArtifacts.reasons);

  const snapshotRoot = options.snapshotRoot ? validateSnapshotRoot(home, options.snapshotRoot) : undefined;
  if (options.snapshotRoot && !snapshotRoot) {
    return fail(["snapshotRoot must be a real directory outside snapshot-replaced Home entries."]);
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
    SUPERVISOR_CLI_FLAGS.controlToolRoot,
    toolsRoot,
    SUPERVISOR_CLI_FLAGS.snapshotWorker,
    destWorker,
  ];
  if (snapshotRoot) childArgv.push(SUPERVISOR_CLI_FLAGS.snapshotRoot, snapshotRoot);

  const reservation = join(toolsRoot, "coldstart.lock");
  if (!reserveColdStart(reservation)) {
    return await pollEndpoint(home, destReal, toolsRoot, options, [
      "Another supervisor cold start is already in progress.",
    ]);
  }
  try {
    const spawned = (options.spawn ?? defaultSpawn)({
      execPath,
      entry: destEntry,
      argv: childArgv,
      cwd: destReal,
      env: { ...env, DSH_HOME: home },
    });
    if (spawned) spawned.unref();
  } catch {
    releaseColdStart(reservation);
    return fail(["The supervisor process could not be started."]);
  }

  const polled = await pollEndpoint(home, destReal, toolsRoot, options, []);
  if (!polled.connected) releaseColdStart(reservation);
  else releaseColdStart(reservation);
  return polled;
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
  return spawn(request.execPath, [request.entry, ...request.argv], {
    cwd: request.cwd,
    env: request.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
}

function readPayloadManifest(dir: string): { version: string; entry: string } | null {
  const file = join(dir, "manifest.json");
  if (!isRealFile(file) || !inside(dir, file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; entry?: unknown };
    if (typeof parsed.version !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(parsed.version)) return null;
    if (typeof parsed.entry !== "string" || parsed.entry.includes("..") || parsed.entry.includes("\\")) return null;
    if (parsed.entry.includes("\0") || isAbsolute(parsed.entry) || parsed.entry.startsWith("/")) return null;
    return { version: parsed.version, entry: parsed.entry };
  } catch {
    return null;
  }
}

function installPayload(src: string, dest: string): void {
  if (existsSync(dest)) {
    const current = realDirectory(dest);
    if (current && contentId(current) === contentId(src)) return;
    throw new Error("tools destination exists with different content");
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: false });
}

function contentId(dir: string): string {
  const hash = createHash("sha256");
  for (const rel of listFiles(dir)) {
    hash.update(rel);
    hash.update(readFileSync(join(dir, rel)));
  }
  return hash.digest("hex").slice(0, 16);
}

function listFiles(dir: string, prefix = ""): string[] {
  const rows: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  } catch {
    return rows;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(dir, prefix, entry.name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) rows.push(...listFiles(dir, rel));
    else if (st.isFile()) rows.push(rel);
  }
  return rows;
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
