/** Explicit, offline development deployment. Never used by packaged startup. */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { attachExistingSupervisor } from "../../../packages/plugin/src/host/supervisor-attach";
import { createWorkbenchHttpClient } from "../../../packages/plugin/src/host/workbench-http";
import { packLocalArtifacts, resolveNpmCli } from "../../../packages/plugin/src/host/supervisor-pack";
import { atomicWrite } from "./atomic";
import { ComponentPayloadError, validateComponentPayload, type ValidatedComponentPayload } from "./component-payload";
import { COLD_START_LOCK_NAME, coldStartLockLabel, readSelectedComponentPayload, selectComponentPayload, stageComponentPayload } from "./component-selection";
import { inspectControlResidue, inspectHomeToolchain, resolveControlToolsRoot } from "./control-residue";
import { DSH_CLI_SPEC, setManagedNodeExecutable, setSelectedDshResolver } from "./dsh-cli";
import { cliLoadError, dshPeerRangesFromPayload, unmetDshPeers } from "./component-cli";
import { readRuntimeRef } from "./runtime-descriptor";
import { npmRegistry } from "./package-source";
import { HomeController, defaultPidAlive } from "./home-controller";
import { isInsideRealHome } from "./home-guard";
import { HomeOperationLock } from "./home-operation-lock";
import { archiveAbsPath } from "./plugin-library";
import { pluginAdd } from "./plugin-ops";
import { retirePreviousSupervisor } from "./supervisor-launch";
import { currentPackageSource, runProcess, setToolchainRoot } from "./toolchain";
import { deriveServiceEpoch } from "./workbench-protocol";
import type { WorkbenchApi, WorkbenchState } from "../../shared/workbench";

// This intentionally uses the established maintenance evidence filename. Older
// Supervisors also block on its presence. The distinct kind cannot be mistaken
// for an ordinary workbench upgrade or replayed by an upgrade reader.
export const DEVELOPMENT_UPDATE_FILE = "workbench-upgrade.json";

export interface DevelopmentRefreshOptions {
  home: string;
  userData: string;
  payloadRoot: string;
  log?: (message: string) => void;
}

export function assertDevelopmentPath(path: string): string {
  if (!path?.trim()) throw new Error("Development paths must be explicit.");
  const target = resolve(path);
  // Deliberately ignore packaged/ALLOW_REAL_HOME opt-ins in developer tooling.
  if (isInsideRealHome(target)) throw new Error("Development cannot use the real DSH Home.");
  for (let cursor = target; ; cursor = dirname(cursor)) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || isInsideRealHome(realpathSync(cursor))) {
        throw new Error(`Development path is a symlink or junction: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(cursor) === cursor) break;
  }
  return target;
}

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function assertNoMaintenance(home: string): void {
  for (const path of [
    join(home, ".dsh-spaces-restore/journal.json"),
    join(home, ".dsh-spaces-upgrade/journal.json"),
    join(home, ".dsh-spaces-mutation.json"),
    join(home, ".dsh-spaces-control/plugin-mutation.json"),
    join(home, ".dsh-spaces-control/manager-bootstrap.json"),
    join(home, ".dsh-spaces-control", DEVELOPMENT_UPDATE_FILE),
  ]) {
    assertDevelopmentPath(path);
    if (present(path)) throw new Error(`Unfinished maintenance evidence remains: ${path}`);
  }
}

export function assertDevelopmentServiceIdle(state: WorkbenchState): void {
  if (!state.writable || state.availability !== "ready" || state.maintenance || state.reasons.length) {
    throw new Error("The development service is not healthy and writable. It was not replaced.");
  }
  if (state.jobs.some(job => job.status === "queued" || job.status === "running")) {
    throw new Error("A workbench job is still running. Development refresh was not started.");
  }
  if (state.spaces.some(space => space.id !== state.managerId && space.status !== "stopped")) {
    throw new Error("An ordinary space is active or has failed. Stop active spaces normally before changing development components.");
  }
}

export async function stopDevelopmentService(home: string, api: WorkbenchApi): Promise<void> {
  const state = await api.state();
  assertDevelopmentServiceIdle(state);
  const controller = new HomeController(home);
  // Bind ownership before the shutdown request: a fast successful service may
  // release its lease before submit() returns.
  const owner = controller.inspect();
  if (!owner.held || !("owner" in owner) || "handoff" in owner || owner.liveness !== "alive" ||
      deriveServiceEpoch(owner.owner.nonce) !== state.serviceEpoch) {
    throw new Error("Shutdown ownership could not be verified.");
  }
  const context = { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision };
  const plan = await api.preview({ kind: "service.shutdown" }, context);
  if (plan.serviceEpoch !== context.serviceEpoch || plan.stateRevision !== context.expectedRevision) {
    throw new Error("The service changed before development shutdown.");
  }
  const requestId = randomUUID();
  const job = await api.submit({ kind: "plan.execute", planId: plan.id }, requestId, context);
  const deadline = Date.now() + 60_000;
  // Observe this exact durable job. A lost HTTP response is not success and is
  // never followed by another mutation request.
  while (Date.now() < deadline) {
    const path = assertDevelopmentPath(join(controller.controlDir, "jobs", `${job.id}.json`));
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (record.requestId !== requestId || record.command?.planId !== plan.id) throw new Error("Shutdown receipt does not match this request.");
    if (["failed", "cancelled"].includes(record.status)) throw new Error(`Development shutdown ${record.status}.`);
    if (record.status === "succeeded" && !controller.inspect().held &&
        defaultPidAlive(owner.owner.pid, owner.owner.startedAt) === "dead") return;
    await delay(100);
  }
  throw new Error("Development shutdown did not complete within 60 seconds. No installation was attempted.");
}

function installedPayload(home: string, managerId: string): ValidatedComponentPayload {
  // Package-manager links are valid here, but their resolved target must stay
  // inside this manager's node_modules tree, never the source checkout.
  const modules = assertDevelopmentPath(join(home, "profiles", managerId, "node_modules"));
  const root = realpathSync(join(modules, "@dsh-spaces/plugin"));
  const rel = relative(modules, root);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("The installed development plugin resolves outside the manager profile.");
  }
  return validateComponentPayload(join(root, "lib"));
}

export function verifyDevelopmentInstallation(home: string, managerId: string, payload: ValidatedComponentPayload): void {
  if (installedPayload(home, managerId).digest !== payload.digest) throw new Error("Installed manager component bytes differ from the development build.");
  const modules = assertDevelopmentPath(join(home, "profiles", managerId, "node_modules"));
  const bridge = realpathSync(join(modules, "@dsh-spaces/view-bridge"));
  const bridgeRel = relative(modules, bridge);
  if (!bridgeRel || bridgeRel.startsWith("..") || isAbsolute(bridgeRel)) {
    throw new Error("The installed view bridge resolves outside the manager profile.");
  }
  for (const file of payload.manifest.components["view-bridge"].files) {
    const rel = file.path.replace(/^lib\/view-bridge\//, "");
    const bytes = readFileSync(assertDevelopmentPath(join(bridge, rel)));
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`Installed view bridge differs from the development build: ${rel}`);
    }
  }
}

function recordToolchainCli(home: string, bin: string, version: string): void {
  const path = join(home, ".dsh-spaces-control", "toolchain.json");
  const binding = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  atomicWrite(path, `${JSON.stringify({ ...binding, bin, dshVersion: version, boundAt: new Date().toISOString() }, null, 2)}\n`);
}

async function installDevelopmentCli(prefix: string, nodeExe: string): Promise<string> {
  const bin = join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, ".npmrc"), `registry=${npmRegistry(currentPackageSource())}\n`, "utf8");
  const npm = resolveNpmCli(nodeExe);
  if (!npm) throw new Error("npm-cli.js was not found next to the development Node executable.");
  const result = await runProcess(nodeExe, [
    npm, "install", "--prefix", prefix, "--no-fund", "--no-audit", "--loglevel", "notice", DSH_CLI_SPEC,
  ], { timeoutMs: 10 * 60_000 });
  if (!existsSync(bin)) {
    const detail = (result.stderr || result.stdout).trim().slice(-800);
    throw new Error(detail || `CLI install exited ${result.code}.`);
  }
  return bin;
}

/** The source build names the CLI release it can load. A recorded older CLI is
 * replaced in this Home's tool directory before components are installed. */
async function alignRecordedCli(input: {
  home: string; toolsRoot: string; nodeExe: string; bin: string; version: string;
  payloadRootLib: string; log?: (message: string) => void;
}): Promise<{ bin: string; version: string }> {
  const ranges = dshPeerRangesFromPayload(input.payloadRootLib);
  if (!unmetDshPeers(input.version, ranges).length) return { bin: input.bin, version: input.version };
  const prefix = assertDevelopmentPath(join(input.toolsRoot, "dsh-cli"));
  const presentBin = join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const already = readRuntimeRef(presentBin);
  const chosen = already && !unmetDshPeers(already.version, ranges).length
    ? already
    : readRuntimeRef(await installDevelopmentCli(prefix, input.nodeExe));
  if (!chosen || unmetDshPeers(chosen.version, ranges).length) {
    throw new Error(cliLoadError(input.version, unmetDshPeers(input.version, ranges)));
  }
  recordToolchainCli(input.home, chosen.bin, chosen.version);
  input.log?.(`Recorded CLI ${input.version} cannot load this component. Using ${chosen.version}.`);
  return chosen;
}

export async function refreshDevelopmentRuntime(options: DevelopmentRefreshOptions): Promise<{
  status: "first-install" | "current" | "updated"; digest: string; home: string;
}> {
  const home = assertDevelopmentPath(options.home);
  const userData = assertDevelopmentPath(options.userData);
  const payload = validateComponentPayload(assertDevelopmentPath(options.payloadRoot));
  mkdirSync(home, { recursive: true });
  assertDevelopmentPath(join(home, ".dsh-spaces-control"));
  assertNoMaintenance(home);
  const toolchain = inspectHomeToolchain(home);
  if (toolchain.kind === "invalid") throw new Error(toolchain.reason);
  const toolsRoot = assertDevelopmentPath(resolveControlToolsRoot(home, userData));
  mkdirSync(toolsRoot, { recursive: true });
  if (present(join(toolsRoot, COLD_START_LOCK_NAME))) throw new Error("A legacy startup reservation remains; ownership is unknown.");
  const controller = new HomeController(home);
  const manager = present(join(controller.controlDir, "manager.json")) ? await controller.ensureManager() : undefined;
  let selected: ValidatedComponentPayload | undefined;
  try {
    selected = readSelectedComponentPayload(home, toolsRoot);
  } catch (error) {
    if (!(error instanceof ComponentPayloadError)) throw error;
  }
  const attached = await attachExistingSupervisor({ home, allowRealHome: false });
  if (!("endpoint" in attached) && !("missing" in attached)) throw new Error(attached.reasons.join(" "));
  // A clean first launch remains the normal installer, using this fresh build.
  if (!manager && !selected && toolchain.kind === "absent" && "missing" in attached && !attached.previousOwner) {
    if (new HomeOperationLock(home).inspect().held || inspectControlResidue(home).length) throw new Error("The new Home contains unfinished control state.");
    return { status: "first-install", digest: payload.digest, home };
  }
  if (!manager || toolchain.kind !== "verified") throw new Error("The existing development manager or toolchain is incomplete.");
  assertDevelopmentPath(toolchain.bin);
  assertDevelopmentPath(toolchain.nodeExe);
  const cli = await alignRecordedCli({
    home, toolsRoot, nodeExe: toolchain.nodeExe, bin: toolchain.bin, version: toolchain.dshVersion,
    payloadRootLib: payload.payloadRootLib, log: options.log,
  });
  if (manager.profileId === "web") throw new Error("Development cannot replace the default web profile.");
  assertDevelopmentPath(join(home, "profiles", manager.profileId));
  // A previous build can fail the current file list. That is a reason to replace
  // it, not a reason to refuse the replacement.
  let installed: ValidatedComponentPayload | undefined;
  try {
    installed = installedPayload(home, manager.profileId);
  } catch (error) {
    if (!(error instanceof ComponentPayloadError)) throw error;
  }
  if (installed && selected?.digest === payload.digest && installed.digest === payload.digest) {
    verifyDevelopmentInstallation(home, manager.profileId, payload);
    return { status: "current", digest: payload.digest, home };
  }

  const installedLabel = installed ? installed.digest.slice(0, 12) : "unreadable";
  options.log?.(`Updating development components ${installedLabel} → ${payload.digest.slice(0, 12)}.`);
  const reservation = new HomeOperationLock(toolsRoot);
  return reservation.run(coldStartLockLabel(home), async () => {
    assertNoMaintenance(home);
    if (new HomeOperationLock(home).inspect().held) throw new Error("A Home write is in progress or left an unfinished lock.");
    // Stage and pack immutable bytes before disrupting the healthy service.
    const staged = stageComponentPayload(home, toolsRoot, payload.payloadRootLib);
    const packed = await packLocalArtifacts({
      home, pluginPackageRoot: staged.packageRoot,
      viewBridgeRoot: join(staged.payloadRootLib, "view-bridge"),
      llmBridgeRoot: join(staged.payloadRootLib, "llm-bridge"),
      artifactDir: assertDevelopmentPath(join(toolsRoot, "development-artifacts", staged.digest)),
      execPath: toolchain.nodeExe,
    });
    if ("reasons" in packed) throw new Error(packed.reasons.join(" "));
    if ("endpoint" in attached) {
      options.log?.("Stopping the idle development service normally…");
      await stopDevelopmentService(home, createWorkbenchHttpClient({ endpoint: attached.endpoint }));
    } else {
      retirePreviousSupervisor(home, attached.previousOwner, false);
    }
    return installDevelopmentPayload({ home, toolsRoot, managerId: manager.profileId, payload: staged,
      pluginArtifact: packed.pluginArtifact, bridgeArtifact: packed.viewBridgeArtifact,
      install: async (profile, archive) => {
        setToolchainRoot(toolchain.toolchainRoot ?? toolsRoot);
        setSelectedDshResolver(() => cli.bin);
        setManagedNodeExecutable(toolchain.nodeExe);
        await pluginAdd(home, profile, archive);
      },
    });
  });
}

/** Called with the cold-start reservation held. Injectable installer exercises
 * real locks, file evidence, verification and commit without invoking DSH in tests. */
export async function installDevelopmentPayload(input: {
  home: string; toolsRoot: string; managerId: string; payload: ValidatedComponentPayload;
  pluginArtifact: string; bridgeArtifact: string;
  install: (profile: string, archive: string) => Promise<void>;
}): Promise<{ status: "updated"; digest: string; home: string }> {
  const { home, toolsRoot, managerId, payload } = input;
  assertDevelopmentPath(home);
  assertDevelopmentPath(toolsRoot);
  const reservation = new HomeOperationLock(toolsRoot).inspect();
  if (!reservation.held || !("owner" in reservation) || reservation.owner.pid !== process.pid ||
      reservation.owner.label !== coldStartLockLabel(home)) {
    throw new Error("Development installation requires this process's cold-start reservation.");
  }
  assertNoMaintenance(home);
  const residue = inspectControlResidue(home);
  if (residue.length) throw new Error(residue.join(" "));
  const controller = new HomeController(home);
  if (managerId === "web" || controller.roleOf(managerId) !== "manager") {
    throw new Error("Development installation requires the recorded dedicated manager.");
  }
  const handle = controller.acquire("desktop");
  let released = false;
  try {
    return await new HomeOperationLock(home).run("development-component-update", async () => {
      assertNoMaintenance(home);
      const marker = assertDevelopmentPath(join(controller.controlDir, DEVELOPMENT_UPDATE_FILE));
      const id = randomUUID();
      const evidence = { schemaVersion: 1, kind: "development.refresh", id, managerId, digest: payload.digest, startedAt: new Date().toISOString() };
      atomicWrite(marker, JSON.stringify(evidence));
      for (const [name, artifact] of [["plugin", input.pluginArtifact], ["view", input.bridgeArtifact]]) {
        const archive = assertDevelopmentPath(archiveAbsPath(home, `dev-${name}-${payload.digest}`));
        mkdirSync(dirname(archive), { recursive: true });
        copyFileSync(artifact, archive);
        await input.install(managerId, archive);
      }
      verifyDevelopmentInstallation(home, managerId, payload);
      // Selection rejects an ordinary controller owner. Keep BOTH operation
      // locks until the pointer and evidence are committed, releasing only ours.
      handle.release();
      released = true;
      selectComponentPayload(home, toolsRoot, payload.digest);
      if (JSON.parse(readFileSync(marker, "utf8")).id !== id) throw new Error("Development update evidence changed during commit.");
      unlinkSync(marker);
      return { status: "updated", digest: payload.digest, home };
    });
  } finally {
    if (!released) handle.release();
  }
}
