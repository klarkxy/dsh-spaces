import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { atomicWrite } from "../../main/atomic";
import { CooperativeChildren } from "./cooperative-children";
import { observeMaintenanceChild, withChildObservation } from "../../main/owned-process-record";
import { inspectHomeToolchain } from "../desktop/control-residue";
import { CoordinatedUpgrade } from "../../main/coordinated-upgrade";
import { DiagnosticsService, sanitizeLogText } from "../../main/diagnostics";
import { setManagedCliPrefix, setSelectedDshResolver, spawnNode } from "../../main/dsh-cli";
import { assertNotRealHome, authorizeProductHome } from "../../main/home-guard";
import { PatchWriter, SESSION_ROW_ID, STORAGE_ROW_ID, extractRoot } from "../../main/patch-writer";
import { archiveAbsPath } from "../../main/plugin-library";
import { pluginAdd } from "../../main/plugin-ops";
import { ProcessManager, type KillKind, type ProcessRuntime } from "../../main/process-manager";
import { ProfileRegistry } from "../../main/profile-registry";
import { describeRuntime, readRuntimeRef } from "../../main/runtime-descriptor";
import { RuntimeStore } from "../../main/runtime-store";
import { SnapshotExecutor } from "../../main/snapshot-executor";
import { setToolchainRoot } from "../../main/toolchain";
import { inferPackageSource, type ProfileStatus } from "../../shared/types";
import { isExactRuntimeVersion } from "../../shared/runtime";
import { sanitizeSpaceIcon } from "../../shared/space-icon";
import type { SnapshotRuntime } from "../../shared/snapshots";
import type { SpaceDetail } from "../../shared/spaces-control";
import type {
  WorkbenchApi,
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime as WorkbenchRuntimeDto,
  WorkbenchPackageRelease,
  WorkbenchSnapshot,
  WorkbenchSpace,
  WorkbenchState,
  WorkbenchView,
} from "../../shared/workbench";
import {
  COMPATIBLE_DSH_CLI_VERSION,
  COMPATIBLE_DSH_CLI_VERSIONS,
  isCompatibleDshCliVersion,
  NodeSpacesControl,
  bindDshCli,
  parseSpaceId,
  SpacesPublicError,
  type BoundCliRunner,
  type SpacesLoaderView,
} from "./spaces-control";
import {
  HOME_CONTROL_DIR_NAME,
  HomeControlBusyError,
  HomeController,
  defaultPidAlive,
  parseControlEndpoint,
  type HomeControlHandle,
  type PidAliveFn,
} from "./home-controller";
import { HomeOperationLock, canonicalHome } from "./home-operation-lock";
import {
  WorkbenchJobError,
  WorkbenchJobStore,
  WORKBENCH_JOBS_DIR_NAME,
  type WorkbenchJobContext,
} from "./workbench-jobs";
import {
  WorkbenchMaintenance as WorkbenchMaintenanceService,
  WORKBENCH_PLANS_DIR_NAME,
  type WorkbenchRecoveryOutcome,
} from "./workbench-maintenance";
import type { WorkbenchMaintenancePorts } from "./workbench-maintenance-ports";
import { WorkbenchPackageUpgrade } from "./workbench-package-upgrade";
import {
  expectedAuthCookieName,
  renderEntryPage,
  safeEqual,
  startWorkbenchHttp,
  type WorkbenchApiMethod,
  type WorkbenchHttpRuntime,
  type ViewBootstrap,
} from "./workbench-http";

export { WORKBENCH_API_METHODS, expectedAuthCookieName } from "./workbench-http";
export { COMPATIBLE_DSH_CLI_VERSION, COMPATIBLE_DSH_CLI_VERSIONS, isCompatibleDshCliVersion };

const SPACES_PLUGIN = "@dsh-spaces/plugin";
const VIEW_ENV = {
  parent: "DSH_SPACES_VIEW_PARENT_ORIGIN",
  id: "DSH_SPACES_VIEW_ID",
  generation: "DSH_SPACES_VIEW_GENERATION",
  channel: "DSH_SPACES_VIEW_CHANNEL",
} as const;
const PLAN_TTL_MS = 5 * 60_000;
const STOP_NOT_FORCED = "Timed stop did not force-kill the process. The instance is still recorded.";
const ENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GLYPH_RE = /^[a-z0-9-]{1,32}$/;
const INSTANCES_DIR_NAME = "instances";
const LIFECYCLE_PLANS_DIR_NAME = "lifecycle-plans";
const ENDPOINT_FILE = "endpoint.json";
const HOST_BEARER_FILE = "host.bearer";
const VIEW_BRIDGE_ID = "dsh-spaces-view-bridge";

const SUPERVISOR_PLAN_KINDS = new Set<WorkbenchPlanRequest["kind"]>([
  "space.stop",
  "space.restart",
  "space.delete",
  "controller.release",
  "controller.shutdown",
]);

export const WORKBENCH_ERROR = {
  "workbench/invalid-input": "The request is not a valid workbench operation.",
  "workbench/unauthorized": "Authentication is required.",
  "workbench/forbidden": "This origin cannot call that workbench method.",
  "workbench/not-found": "That item was not found.",
  "workbench/read-only": "The workbench is read-only until control is acquired.",
  "workbench/unavailable": "A previous operation did not finish. Recovery is required.",
  "workbench/busy": "Another controller already holds run rights for this home.",
  "workbench/unmanaged": "This instance is not managed here. It can be viewed only.",
  "workbench/protected": "The web profile and manager space cannot be changed this way.",
  "workbench/incompatible": `The bound DSH CLI is not a supported version (${COMPATIBLE_DSH_CLI_VERSIONS.join(", ")}).`,
  "workbench/failed": "The workbench request failed.",
  "workbench/maintenance": "That maintenance action is not available yet.",
} as const;

export type WorkbenchErrorCode = keyof typeof WORKBENCH_ERROR;

export class WorkbenchPublicError extends Error {
  readonly name = "WorkbenchPublicError";
  constructor(
    readonly code: WorkbenchErrorCode,
    message: string = WORKBENCH_ERROR[code],
  ) {
    super(message);
  }
}

export interface WorkbenchMaintenance {
  preview(request: WorkbenchPlanRequest): Promise<WorkbenchPlan>;
  execute(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void>;
  plugins(query: string): Promise<WorkbenchPlugin[]>;
  snapshots(): Promise<WorkbenchSnapshot[]>;
  snapshot(id: string): Promise<WorkbenchSnapshot>;
  runtimes(): Promise<WorkbenchRuntimeDto[]>;
  workbenchPackage?(): Promise<WorkbenchPackageRelease | null>;
  backups(spaceId: string): Promise<WorkbenchBackup[]>;
  recover(ctx?: WorkbenchJobContext): Promise<void>;
  recoveryOutcome?(): WorkbenchRecoveryOutcome | undefined;
}

export interface WorkbenchSupervisorOptions {
  home: string;
  bin: string;
  nodeExe?: string;
  port?: number;
  controlToolRoot?: string;
  supervisorAssetRoot?: string;
  pluginArtifact?: string;
  viewBridgeArtifact?: string;
  snapshotWorkerFile?: string;
  snapshotRoot?: string;
  runtimeRoot?: string;
  allowRealHome?: boolean;
  portStart?: number;
  portEnd?: number;
  now?: () => Date;
  fetch?: typeof fetch;
  pidAlive?: PidAliveFn;
  processRuntime?: Partial<ProcessRuntime>;
  createMaintenance?: (ports: WorkbenchMaintenancePorts) => WorkbenchMaintenance;
  runCli?: BoundCliRunner;
  pluginAdd?: (home: string, profile: string, spec: string) => Promise<void>;
  dumpConfig?: (profile: string) => Promise<string>;
  patchWriter?: PatchWriter;
}

export interface SupervisorCliOptions extends WorkbenchSupervisorOptions {
  home: string;
  bin: string;
}

export interface WorkbenchSupervisorHandle {
  server: Server;
  runtime: WorkbenchSupervisorRuntime;
  origin: string;
  bootstrapUrl: string;
  close(): Promise<void>;
}

interface ChildView {
  spaceId: string;
  generation: number;
  origin: string;
  channel: string;
  issued: boolean;
}

interface StoredPlan {
  plan: WorkbenchPlan;
  request: WorkbenchPlanRequest;
  fingerprint: string;
  consumed?: boolean;
}

interface BoundCli {
  bin: string;
  version: string;
}

/**
 * Independent web supervisor: stable 127.0.0.1 entry, HomeController run
 * rights, profile/view/lifecycle, and WorkbenchApi over POST JSON.
 */
export class WorkbenchSupervisorRuntime implements WorkbenchHttpRuntime, WorkbenchApi {
  readonly home: string;
  readonly controlDir: string;
  private origin = "";
  private cookie = "";
  private session = "";
  private bearer = "";
  private bootstrap = new Map<string, number>();
  private readonly nodeExe: string;
  private readonly options: WorkbenchSupervisorOptions;
  private readonly controller: HomeController;
  private readonly lock: HomeOperationLock;
  private readonly registry: ProfileRegistry;
  private readonly patchWriter: PatchWriter;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private handle: HomeControlHandle | undefined;
  private jobs: WorkbenchJobStore | undefined;
  private processes: ProcessManager | undefined;
  private spaces: NodeSpacesControl | undefined;
  private maintenance: WorkbenchMaintenance | null = null;
  private cli: BoundCli | null = null;
  private managerId: string | null = null;
  private managerInstall: "missing" | "manager" | "ordinary" | "damaged" = "missing";
  private maintenanceFlag = false;
  // Inventory is a display snapshot while maintenance swaps its backing tree.
  // Admission still uses the live controller and transaction locks.
  private maintenanceInventory: { mode: WorkbenchState["mode"]; spaces: WorkbenchSpace[] } | null = null;
  private recoveryRequired = false;
  private reasons: string[] = [];
  private derivedRecoveryReasons = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly views = new Map<string, ChildView>();
  private readonly workspaceOrigins = new Set<string>();
  private readonly plans = new Map<string, StoredPlan>();
  private httpClose: (() => Promise<void>) | undefined;
  private relinquishKind: "controller.release" | "controller.shutdown" | null = null;
  private closed = false;
  private sealing = false;
  private maintenanceBlocked = false;
  private runtimeStore: RuntimeStore | undefined;
  private readonly unmanaged = new Set<string>();
  /** Skip starting the manager while recovery jobs are still being bound. */
  private holdManagerStart = false;
  private readonly spawned = new Map<string, { pid: number; startedAt: string }>();
  private readonly pidAlive: PidAliveFn;

  constructor(options: WorkbenchSupervisorOptions) {
    this.options = { ...options };
    this.home = canonicalHome(options.home, { allowRealHome: options.allowRealHome });
    if (options.allowRealHome) authorizeProductHome(this.home);
    if (!options.allowRealHome) assertNotRealHome(this.home);
    this.nodeExe = resolve(options.nodeExe ?? process.execPath);
    this.controlDir = join(this.home, HOME_CONTROL_DIR_NAME);
    this.controller = new HomeController(this.home, {
      allowRealHome: options.allowRealHome,
      pidAlive: options.pidAlive,
    });
    this.lock = new HomeOperationLock(this.home, { allowRealHome: options.allowRealHome });
    this.registry = new ProfileRegistry(this.home, { allowRealHome: options.allowRealHome });
    this.patchWriter = options.patchWriter ?? new PatchWriter(this.home);
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.pidAlive = options.pidAlive ?? defaultPidAlive;
  }

  cookieName(): string {
    const port = new URL(this.origin).port;
    return expectedAuthCookieName(`127.0.0.1:${port}`);
  }
  sessionCookie(): string {
    return this.session;
  }
  sessionEquals(value: string): boolean {
    return safeEqual(this.session, value);
  }
  consumeBootstrapToken(token: string): boolean {
    const expires = this.bootstrap.get(token);
    this.bootstrap.delete(token);
    return expires !== undefined && expires > this.now().getTime();
  }
  hostBearerEquals(value: string): boolean {
    return this.bearer !== "" && safeEqual(this.bearer, value);
  }
  supervisorOrigin(): string {
    return this.origin;
  }
  managerOrigin(): string | null {
    return this.managerId ? this.views.get(this.managerId)?.origin ?? null : null;
  }
  isWorkspaceOrigin(origin: string): boolean {
    return this.workspaceOrigins.has(origin);
  }

  attachHttp(origin: string, close: () => Promise<void>): void {
    this.origin = origin;
    this.httpClose = close;
    this.session = randomBytes(32).toString("hex");
    this.bootstrap.set(randomBytes(24).toString("base64url"), this.now().getTime() + 600_000);
  }

  bootstrapUrl(): string {
    const token = [...this.bootstrap.keys()][0];
    if (!token) throw new Error("bootstrap token was already consumed");
    return `${this.origin}/bootstrap/${token}`;
  }

  mintHandoff(): string {
    for (const [key, expires] of this.bootstrap) {
      if (expires <= this.now().getTime()) this.bootstrap.delete(key);
    }
    if (this.bootstrap.size >= 256) throw new WorkbenchPublicError("workbench/busy");
    const token = randomBytes(24).toString("base64url");
    this.bootstrap.set(token, this.now().getTime() + 60_000);
    return `${this.origin}/bootstrap/${token}`;
  }

  async tryOwn(): Promise<void> {
    const inspection = this.controller.inspect();
    if (inspection.held) {
      this.reasons = this.heldReasons(inspection);
      return;
    }
    try {
      this.handle = this.controller.acquire("web", this.origin);
    } catch (error) {
      if (error instanceof HomeControlBusyError) {
        this.reasons = this.heldReasons(error.inspection);
        return;
      }
      this.recoveryRequired = true;
      this.reasons = ["Writable startup did not finish. The stable entry is still available."];
      return;
    }
    this.writeHostBearer();
    this.writeEndpointFile();
    try {
      await this.initWritable();
    } catch {
      this.recoveryRequired = true;
      this.reasons = [
        ...this.reasons,
        "Writable startup did not finish. The stable entry is still available.",
      ];
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.sealing = true;
    try {
      if (this.jobs) await this.jobs.whenIdle();
      await this.stopOwnedAll();
    } catch (error) {
      this.maintenanceBlocked = true;
      this.recoveryRequired = true;
      if (!this.reasons.includes("Owned processes could not be stopped. Run rights were kept.")) {
        this.reasons.push("Owned processes could not be stopped. Run rights were kept.");
      }
      throw error instanceof Error ? error : new Error(STOP_NOT_FORCED);
    }
    this.dropWritable();
    this.closed = true;
    await this.httpClose?.();
  }

  async dispatch(method: WorkbenchApiMethod, payload: unknown): Promise<unknown> {
    const body = expectObject(payload);
    switch (method) {
      case "state":
        expectKeys(body, []);
        return this.state();
      case "detail":
        expectKeys(body, ["spaceId"]);
        return this.detail(parseSpaceName(body.spaceId));
      case "submit":
        expectKeys(body, ["command", "requestId"]);
        return this.submit(body.command as WorkbenchCommand, parseRequestId(body.requestId));
      case "job":
        expectKeys(body, ["id"]);
        return this.job(parseRequestId(body.id));
      case "cancel":
        expectKeys(body, ["id"]);
        return this.cancel(parseRequestId(body.id));
      case "view":
        expectKeys(body, ["spaceId"]);
        return this.view(parseSpaceName(body.spaceId));
      case "preview":
        expectKeys(body, ["request"]);
        return this.preview(body.request as WorkbenchPlanRequest);
      case "plugins":
        expectKeys(body, [], ["query"]);
        return this.plugins(typeof body.query === "string" ? body.query : "");
      case "snapshots":
        expectKeys(body, []);
        return this.snapshots();
      case "snapshot":
        expectKeys(body, ["id"]);
        return this.snapshot(parseId(body.id));
      case "runtimes":
        expectKeys(body, []);
        return this.runtimes();
      case "workbenchPackage":
        expectKeys(body, []);
        return this.maintenance?.workbenchPackage?.() ?? null;
      case "backups":
        expectKeys(body, ["spaceId"]);
        return this.backups(parseSpaceName(body.spaceId));
    }
  }

  entryPage(): string {
    const managerId = this.managerId;
    const view = managerId ? this.views.get(managerId) : undefined;
    const running = managerId ? this.statusOf(managerId) === "running" : false;
    return renderEntryPage({
      managerRunning: running,
      managerViewPath: running && view ? `/view/${encodeURIComponent(view.spaceId)}/${view.generation}` : null,
      maintenance: this.maintenanceFlag,
      recoveryRequired: this.recoveryRequired,
      writable: Boolean(this.handle),
      reasons: this.reasons,
    });
  }

  async viewEntry(spaceId: string, generation: string): Promise<ViewBootstrap | { status: number; message: string }> {
    const id = parseSpaceName(spaceId);
    const gen = Number(generation);
    if (!Number.isInteger(gen) || gen < 0) {
      return { status: 404, message: "That view entry was not found." };
    }
    const view = this.views.get(id);
    const owned = this.processes?.statusOf(id) === "running";
    if (!view || view.generation !== gen || !owned) {
      return { status: 403, message: "View entry is only issued for owned ready children." };
    }
    const launch = this.processes?.urlOf(id);
    if (!launch) return { status: 403, message: "View entry is only issued for owned ready children." };
    const port = this.processes?.portOf(id);
    if (!port || this.unmanaged.has(id)) {
      return { status: 403, message: "View entry is only issued for owned ready children." };
    }
    const response = await this.fetchImpl(launch, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
    const setCookies = response.headers.getSetCookie();
    await response.body?.cancel();
    if (response.status !== 303 || response.headers.get("location") !== "/" || setCookies.length === 0) {
      return { status: 502, message: "The child authentication exchange failed." };
    }
    const expected = expectedAuthCookieName(`127.0.0.1:${port}`);
    const named = setCookies.filter((row) => {
      const name = row.split("=", 1)[0]?.trim();
      return name === expected;
    });
    if (!named.length) {
      return { status: 502, message: "The child authentication exchange failed." };
    }
    const location = `${view.origin}/`;
    if (/[?&]token=/i.test(location) || named.some((row) => /token=/i.test(row.split(";", 1)[0] ?? ""))) {
      return { status: 502, message: "The child authentication exchange failed." };
    }
    return { setCookies: named, location };
  }

  async state(): Promise<WorkbenchState> {
    this.refreshRecovery();
    const owner = this.maintenanceFlag && this.handle
      ? { kind: this.handle.owner.kind, since: this.handle.owner.startedAt }
      : this.readOwner();
    const inventory = this.maintenanceFlag ? this.maintenanceInventory : null;
    return {
      role: this.role(),
      managerId: this.managerId,
      owner,
      writable: Boolean(this.handle),
      mode: inventory?.mode ?? this.spaces?.capabilities().mode ?? "unknown-readonly",
      dshVersion: this.cli?.version ?? null,
      maintenance: this.maintenanceFlag,
      recoveryRequired: this.recoveryRequired,
      reasons: [...this.reasons],
      spaces: inventory ? inventory.spaces.map(row => ({
        ...row,
        status: this.unmanaged.has(row.id) ? "unknown" : this.publicStatus(row.id),
        generation: this.views.get(row.id)?.generation ?? this.generations.get(row.id) ?? row.generation,
        managed: Boolean(this.handle) && !this.unmanaged.has(row.id),
      })) : this.listSpaces(),
      jobs: this.jobs?.list() ?? [],
    };
  }

  async detail(spaceId: string): Promise<SpaceDetail> {
    const id = this.requireSpace(spaceId);
    if (this.spaces) return this.spaces.detail(id);
    const space = this.listSpaces().find((row) => row.id === id);
    if (!space) throw new WorkbenchPublicError("workbench/not-found");
    return {
      space: {
        id: space.id,
        displayName: space.displayName,
        isHost: space.id === this.managerId,
        hasWebApp: true,
        status: space.status === "running" ? "running" : space.status === "unknown" ? "unknown" : "stopped",
        isolation: space.needsIsolation ? "unverified" : "verified",
      },
      plugins: this.readPlugins(id).map((row) => ({
        name: row.name,
        version: publicPluginVersion(row.version),
      })),
      snapshots: [],
      diagnostics: this.reasons.map((message) => ({ level: "warning" as const, code: "WORKBENCH", message })),
    };
  }

  async submit(command: WorkbenchCommand, requestId: string): Promise<WorkbenchJob> {
    if (command.kind === "controller.acquire") {
      return this.acquireCommand(requestId);
    }
    if (this.closed || this.sealing || this.relinquishKind) {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor is releasing run rights.");
    }
    this.assertWritable();
    if (this.maintenanceBlocked && command.kind !== "recovery.resume") {
      throw new WorkbenchPublicError("workbench/unavailable", "Stop failed; new maintenance is refused.");
    }
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    if (this.recoveryRequired && command.kind !== "recovery.resume") {
      throw new WorkbenchPublicError("workbench/unavailable");
    }
    const job = await this.jobs.submit(command, requestId, (ctx) =>
      this.observeChildWork(() => this.runCommand(command, ctx)),
    );
    if (command.kind === "plan.execute") {
      void this.jobs.whenIdle().then(() => this.finishRelinquish());
    }
    return job;
  }

  async job(id: string): Promise<WorkbenchJob> {
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    return this.jobs.job(id);
  }

  async cancel(id: string): Promise<WorkbenchJob> {
    this.assertWritable();
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    return this.jobs.cancel(id);
  }

  async view(spaceId: string): Promise<WorkbenchView> {
    const id = this.requireSpace(spaceId);
    if (this.unmanaged.has(id) || this.statusOf(id) !== "running") {
      throw new WorkbenchPublicError("workbench/not-found");
    }
    const port = this.processes?.portOf(id);
    if (!port) throw new WorkbenchPublicError("workbench/not-found");
    const generation = this.generations.get(id) ?? 0;
    let current = this.views.get(id);
    if (!current || current.generation !== generation) {
      current = {
        spaceId: id,
        generation,
        origin: `http://127.0.0.1:${port}`,
        channel: randomBytes(8).toString("hex"),
        issued: true,
      };
      this.views.set(id, current);
    }
    current.issued = true;
    return {
      spaceId: current.spaceId,
      generation: current.generation,
      origin: current.origin,
      entryOrigin: this.origin,
      entryPath: `/view/${encodeURIComponent(current.spaceId)}/${current.generation}`,
      channel: current.channel,
    };
  }

  async preview(request: WorkbenchPlanRequest): Promise<WorkbenchPlan> {
    this.assertWritable();
    const parsed = parsePlanRequest(request);
    if (SUPERVISOR_PLAN_KINDS.has(parsed.kind)) return this.previewLocal(parsed);
    if (!this.maintenance) throw new WorkbenchPublicError("workbench/maintenance");
    return this.maintenance.preview(parsed);
  }

  async plugins(query: string): Promise<WorkbenchPlugin[]> {
    if (!this.maintenance) throw new WorkbenchPublicError("workbench/maintenance");
    return this.maintenance.plugins(query);
  }
  async snapshots(): Promise<WorkbenchSnapshot[]> {
    if (!this.maintenance) throw new WorkbenchPublicError("workbench/maintenance");
    return this.maintenance.snapshots();
  }
  async snapshot(id: string): Promise<WorkbenchSnapshot> {
    if (!this.maintenance) throw new WorkbenchPublicError("workbench/maintenance");
    return this.maintenance.snapshot(id);
  }
  async runtimes(): Promise<WorkbenchRuntimeDto[]> {
    if (!this.maintenance) throw new WorkbenchPublicError("workbench/maintenance");
    return this.maintenance.runtimes();
  }
  async backups(spaceId: string): Promise<WorkbenchBackup[]> {
    if (!this.maintenance) throw new WorkbenchPublicError("workbench/maintenance");
    return this.maintenance.backups(spaceId);
  }

  private async acquireCommand(requestId: string): Promise<WorkbenchJob> {
    if (this.closed) {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor is releasing run rights.");
    }
    if (this.handle) {
      return syntheticJob(requestId, "controller.acquire", "succeeded", "Run rights already held.");
    }
    const inspection = this.controller.inspect();
    if (inspection.held) {
      if ("owner" in inspection && inspection.liveness === "dead") {
        const reclaimed = this.controller.reclaimDead();
        if (!reclaimed.reclaimed) throw new WorkbenchPublicError("workbench/busy");
      } else {
        throw new WorkbenchPublicError("workbench/busy");
      }
    }
    this.handle = this.controller.acquire("web", this.origin);
    this.sealing = false;
    this.relinquishKind = null;
    this.writeHostBearer();
    this.writeEndpointFile();
    await this.initWritable();
    return syntheticJob(requestId, "controller.acquire", "succeeded", "Run rights acquired.");
  }

  private async initWritable(): Promise<void> {
    this.bindToolchain();
    mkdirSync(this.controlDir, { recursive: true });
    this.writeHostBearer();
    const identity = await this.controller.ensureManager();
    this.managerId = identity.profileId;
    this.managerInstall = inspectManagerInstall(this.home, identity.profileId);
    this.jobs = new WorkbenchJobStore({ home: this.home, now: this.now });
    this.processes = this.createProcessManager();
    this.reconcileInstanceRecords();
    if (this.hasMaintenanceEvidence() || this.lock.inspect().held || this.unmanaged.size ||
      this.jobs.list().some(job => job.status === "recovery-required")) {
      this.maintenance = this.createMaintenance();
      this.refreshRecovery();
      return;
    }
    const bootstrapPending = this.ownsBootstrap(identity.profileId);
    if (this.managerInstall === "ordinary" && !bootstrapPending) {
      this.recoveryRequired = true;
      this.reasons = [
        "The reserved manager name already belongs to an ordinary profile. It was not overwritten.",
      ];
      this.jobs = new WorkbenchJobStore({ home: this.home, now: this.now });
      this.refreshRecovery();
      return;
    }
    if (this.managerInstall === "damaged") {
      this.recoveryRequired = true;
      this.reasons = ["The manager profile record is damaged and was not rebuilt."];
      this.jobs = new WorkbenchJobStore({ home: this.home, now: this.now });
      this.refreshRecovery();
      return;
    }
    if (this.managerInstall === "missing" || bootstrapPending) {
      if (!this.cli) {
        this.recoveryRequired = true;
        this.reasons = ["A compatible DSH CLI is required before the manager profile can be created."];
        this.jobs = new WorkbenchJobStore({ home: this.home, now: this.now });
        return;
      }
      try {
        await this.observeChildWork(() => this.bootstrapManager(identity.profileId));
        this.managerInstall = inspectManagerInstall(this.home, identity.profileId);
      } catch (error) {
        this.recoveryRequired = true;
        this.reasons = ["Manager initialization did not complete. Its local diagnostic record is available for recovery."];
        atomicWrite(join(this.controlDir, "manager-bootstrap-error.json"), `${JSON.stringify({
          version: 1, at: this.now().toISOString(),
          detail: sanitizeLogText(error instanceof Error ? error.message : String(error)).slice(0, 4000),
        })}\n`);
      }
    }
    const loader = this.managerId ? await this.syncLoader(this.managerId) : undefined;
    this.spaces = this.createSpacesControlWithLoader(loader);
    try {
      this.maintenance = this.createMaintenance();
    } catch {
      this.reasons.push("Maintenance could not be composed.");
    }
    this.refreshRecovery();
    if (this.jobs.list().some((job) => job.status === "recovery-required")) {
      this.recoveryRequired = true;
      if (!this.reasons.includes("Interrupted work must be recovered before new changes.")) {
        this.reasons.push("Interrupted work must be recovered before new changes.");
      }
    }
    if (this.managerInstall === "manager" && this.cli && !this.recoveryRequired && !this.unmanaged.has(identity.profileId)) {
      try {
        await this.startSpace(identity.profileId, silentJobContext());
      } catch (error) {
        this.recoveryRequired = true;
        const detail = error instanceof WorkbenchPublicError ? error.message : "The manager process could not be started.";
        this.reasons.push(`${detail} The stable entry is still available.`);
      }
    }
  }

  private bindToolchain(): void {
    try {
      const recorded = inspectHomeToolchain(this.home);
      if (recorded.kind === "invalid") throw new Error(recorded.reason);
      if (recorded.kind === "verified") {
        this.cli = bindSelectedCli(recorded.bin);
        this.options.controlToolRoot = recorded.toolchainRoot ?? this.options.controlToolRoot;
        this.options.runtimeRoot = recorded.runtimeRoot ?? this.options.runtimeRoot;
        this.options.snapshotRoot = recorded.snapshotRoot ?? this.options.snapshotRoot;
      } else this.cli = bindSelectedCli(this.options.bin);
    } catch (error) {
      this.cli = null;
      this.recoveryRequired = true;
      this.reasons = [
        error instanceof WorkbenchPublicError ? error.message : WORKBENCH_ERROR["workbench/incompatible"],
      ];
      return;
    }
    mkdirSync(this.controlDir, { recursive: true });
    const toolRoot = this.options.controlToolRoot ?? join(this.controlDir, "toolchain");
    setToolchainRoot(toolRoot);
    setManagedCliPrefix(this.options.controlToolRoot ?? join(this.controlDir, "cli"));
    setSelectedDshResolver(() => this.cli?.bin);
    atomicWrite(
      join(this.controlDir, "toolchain.json"),
      `${JSON.stringify(
        {
          version: 1,
          bin: this.cli.bin,
          nodeExe: this.nodeExe,
          dshVersion: this.cli.version,
          toolchainRoot: resolve(toolRoot),
          runtimeRoot: this.runtimeRoot(),
          snapshotRoot: this.snapshotRoot(),
          boundAt: this.now().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }

  private writeHostBearer(): void {
    const path = join(this.controlDir, HOST_BEARER_FILE);
    if (existsSync(path)) {
      try {
        const existing = readFileSync(path, "utf8").trim();
        if (existing) {
          this.bearer = existing;
          return;
        }
      } catch {
        /* replace */
      }
    }
    this.bearer = randomBytes(32).toString("hex");
    writeFileSync(path, `${this.bearer}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
  }

  private writeEndpointFile(): void {
    if (!this.origin || !this.bearer) return;
    mkdirSync(this.controlDir, { recursive: true });
    let origin = this.origin;
    try {
      origin = parseControlEndpoint(this.origin);
    } catch {
      origin = this.origin;
    }
    atomicWrite(
      join(this.controlDir, ENDPOINT_FILE),
      `${JSON.stringify({ version: 1, origin, bearer: this.bearer })}\n`,
    );
    if (this.options.port === undefined) {
      atomicWrite(join(this.controlDir, "entry-port.json"),
        `${JSON.stringify({ version: 1, port: Number(new URL(origin).port) })}\n`);
    }
  }

  private async bootstrapManager(profileId: string, lockHeld = false): Promise<void> {
    const initialize = async () => this.observeChildWork(async () => {
      const existing = inspectManagerInstall(this.home, profileId);
      const pending = this.ownsBootstrap(profileId);
      if ((existing === "ordinary" && !pending) || existing === "damaged") {
        throw new WorkbenchPublicError(
          "workbench/protected",
          "The reserved manager name already belongs to an ordinary profile. It was not overwritten.",
        );
      }
      if (existing === "manager" && !pending) return;
      const marker = join(this.controlDir, "manager-bootstrap.json");
      if (!pending) atomicWrite(marker, `${JSON.stringify({ version: 1, profileId })}\n`);
      // A standalone first launch can precede any user-created DSH profile.
      // Materialize the official shipped web root; do not pass --from-default-profile
      // (rc.2 rejects cloning the shipped `web` profile onto itself).
      if (!existsSync(join(this.home, "profiles", "web"))) {
        const seeded = await this.runBoundCli(["--profile", "web", "--dump-config"]);
        if (seeded.code !== 0) throw new WorkbenchPublicError("workbench/failed", "The official web profile could not be initialized.");
      }
      if (existing === "missing") {
        const created = await this.runBoundCli([
        "--profile",
        profileId,
        "--from-default-profile",
        "web",
        "--dump-config",
        ]);
        if (created.code !== 0) {
        throw new WorkbenchPublicError(
          "workbench/failed",
          "The manager profile could not be created from the bound CLI.",
        );
        }
      }
      this.patchWriter.ensureWorkbenchPatch(profileId);
      const dump = await this.readDump(profileId);
      if (dump) extractRoot(dump, SESSION_ROW_ID);
      if (this.options.pluginArtifact) {
        await this.installArtifact(profileId, this.options.pluginArtifact, "dsh-spaces-plugin");
      }
      if (this.options.viewBridgeArtifact) {
        await this.installArtifact(profileId, this.options.viewBridgeArtifact, VIEW_BRIDGE_ID);
      }
      if (inspectManagerInstall(this.home, profileId) !== "manager") {
        throw new WorkbenchPublicError(
          "workbench/failed",
          "Manager package installation did not complete.",
        );
      }
      this.registry.updateMeta(profileId, { displayName: "Spaces", order: 0 });
      unlinkSync(marker);
    });
    if (lockHeld) await initialize();
    else await this.lock.run("bootstrap-manager", initialize);
  }

  private ownsBootstrap(profileId: string): boolean {
    const marker = join(this.controlDir, "manager-bootstrap.json");
    if (!existsSync(marker)) return false;
    try {
      const record = JSON.parse(readFileSync(marker, "utf8"));
      if (record.version === 1 && record.profileId === profileId) return true;
    } catch { /* Keep unreadable evidence and fail closed. */ }
    throw new WorkbenchPublicError("workbench/unavailable", "The manager bootstrap record requires offline inspection.");
  }

  private async installArtifact(profileId: string, artifact: string, id: string): Promise<void> {
    const dest = archiveAbsPath(this.home, id);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(resolve(artifact), dest);
    const add = this.options.pluginAdd ?? pluginAdd;
    await add(this.home, profileId, dest);
  }

  private createProcessManager(): ProcessManager {
    const injected = this.options.processRuntime ?? {};
    const children = new CooperativeChildren();
    const runtime: Partial<ProcessRuntime> = {
      ...injected,
      spawn: (args, options) => {
        const profile = args[args.indexOf("--profile") + 1] ?? "";
        const env = {
          ...(options.env as NodeJS.ProcessEnv | undefined),
          DSH_HOME: this.home,
          ...this.childViewEnv(profile),
        };
        const spawnFn = injected.spawn ?? children.spawn;
        const port = Number(args[args.indexOf("--port") + 1]);
        mkdirSync(this.instancesDir(), { recursive: true });
        atomicWrite(this.instancePath(profile), `${JSON.stringify({ version: 1, spaceId: profile,
          phase: "spawning", port, generation: this.generations.get(profile) ?? 0,
          origin: `http://127.0.0.1:${port}`, startedAt: this.now().toISOString() })}\n`);
        let child;
        try { child = spawnFn(args, { ...options, env }); }
        catch (error) { this.removeInstanceRecord(profile); throw error; }
        if (child.pid) {
          this.spawned.set(profile, { pid: child.pid, startedAt: this.now().toISOString() });
          try { this.writeInstanceRecord(profile, port, this.generations.get(profile) ?? 0); }
          catch {
            this.maintenanceBlocked = true;
            this.reasons.push("The child identity record could not be saved. Run rights were kept.");
          }
          child.once("exit", () => {
            const recorded = this.spawned.get(profile);
            if (recorded?.pid === child.pid) {
              this.spawned.delete(profile);
              this.removeInstanceRecord(profile);
            }
          });
        } else child.once("error", () => this.removeInstanceRecord(profile));
        return child;
      },
      ensureCli: injected.ensureCli ?? (async () => this.cli?.bin ?? this.options.bin),
      prepareHome:
        injected.prepareHome ??
        (async () => {
          if (existsSync(join(this.home, "profiles", "web"))) {
            await this.runBoundCli(["--profile", "web", "--dump-config"]);
          }
        }),
      fetch: injected.fetch ?? this.fetchImpl,
      kill: async (pid: number, kind: KillKind) => {
        if (kind === "kill") throw new Error(STOP_NOT_FORCED);
        if (injected.kill) return injected.kill(pid, "term");
        await children.stop(pid);
      },
      gracefulWaitMs: injected.gracefulWaitMs ?? 5_000,
      forceWaitMs: injected.forceWaitMs ?? 50,
    };
    return new ProcessManager(
      this.home,
      this.patchWriter,
      this.options.portStart ?? 3100,
      this.options.portEnd ?? 3199,
      runtime,
    );
  }

  private createMaintenance(): WorkbenchMaintenance | null {
    if (!this.processes) return null;
    const snapshotRoot = this.snapshotRoot();
    const worker = this.options.snapshotWorkerFile ?? defaultSnapshotWorkerFile();
    const snapshots = new SnapshotExecutor({
      home: this.home,
      root: snapshotRoot,
      workerFile: worker,
    });
    const runtimes = new RuntimeStore({
      installWorker: { file: worker, home: this.home },
      root: this.runtimeRoot(),
      snapshotRoot,
      source: () => inferPackageSource(),
      legacy: () => (this.cli ? { bin: this.cli.bin, version: this.cli.version } : undefined),
    });
    this.runtimeStore = runtimes;
    const upgrades = new CoordinatedUpgrade({
      home: this.home,
      workerFile: worker,
      observeChild: () => observeMaintenanceChild(this.home, () => { this.maintenanceBlocked = true; }),
      profiles: () => this.homeProfileNames(),
      stopAll: () => this.stopOwnedAll(),
      snapshots,
      runtimes,
      runtimeDescriptor: () => this.currentRuntime(),
    });
    const diagnostics = new DiagnosticsService({
      home: this.home,
      profiles: () => this.registry.scan(),
      statusOf: (name) => this.statusOf(name),
      stop: (name) => this.stopOwned(name),
      isMaintenance: () => this.maintenanceFlag,
    });
    const ports = this.maintenancePorts(snapshots, runtimes, upgrades, diagnostics);
    ports.packageUpgrade = new WorkbenchPackageUpgrade({
      home: this.home, managerId: () => this.managerId,
      pluginArtifact: this.options.pluginArtifact, viewBridgeArtifact: this.options.viewBridgeArtifact,
      snapshots, upgrades, currentRuntime: () => this.currentRuntime(),
      stopAll: () => this.stopOwnedAll(), reinitializeManager: () => this.reinitializeManager(),
      pluginAdd: this.options.pluginAdd,
    });
    const create = this.options.createMaintenance ?? ((next) => new WorkbenchMaintenanceService(next, {
      log: (operation, error) => {
        const detail = sanitizeLogText(error instanceof Error ? error.message : String(error ?? "")).slice(0, 4000);
        try {
          appendFileSync(join(this.controlDir, "maintenance-errors.jsonl"), `${JSON.stringify({
            at: this.now().toISOString(), operation, detail,
          })}\n`, { encoding: "utf8", mode: 0o600 });
        } catch {
          this.maintenanceBlocked = true;
          this.reasons.push("Maintenance diagnostics could not be saved. Further changes are blocked.");
        }
      },
    }));
    return create(ports);
  }

  private maintenancePorts(
    snapshots: SnapshotExecutor,
    runtimes: RuntimeStore,
    upgrades: CoordinatedUpgrade,
    diagnostics: DiagnosticsService,
  ): WorkbenchMaintenancePorts {
    return {
      home: this.home,
      registry: this.registry,
      lock: this.lock,
      snapshots,
      runtimes,
      upgrades,
      diagnostics,
      managerId: () => this.managerId,
      assertWritable: () => this.assertWritable(),
      validateSpace: (spaceId, allowManager) => {
        this.validateSpace(spaceId, allowManager);
      },
      statusOf: (spaceId) => this.statusOf(spaceId),
      ownedSpaceIds: () => this.ownedSpaceIds(),
      stopSpace: (spaceId) => this.stopOwned(spaceId),
      stopAll: () => this.stopOwnedAll(),
      startSpace: async (spaceId) => { await this.startSpace(spaceId, silentJobContext()); },
      currentRuntime: () => this.currentRuntime(),
      reinitializeManager: () => this.reinitializeManager(),
      setMaintenance: (active) => {
        if (active && !this.maintenanceFlag) {
          this.maintenanceInventory = {
            mode: this.spaces?.capabilities().mode ?? "unknown-readonly",
            spaces: this.listSpaces(),
          };
        }
        this.maintenanceFlag = active;
        if (!active) this.maintenanceInventory = null;
      },
      hasUnfinishedPlan: planId => this.jobs?.hasUnfinishedPlan(planId) ?? false,
      unfinishedPlanIds: () => this.jobs?.unfinishedPlanIds() ?? [],
      isCompatibleRuntime: (version) => isCompatibleDshCliVersion(version),
    };
  }

  private async syncLoader(profileId: string): Promise<SpacesLoaderView | undefined> {
    const dump = await this.readDump(profileId);
    if (!dump) return undefined;
    try {
      const session = extractRoot(dump, SESSION_ROW_ID);
      const storage = extractRoot(dump, STORAGE_ROW_ID);
      if (!session || !storage) return undefined;
      const entries = [
        { id: SESSION_ROW_ID, options: { id: SESSION_ROW_ID, config: { root: session } } },
        { id: STORAGE_ROW_ID, options: { id: STORAGE_ROW_ID, config: { root: storage } } },
      ];
      return { entries: () => entries };
    } catch {
      return undefined;
    }
  }

  private createSpacesControlWithLoader(loader?: SpacesLoaderView): NodeSpacesControl | undefined {
    if (!this.cli || !this.managerId) return undefined;
    return new NodeSpacesControl({
      home: this.home,
      allowRealHome: this.options.allowRealHome,
      argv: [this.nodeExe, this.cli.bin, "--profile", this.managerId],
      env: { ...process.env, DSH_HOME: this.home },
      execPath: this.nodeExe,
      baseUrl: join(this.home, "profiles", this.managerId),
      loader,
      snapshotRoot: this.snapshotRoot(),
      lock: this.lock,
      runCli: this.options.runCli ?? ((args) => this.runBoundCli(args)),
    });
  }

  private snapshotRoot(): string {
    if (this.options.snapshotRoot) return resolve(this.options.snapshotRoot);
    return join(resolve(this.home, ".."), `${basename(this.home)}-snapshots`);
  }

  private runtimeRoot(): string {
    return resolve(this.options.runtimeRoot ?? this.options.controlToolRoot ?? join(this.controlDir, "runtimes"));
  }

  private currentRuntime(): SnapshotRuntime {
    const selected = this.runtimeStore?.current();
    const ref = selected
      ? { bin: selected.bin, version: selected.version }
      : readRuntimeRef(this.cli?.bin) ?? (this.cli ? { bin: this.cli.bin, version: this.cli.version } : undefined);
    return describeRuntime(ref);
  }

  private async reinitializeManager(): Promise<void> {
    const selected = this.runtimeStore?.current();
    if (selected && isCompatibleDshCliVersion(selected.version)) {
      this.cli = { bin: selected.bin, version: selected.version };
    } else if (selected) {
      throw new WorkbenchPublicError("workbench/incompatible");
    } else if (this.options.bin) {
      this.cli = bindSelectedCli(this.options.bin);
    }
    if (this.cli) {
      const bindingPath = join(this.controlDir, "toolchain.json");
      const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
      atomicWrite(bindingPath, `${JSON.stringify({ ...binding, bin: this.cli.bin,
        dshVersion: this.cli.version, boundAt: this.now().toISOString() }, null, 2)}\n`);
    }
    setSelectedDshResolver(() => this.cli?.bin);
    if (this.managerId) {
      this.managerInstall = inspectManagerInstall(this.home, this.managerId);
      if (this.managerInstall === "missing") {
        await this.bootstrapManager(this.managerId, true);
        this.managerInstall = inspectManagerInstall(this.home, this.managerId);
      }
      if (this.managerInstall !== "manager") throw new WorkbenchPublicError("workbench/unavailable");
    }
    const loader = this.managerId ? await this.syncLoader(this.managerId) : undefined;
    this.spaces = this.createSpacesControlWithLoader(loader);
    if (this.holdManagerStart) return;
    if (this.managerId && this.managerInstall === "manager" && !this.unmanaged.has(this.managerId)) {
      const runningWorkspaces = this.ownedSpaceIds().filter(
        (id) => id !== this.managerId && this.statusOf(id) === "running",
      );
      for (const id of runningWorkspaces) {
        await this.stopOwned(id);
      }
      if (this.statusOf(this.managerId) === "running") await this.stopOwned(this.managerId);
      await this.startSpace(this.managerId, silentJobContext());
    }
  }

  private childViewEnv(profile: string): NodeJS.ProcessEnv {
    const generation = String(this.generations.get(profile) ?? 0);
    const view = this.views.get(profile);
    const parent =
      profile === this.managerId ? this.origin : this.managerOrigin() ?? this.origin;
    return {
      [VIEW_ENV.parent]: parent,
      [VIEW_ENV.id]: profile,
      [VIEW_ENV.generation]: generation,
      [VIEW_ENV.channel]: view?.channel ?? "",
    };
  }

  private async runCommand(command: WorkbenchCommand, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void> {
    if (this.sealing && command.kind !== "controller.acquire") {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor is releasing run rights.");
    }
    switch (command.kind) {
      case "space.create":
        return this.createSpace(command.input, ctx);
      case "space.update":
        return this.updateSpace(command, ctx);
      case "space.reorder":
        return this.reorderSpaces(command.spaceIds, ctx);
      case "space.start":
        return this.startSpace(command.spaceId, ctx);
      case "space.verify":
        return this.verifySpace(command.spaceId, ctx);
      case "plan.execute":
        return this.executePlan(command.planId, ctx);
      case "recovery.resume":
        return this.resumeRecovery(ctx);
      case "controller.acquire":
        return undefined;
    }
  }

  private async createSpace(
    input: { name: string; displayName?: string; icon?: string },
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchJob["result"]> {
    ctx.phase("create");
    ctx.cancellable(false);
    const name = parseSpaceName(input.name);
    this.protectSpecial(name, { allowManager: false });
    await this.lock.run("space.create", async () => {
      if (this.spaces) {
        await this.spaces.create({ name, displayName: input.displayName });
      } else {
        throw new WorkbenchPublicError("workbench/unavailable");
      }
      if (input.icon !== undefined) {
        this.registry.updateMeta(name, { icon: parseIcon(input.icon) });
      }
      if (this.options.viewBridgeArtifact) {
        await this.ensureViewBridge(name);
      }
    });
    return { spaceId: name };
  }

  private async updateSpace(
    command: Extract<WorkbenchCommand, { kind: "space.update" }>,
    ctx: WorkbenchJobContext,
  ): Promise<void> {
    ctx.phase("update");
    const id = this.requireSpace(command.spaceId);
    this.protectSpecial(id, { allowManager: true });
    await this.lock.run("space.update", async () => {
      const patch: { displayName?: string; icon?: string } = {};
      if (command.displayName !== undefined) patch.displayName = command.displayName;
      if (command.icon !== undefined) patch.icon = parseIcon(command.icon);
      this.registry.updateMeta(id, patch);
    });
  }

  private async reorderSpaces(spaceIds: string[], ctx: WorkbenchJobContext): Promise<void> {
    ctx.phase("reorder");
    for (const id of spaceIds) this.requireSpace(id);
    await this.lock.run("space.reorder", async () => {
      this.registry.reorder(spaceIds);
    });
  }

  private async startSpace(spaceId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"]> {
    ctx.phase("start");
    ctx.cancellable(true);
    const id = this.requireSpace(spaceId);
    if (id === "web") throw new WorkbenchPublicError("workbench/protected");
    if (this.unmanaged.has(id)) throw new WorkbenchPublicError("workbench/unmanaged");
    if (this.statusOf(id) === "running") {
      if (!this.views.has(id)) throw new WorkbenchPublicError("workbench/unavailable");
      return { spaceId: id, view: await this.view(id) };
    }
    if (id !== this.managerId) await this.ensureViewBridge(id);
    const gen = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, gen);
    const channel = randomBytes(8).toString("hex");
    this.views.set(id, {
      spaceId: id,
      generation: gen,
      origin: this.origin,
      channel,
      issued: false,
    });
    await this.startOwned(id);
    if (this.maintenanceBlocked) throw new WorkbenchPublicError("workbench/unavailable");
    const port = this.processes?.portOf(id);
    if (!port) throw new WorkbenchPublicError("workbench/failed");
    const childOrigin = `http://127.0.0.1:${port}`;
    const current = this.views.get(id);
    if (!current || current.generation !== gen) {
      throw new WorkbenchPublicError("workbench/failed");
    }
    current.origin = childOrigin;
    if (id !== this.managerId) this.workspaceOrigins.add(childOrigin);
    this.writeInstanceRecord(id, port, gen);
    return {
      spaceId: id,
      view: {
        spaceId: id,
        generation: gen,
        origin: childOrigin,
        entryOrigin: this.origin,
        entryPath: `/view/${encodeURIComponent(id)}/${gen}`,
        channel,
      },
    };
  }

  private async verifySpace(spaceId: string, ctx: WorkbenchJobContext): Promise<void> {
    ctx.phase("verify");
    const id = this.requireSpace(spaceId);
    this.protectSpecial(id, { allowManager: false });
    if (!this.spaces) throw new WorkbenchPublicError("workbench/unavailable");
    await this.spaces.verify(id);
  }

  private async executePlan(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void> {
    const stored = this.plans.get(planId) ?? this.readLifecyclePlan(planId);
    if (stored) {
      if (stored.consumed) throw new WorkbenchPublicError("workbench/not-found");
      if (Date.parse(stored.plan.expiresAt) <= this.now().getTime()) {
        this.consumeLifecyclePlan(planId);
        throw new WorkbenchPublicError("workbench/invalid-input", "The preview expired. Request a new preview.");
      }
      const fingerprint = this.fingerprint(stored.request);
      if (fingerprint !== stored.fingerprint) {
        throw new WorkbenchPublicError("workbench/invalid-input", "The target changed. Request a new preview.");
      }
      this.consumeLifecyclePlan(planId);
      if (stored.request.kind === "controller.release" || stored.request.kind === "controller.shutdown") {
        this.relinquishKind = stored.request.kind;
      }
      return this.executeLocal(stored, ctx);
    }
    if (!this.maintenance) throw new WorkbenchPublicError("workbench/maintenance");
    return this.maintenance.execute(planId, ctx);
  }

  private async executeLocal(stored: StoredPlan, ctx: WorkbenchJobContext): Promise<void> {
    const request = stored.request;
    switch (request.kind) {
      case "space.stop": {
        ctx.phase("stop");
        const id = this.requireManaged(request.spaceId);
        await this.stopOwned(id);
        return;
      }
      case "space.restart": {
        ctx.phase("restart");
        const id = this.requireManaged(request.spaceId);
        await this.stopOwned(id);
        await this.startSpace(id, ctx);
        return;
      }
      case "space.delete": {
        ctx.phase("delete");
        const id = this.requireManaged(request.spaceId);
        this.protectSpecial(id, { allowManager: false });
        await this.lock.run("space.delete", async () => {
          await this.stopOwned(id);
          const profileDir = join(this.home, "profiles", id);
          const profileStat = lstatSync(profileDir);
          if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
            throw new WorkbenchPublicError("workbench/protected");
          }
          if (request.removeData && existsSync(this.registry.hubDataDir(id))) {
            const dataStat = lstatSync(this.registry.hubDataDir(id));
            if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) {
              throw new WorkbenchPublicError("workbench/protected");
            }
          }
          this.registry.removeOfficialProfile(id);
          if (request.removeData) this.registry.removeHubData(id);
          this.registry.removeMeta(id);
        });
        return;
      }
      case "controller.release":
      case "controller.shutdown": {
        ctx.phase("stopping-children");
        this.sealing = true;
        try {
          await this.stopOwnedAll();
        } catch (error) {
          this.sealing = false;
          this.relinquishKind = null;
          this.maintenanceBlocked = true;
          throw error;
        }
        ctx.phase("finalizing");
        this.relinquishKind = request.kind;
        return;
      }
      default:
        throw new WorkbenchPublicError("workbench/invalid-input");
    }
  }

  private async resumeRecovery(ctx: WorkbenchJobContext): Promise<void> {
    ctx.phase("inspect-journal");
    ctx.cancellable(false);
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    this.holdManagerStart = true;
    try {
      await this.stopOwnedAll();
      this.unmanaged.clear();
      this.reconcileInstanceRecords();
      if (this.unmanaged.size) {
        throw new WorkbenchPublicError("workbench/unavailable", "Leftover processes must be proven stopped before recovery.");
      }
      if (this.lock.inspect().held) {
        const reclaimed = this.lock.unlockDead();
        if (!reclaimed.unlocked && reclaimed.reason !== "not-held") {
          throw new WorkbenchPublicError("workbench/busy", "The Home transaction lock is live or ambiguous and was left in place.");
        }
      }
      if (this.maintenance) {
        try {
          await this.maintenance.recover(ctx);
        } catch {
          const failed = this.maintenance.recoveryOutcome?.();
          const detail = failed?.message?.trim()
            || "Snapshot or upgrade recovery failed. Diagnostic journals were left in place.";
          ctx.message(detail);
          this.refreshRecovery();
          throw new WorkbenchPublicError(
            "workbench/unavailable",
            `${detail} Use doctor if this entry cannot finish remaining records.`,
          );
        }
      }
      const outcome = this.maintenance?.recoveryOutcome?.();
      if (outcome?.settleInterruptedJobs) {
        await this.settleProvedRecoveryJobs(outcome);
      }
      this.refreshRecovery();
      const leftovers = this.jobs.list().filter((job) => job.status === "recovery-required");
      if (leftovers.length || this.hasMaintenanceEvidence() || this.unmanaged.size) {
        const message =
          "Recovery is still required. Unproved jobs were left in place. Use doctor if this entry cannot finish them.";
        ctx.message(message);
        throw new WorkbenchPublicError("workbench/unavailable", message);
      }
      this.holdManagerStart = false;
      this.maintenanceBlocked = false;
      if (outcome?.settleInterruptedJobs) await this.reinitializeManager();
    } finally {
      this.holdManagerStart = false;
      this.refreshRecovery();
    }
  }

  private async settleProvedRecoveryJobs(outcome: WorkbenchRecoveryOutcome): Promise<void> {
    if (!this.jobs) return;
    for (const job of this.jobs.list()) {
      if (job.status !== "recovery-required") continue;
      const planId = job.kind === "plan.execute" ? readJobPlanId(this.home, job.id) : undefined;
      const plan = planId ? readPlanEvidence(this.home, planId) : undefined;
      const settlement = settlementForRecoveredJob(job.kind, planId, plan, outcome);
      if (!settlement) continue;
      try {
        await this.jobs.settleRecovery(job.id, settlement);
        if (planId) markHandledPlan(this.home, planId, settlement.status);
      } catch {
        /* unreadable/unknown records stay for doctor */
      }
    }
  }

  private async finishRelinquish(): Promise<void> {
    const kind = this.relinquishKind;
    if (!kind) return;
    this.relinquishKind = null;
    this.dropWritable();
    if (kind === "controller.shutdown") {
      this.sealing = true;
      this.closed = true;
      await this.httpClose?.();
      return;
    }
    this.sealing = false;
  }

  private observeChildWork<T>(action: () => T): T {
    return withChildObservation(
      () => observeMaintenanceChild(this.home, () => {
        this.maintenanceBlocked = true;
      }),
      action,
    );
  }

  private dropWritable(): void {
    try {
      this.handle?.release();
    } catch {
      /* already released */
    }
    this.handle = undefined;
    this.removeEndpointFile();
    this.jobs = undefined;
    this.processes = undefined;
    this.spaces = undefined;
    this.maintenance = null;
  }

  private previewLocal(request: WorkbenchPlanRequest): WorkbenchPlan {
    const id = "spaceId" in request ? this.requireSpace(request.spaceId) : "";
    if (request.kind === "space.stop" || request.kind === "space.restart" || request.kind === "space.delete") {
      this.requireManaged(id);
      this.protectSpecial(id, { allowManager: request.kind !== "space.delete" });
      if (request.kind === "space.delete") this.protectSpecial(id, { allowManager: false });
    }
    const running = id && this.statusOf(id) === "running" ? [id] : [];
    const plan: WorkbenchPlan = {
      id: randomUUID(),
      kind: request.kind,
      title: request.kind,
      scope: request.kind.startsWith("controller.") ? "controller" : "space",
      affectedSpaceIds: id ? [id] : this.ownedSpaceIds(),
      runningSpaceIds: request.kind.startsWith("controller.")
        ? this.ownedSpaceIds().filter((name) => this.statusOf(name) === "running")
        : running,
      changes: request.kind === "space.delete" ? [
        "Remove this space's profile and installed plugins.",
        request.removeData ? "Delete this space's isolated sessions and storage." : "Keep this space's isolated sessions and storage on disk.",
      ] : [request.kind],
      destructive: request.kind === "space.delete" || request.kind === "controller.shutdown",
      expiresAt: new Date(this.now().getTime() + PLAN_TTL_MS).toISOString(),
    };
    const stored: StoredPlan = { plan, request, fingerprint: this.fingerprint(request) };
    this.plans.set(plan.id, stored);
    this.writeLifecyclePlan(stored);
    return plan;
  }

  private fingerprint(request: WorkbenchPlanRequest): string {
    const spaces =
      "spaceId" in request
        ? [{ id: request.spaceId, status: this.statusOf(request.spaceId) }]
        : this.ownedSpaceIds().map((id) => ({ id, status: this.statusOf(id) }));
    return JSON.stringify({ request, spaces, owner: Boolean(this.handle) });
  }

  private async startOwned(spaceId: string): Promise<void> {
    this.assertWritable();
    if (!this.processes) throw new WorkbenchPublicError("workbench/read-only");
    if (this.unmanaged.has(spaceId)) throw new WorkbenchPublicError("workbench/unmanaged");
    await this.processes.start(spaceId);
  }

  private async stopOwned(spaceId: string): Promise<void> {
    if (!this.processes) return;
    if (this.unmanaged.has(spaceId)) return;
    await this.processes.stop(spaceId);
    const gen = (this.generations.get(spaceId) ?? 0) + 1;
    this.generations.set(spaceId, gen);
    this.views.delete(spaceId);
    this.removeInstanceRecord(spaceId);
  }

  private async stopOwnedAll(): Promise<void> {
    if (!this.processes) return;
    const names = this.ownedSpaceIds().filter((id) => !this.unmanaged.has(id));
    const failures: string[] = [];
    for (const name of names) {
      try {
        await this.stopOwned(name);
      } catch (error) {
        failures.push(name);
        if (!this.reasons.some((row) => row.includes("could not be stopped"))) {
          this.reasons.push("Owned processes could not be stopped. Run rights were kept.");
        }
        throw error instanceof Error ? error : new Error(STOP_NOT_FORCED);
      }
    }
    if (failures.length) throw new Error(STOP_NOT_FORCED);
  }

  private listSpaces(): WorkbenchSpace[] {
    let records: ReturnType<ProfileRegistry["scan"]> = [];
    try {
      records = this.registry.scan();
    } catch {
      return [];
    }
    return records
      .filter((row) => row.name !== "web")
      .map((row) => {
        const leftover = this.unmanaged.has(row.name);
        const status = leftover ? "unknown" : this.publicStatus(row.name);
        const view = this.views.get(row.name);
        return {
          id: row.name,
          displayName: row.meta.displayName || row.name,
          isHost: row.name === this.managerId,
          hasWebApp: row.hasWebApp,
          isolation: row.needsConversion ? "unverified" : "verified",
          icon: row.meta.icon ?? "",
          status,
          generation: view?.generation ?? this.generations.get(row.name) ?? 0,
          managed: Boolean(this.handle) && !leftover,
          needsIsolation: row.needsConversion,
        } satisfies WorkbenchSpace;
      });
  }

  private publicStatus(name: string): WorkbenchSpace["status"] {
    if (!this.processes) return "stopped";
    const status = this.processes.statusOf(name);
    if (status === "starting") return "starting";
    if (status === "running") return "running";
    if (status === "crashed") return "crashed";
    return "stopped";
  }

  private statusOf(name: string): ProfileStatus {
    return this.processes?.statusOf(name) ?? "stopped";
  }

  private ownedSpaceIds(): string[] {
    return this.listSpaces()
      .filter((row) => row.managed && !this.unmanaged.has(row.id))
      .map((row) => row.id);
  }

  private homeProfileNames(): string[] {
    const names = this.registry.scan().map((row) => row.name);
    if (existsSync(join(this.home, "profiles", "web")) && !names.includes("web")) names.unshift("web");
    return names;
  }

  private requireSpace(spaceId: string): string {
    const id = parseSpaceName(spaceId);
    const hit = this.listSpaces().find((row) => row.id === id) || (id === this.managerId ? { id } : null);
    if (!hit) throw new WorkbenchPublicError("workbench/not-found");
    return id;
  }

  private requireManaged(spaceId: string): string {
    const id = this.requireSpace(spaceId);
    if (!this.processes) throw new WorkbenchPublicError("workbench/unmanaged");
    return id;
  }

  private validateSpace(spaceId: string, allowManager = false): void {
    const id = this.requireSpace(spaceId);
    this.protectSpecial(id, { allowManager });
  }

  private protectSpecial(id: string, options: { allowManager: boolean }): void {
    if (id === "web") throw new WorkbenchPublicError("workbench/protected");
    if (!options.allowManager && id === this.managerId) throw new WorkbenchPublicError("workbench/protected");
  }

  private assertWritable(): void {
    if (!this.handle) throw new WorkbenchPublicError("workbench/read-only");
    if (this.sealing && !this.relinquishKind) throw new WorkbenchPublicError("workbench/unavailable");
  }

  private role(): WorkbenchState["role"] {
    if (!this.managerId) return "uninitialized";
    if (this.managerInstall === "manager") return "manager";
    if (this.managerInstall === "ordinary") return "workspace";
    return "uninitialized";
  }

  private readOwner(): WorkbenchState["owner"] {
    const inspection = this.controller.inspect();
    if (!inspection.held || !("owner" in inspection)) return null;
    return { kind: inspection.owner.kind, since: inspection.owner.startedAt };
  }

  private refreshRecovery(): void {
    const extra: string[] = [];
    if (!this.jobs?.list().some(job => job.status === "running")) {
      if (this.maintenanceFlag || this.hasMaintenanceEvidence() || this.lock.inspect().held) extra.push("Unfinished Home maintenance must be recovered before new changes.");
    }
    if (this.jobs?.list().some((job) => job.status === "recovery-required")) {
      extra.push("Interrupted work must be recovered before new changes.");
    }
    if (!this.cli) extra.push(WORKBENCH_ERROR["workbench/incompatible"]);
    if (this.managerId && this.managerInstall !== "manager") {
      extra.push("The manager profile cannot be used until recovery.");
    }
    if (this.unmanaged.size) extra.push("Leftover processes were not adopted. Recovery is required for those instances.");
    if (this.maintenanceBlocked) extra.push("Owned processes could not be stopped. Run rights were kept.");
    this.reasons = [...new Set([
      ...this.reasons.filter(reason => !this.derivedRecoveryReasons.has(reason)),
      ...extra,
    ])];
    this.derivedRecoveryReasons = new Set(extra);
    this.recoveryRequired = extra.length > 0;
  }

  private hasMaintenanceEvidence(): boolean {
    return [
        join(this.home, ".dsh-spaces-restore", "journal.json"),
        join(this.home, ".dsh-spaces-upgrade", "journal.json"),
        join(this.home, ".dsh-spaces-mutation.json"),
        join(this.controlDir, "plugin-mutation.json"),
        join(this.controlDir, "workbench-upgrade.json"),
    ].some(path => {
        try { lstatSync(path); return true; }
        catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    });
  }

  private heldReasons(inspection: ReturnType<HomeController["inspect"]>): string[] {
    if (!inspection.held) return [];
    if ("owner" in inspection && inspection.liveness === "dead") {
      return ["A previous controller is dead. Click acquire to reclaim proven-dead run rights."];
    }
    if ("owner" in inspection && inspection.liveness === "ambiguous") {
      return ["Controller ownership is ambiguous and was not stolen."];
    }
    if ("ambiguous" in inspection && inspection.ambiguous) {
      return [inspection.reason];
    }
    return ["Another controller holds run rights. This entry stays read-only."];
  }

  private readPlugins(name: string): SpaceDetail["plugins"] {
    try {
      const pkg = JSON.parse(readFileSync(join(this.home, "profiles", name, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      return Object.entries(pkg.dependencies ?? {}).map(([pluginName, version]) => ({
        name: pluginName,
        version: publicPluginVersion(version),
      }));
    } catch {
      return [];
    }
  }

  private async readDump(profile: string): Promise<string | undefined> {
    if (this.options.dumpConfig) {
      try {
        return await this.options.dumpConfig(profile);
      } catch {
        return undefined;
      }
    }
    try {
      const result = await this.runBoundCli(["--profile", profile, "--dump-config"]);
      return result.code === 0 ? result.stdout : undefined;
    } catch {
      return undefined;
    }
  }

  private async runBoundCli(args: readonly string[]) {
    if (this.options.runCli) return this.options.runCli(args);
    if (!this.cli) throw new WorkbenchPublicError("workbench/incompatible");
    const { spawnBoundCli } = await import("./spaces-control.ts");
    return spawnBoundCli(this.nodeExe, this.cli.bin, this.home, { ...process.env, DSH_HOME: this.home }, args);
  }

  private instancesDir(): string {
    return join(this.controlDir, INSTANCES_DIR_NAME);
  }

  private instancePath(id: string): string {
    return join(this.instancesDir(), `${id}.json`);
  }

  private writeInstanceRecord(id: string, port: number, generation: number): void {
    const spawned = this.spawned.get(id);
    if (!spawned) return;
    mkdirSync(this.instancesDir(), { recursive: true });
    atomicWrite(
      this.instancePath(id),
      `${JSON.stringify({
        version: 1,
        spaceId: id,
        pid: spawned.pid,
        startedAt: spawned.startedAt,
        port,
        generation,
        origin: `http://127.0.0.1:${port}`,
      })}\n`,
    );
  }

  private removeInstanceRecord(id: string): void {
    try {
      unlinkSync(this.instancePath(id));
    } catch {
      /* gone */
    }
  }

  private reconcileInstanceRecords(): void {
    let names: string[] = [];
    try {
      const stat = lstatSync(this.instancesDir());
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("ambiguous instance directory");
      names = readdirSync(this.instancesDir()).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unmanaged.add("unknown-records");
      return;
    }
    for (const name of names) {
      const path = join(this.instancesDir(), name);
      const id = name.replace(/\.json$/, "");
      let record: { version?: number; kind?: string; spaceId?: string; pid?: number; startedAt?: string; port?: number; generation?: number; origin?: string };
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ambiguous record");
        record = JSON.parse(readFileSync(path, "utf8"));
        parseSpaceName(id);
      } catch {
        this.unmanaged.add("unknown-records");
        continue;
      }
      const maintenanceChild = record?.kind === "maintenance" && /^maintenance-[a-f0-9]{12}$/.test(id);
      if (record?.version !== 1 || record.spaceId !== id || !Number.isInteger(record.pid) || record.pid! <= 0 ||
        typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt)) ||
        (!maintenanceChild && (!Number.isInteger(record.port) || record.port! < 1 || record.port! > 65535 ||
        !Number.isInteger(record.generation) || record.generation! < 0 ||
        record.origin !== `http://127.0.0.1:${record.port}`))) {
        this.unmanaged.add(id);
        continue;
      }
      const liveness = this.pidAlive(record.pid!, record.startedAt);
      if (liveness === "dead") {
        this.removeInstanceRecord(id);
        continue;
      }
      this.unmanaged.add(id);
      this.reasons.push(`Leftover process for ${id} was not adopted.`);
    }
  }

  private writeLifecyclePlan(stored: StoredPlan): void {
    const dir = join(this.controlDir, LIFECYCLE_PLANS_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    atomicWrite(join(dir, `${stored.plan.id}.json`), `${JSON.stringify(stored)}\n`);
  }

  private readLifecyclePlan(id: string): StoredPlan | undefined {
    const memory = this.plans.get(id);
    if (memory) return memory;
    try {
      const parsed = JSON.parse(readFileSync(join(this.controlDir, LIFECYCLE_PLANS_DIR_NAME, `${id}.json`), "utf8")) as StoredPlan;
      if (!parsed?.plan?.id || !parsed.request || !parsed.fingerprint) return undefined;
      this.plans.set(id, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  private consumeLifecyclePlan(id: string): void {
    const stored = this.plans.get(id);
    if (stored) stored.consumed = true;
    this.plans.delete(id);
    try {
      unlinkSync(join(this.controlDir, LIFECYCLE_PLANS_DIR_NAME, `${id}.json`));
    } catch {
      /* gone */
    }
  }

  private removeEndpointFile(): void {
    try {
      unlinkSync(join(this.controlDir, ENDPOINT_FILE));
    } catch {
      /* gone */
    }
  }

  private async ensureViewBridge(profileId: string): Promise<void> {
    if (!this.options.viewBridgeArtifact) return;
    if (profileId === this.managerId) return;
    if (profileHasViewBridge(this.home, profileId)) return;
    await this.installArtifact(profileId, this.options.viewBridgeArtifact, VIEW_BRIDGE_ID);
  }
}

export async function createWorkbenchSupervisor(
  options: WorkbenchSupervisorOptions,
): Promise<WorkbenchSupervisorHandle> {
  const runtime = new WorkbenchSupervisorRuntime(options);
  let port = options.port;
  if (port === undefined) {
    const path = join(resolve(options.home), HOME_CONTROL_DIR_NAME, "entry-port.json");
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Workbench entry port record needs recovery.");
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved.version !== 1 || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535) {
        throw new Error("Workbench entry port record needs recovery.");
      }
      port = saved.port;
    }
  }
  const http = await startWorkbenchHttp(runtime, port ?? 0);
  runtime.attachHttp(http.origin, http.close);
  try {
    await runtime.tryOwn();
  } catch {
    /* HTTP and any acquired lease stay; caller inspects state/reasons */
  }
  return {
    server: http.server,
    runtime,
    origin: http.origin,
    bootstrapUrl: runtime.bootstrapUrl(),
    close: () => runtime.close(),
  };
}

export function parseSupervisorArgs(argv: string[]): SupervisorCliOptions {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--allow-real-home") { flags.allowRealHome = "1"; continue; }
    const mapped = flagName(token);
    if (!mapped) throw new WorkbenchPublicError("workbench/invalid-input", `Unknown flag: ${token}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) {
      throw new WorkbenchPublicError("workbench/invalid-input", `Missing value for ${token}`);
    }
    flags[mapped] = value;
    i += 1;
  }
  const home = requirePath(flags.home, "--home");
  const binFlag = flags.bin ? "--bin" : flags.cli ? "--cli" : "--bin";
  const bin = requirePath(flags.bin ?? flags.cli, binFlag);
  const options: SupervisorCliOptions = { home, bin };
  if (flags.allowRealHome === "1") options.allowRealHome = true;
  if (flags.node) options.nodeExe = requirePath(flags.node, "--node");
  if (flags.port) {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new WorkbenchPublicError("workbench/invalid-input", "Port must be an integer 0-65535.");
    }
    options.port = port;
  }
  if (flags["control-tool-root"]) options.controlToolRoot = requirePath(flags["control-tool-root"], "--control-tool-root");
  if (flags["supervisor-asset-root"]) {
    options.supervisorAssetRoot = requirePath(flags["supervisor-asset-root"], "--supervisor-asset-root");
  }
  if (flags["plugin-artifact"]) options.pluginArtifact = requirePath(flags["plugin-artifact"], "--plugin-artifact");
  if (flags["view-bridge-artifact"]) {
    options.viewBridgeArtifact = requirePath(flags["view-bridge-artifact"], "--view-bridge-artifact");
  }
  if (flags["snapshot-worker"]) options.snapshotWorkerFile = requirePath(flags["snapshot-worker"], "--snapshot-worker");
  if (flags["snapshot-root"]) options.snapshotRoot = requirePath(flags["snapshot-root"], "--snapshot-root");
  return options;
}

export function supervisorCliArgs(options: SupervisorCliOptions): string[] {
  const args = ["--home", options.home, "--bin", options.bin];
  if (options.allowRealHome) args.push("--allow-real-home");
  if (options.nodeExe) args.push("--node", options.nodeExe);
  if (options.port !== undefined) args.push("--port", String(options.port));
  if (options.controlToolRoot) args.push("--control-tool-root", options.controlToolRoot);
  if (options.supervisorAssetRoot) args.push("--supervisor-asset-root", options.supervisorAssetRoot);
  if (options.pluginArtifact) args.push("--plugin-artifact", options.pluginArtifact);
  if (options.viewBridgeArtifact) args.push("--view-bridge-artifact", options.viewBridgeArtifact);
  if (options.snapshotWorkerFile) args.push("--snapshot-worker", options.snapshotWorkerFile);
  if (options.snapshotRoot) args.push("--snapshot-root", options.snapshotRoot);
  return args;
}

function flagName(token: string): string | undefined {
  const names: Record<string, string> = {
    "--home": "home",
    "--bin": "bin",
    "--cli": "cli",
    "--node": "node",
    "--port": "port",
    "--control-tool-root": "control-tool-root",
    "--supervisor-asset-root": "supervisor-asset-root",
    "--plugin-artifact": "plugin-artifact",
    "--view-bridge-artifact": "view-bridge-artifact",
    "--snapshot-worker": "snapshot-worker",
    "--snapshot-root": "snapshot-root",
  };
  return names[token];
}

function requirePath(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new WorkbenchPublicError("workbench/invalid-input", `${flag} is required.`);
  const resolved = resolve(value);
  if (!isAbsolute(resolved)) throw new WorkbenchPublicError("workbench/invalid-input", `${flag} must be a filesystem path.`);
  return resolved;
}

function bindSelectedCli(bin: string): BoundCli {
  const bound = bindDshCli(resolve(bin));
  if (!bound) {
    throw new WorkbenchPublicError("workbench/incompatible", "The selected DSH CLI could not be bound from disk.");
  }
  if (!isCompatibleDshCliVersion(bound.version)) {
    throw new WorkbenchPublicError(
      "workbench/incompatible",
      `Supported CLI is ${COMPATIBLE_DSH_CLI_VERSIONS.join(", ")}; ${bound.version} is not enabled.`,
    );
  }
  return bound;
}

function defaultSnapshotWorkerFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../packages/supervisor/lib/snapshot-worker.mjs"),
    join(here, "../../lib/snapshot-worker.mjs"),
  ];
  if (typeof process.argv[1] === "string") {
    candidates.push(join(dirname(process.argv[1]), "snapshot-worker.mjs"));
    candidates.push(join(dirname(process.argv[1]), "../lib/snapshot-worker.mjs"));
  }
  const found = candidates.map((path) => resolve(path)).find((path) => existsSync(path));
  return found ?? resolve(candidates[0]);
}

function silentJobContext(): WorkbenchJobContext {
  return {
    signal: new AbortController().signal,
    phase: () => undefined,
    message: () => undefined,
    cancellable: () => undefined,
    result: () => undefined,
  };
}

function publicPluginVersion(spec: unknown): string | null {
  if (typeof spec !== "string") return null;
  if (/[\\/]|file:|git\+|github:|:\/\/|token|password|login/i.test(spec)) return null;
  return isExactRuntimeVersion(spec) ? spec : null;
}

function isPlanIdentity(value: string): boolean {
  return ENTITY_RE.test(value);
}

function readContainedJson(home: string, parts: string[]): unknown | undefined {
  let current = home;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[\\/]/.test(part)) return undefined;
    const next = join(current, part);
    try {
      const st = lstatSync(next);
      if (st.isSymbolicLink()) return undefined;
      current = next;
    } catch {
      return undefined;
    }
  }
  try {
    const st = lstatSync(current);
    if (!st.isFile() || st.isSymbolicLink()) return undefined;
    return JSON.parse(readFileSync(current, "utf8"));
  } catch {
    return undefined;
  }
}

function readJobPlanId(home: string, jobId: string): string | undefined {
  if (!isPlanIdentity(jobId)) return undefined;
  const parsed = readContainedJson(home, [HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, `${jobId}.json`]) as
    | { command?: { planId?: unknown } }
    | undefined;
  const planId = parsed?.command?.planId;
  return typeof planId === "string" && isPlanIdentity(planId) ? planId : undefined;
}

function readPlanEvidence(
  home: string,
  planId: string,
): { kind: string; snapshotId?: string } | undefined {
  if (!isPlanIdentity(planId)) return undefined;
  const parsed = readContainedJson(home, [HOME_CONTROL_DIR_NAME, WORKBENCH_PLANS_DIR_NAME, `${planId}.json`]) as
    | { schemaVersion?: unknown; id?: unknown; command?: { kind?: unknown; snapshotId?: unknown } }
    | undefined;
  if (!parsed || parsed.schemaVersion !== 1 || parsed.id !== planId) return undefined;
  const kind = parsed.command?.kind;
  if (typeof kind !== "string" || !kind) return undefined;
  const snapshotId = parsed.command?.snapshotId;
  return {
    kind,
    snapshotId: typeof snapshotId === "string" ? snapshotId : undefined,
  };
}

function settlementForRecoveredJob(
  kind: string,
  planId: string | undefined,
  plan: { kind: string; snapshotId?: string } | undefined,
  outcome: WorkbenchRecoveryOutcome,
): { status: "succeeded" | "failed" | "cancelled"; message: string } | undefined {
  if (kind !== "plan.execute" || !planId || !plan) return undefined;
  if (plan.kind === "workbench.upgrade" && outcome.workbenchPlanId === planId) {
    return outcome.workbenchSucceeded
      ? { status: "succeeded", message: "Workbench package update completed; its durable receipt was recovered." }
      : { status: "failed", message: outcome.workbenchRolledBack
        ? "Workbench package update was rolled back to its whole-home snapshot."
        : "Workbench package update was abandoned before replacing packages." };
  }
  if (
    plan.kind === "snapshot.restore" &&
    (outcome.restoreCompleted || outcome.restoreRolledBack) &&
    outcome.restorePlanId === planId &&
    typeof outcome.snapshotId === "string" &&
    plan.snapshotId === outcome.snapshotId
  ) {
    return outcome.restoreRolledBack
      ? { status: "failed", message: "Interrupted whole-home restore was rolled back; previous data was retained." }
      : { status: "succeeded", message: "Whole-home restore completed by recovery." };
  }
  if (
    plan.kind === "runtime.upgrade" &&
    outcome.upgradeRolledBack &&
    typeof outcome.upgradePlanId === "string" &&
    planId === outcome.upgradePlanId
  ) {
    return { status: "failed", message: "Runtime upgrade was rolled back by recovery." };
  }
  if (
    plan.kind.startsWith("plugin.") &&
    outcome.restoreCompleted &&
    outcome.pluginPlanId &&
    planId === outcome.pluginPlanId
  ) {
    return {
      status: "failed",
      message: "Plugin mutation was overwritten by a whole-home restore. Audit evidence was kept.",
    };
  }
  return undefined;
}

function markHandledPlan(home: string, planId: string, status: "succeeded" | "failed" | "cancelled"): void {
  if (!isPlanIdentity(planId)) return;
  const existing = readContainedJson(home, [HOME_CONTROL_DIR_NAME, WORKBENCH_PLANS_DIR_NAME, `${planId}.json`]);
  if (!existing || typeof existing !== "object") return;
  const parsed = existing as Record<string, unknown>;
  if (parsed.schemaVersion !== 1 || parsed.id !== planId) return;
  parsed.status = status;
  parsed.finishedAt = new Date().toISOString();
  const path = join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_PLANS_DIR_NAME, `${planId}.json`);
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) return;
    atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    /* keep original plan bytes */
  }
}

function profileHasViewBridge(home: string, profileId: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(home, "profiles", profileId, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      dsh?: { profile?: { bundles?: unknown } };
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...(Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []),
    ];
    return names.some((name) => typeof name === "string" && /view-bridge/i.test(name));
  } catch {
    return false;
  }
}

function inspectManagerInstall(home: string, profileId: string): "missing" | "manager" | "ordinary" | "damaged" {
  const dir = join(home, "profiles", profileId);
  if (!existsSync(dir)) return "missing";
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return "damaged";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, unknown>;
      dsh?: { profile?: { bundles?: unknown } };
    };
    const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const deps = pkg.dependencies ?? {};
    if (bundles.includes(SPACES_PLUGIN) || Object.prototype.hasOwnProperty.call(deps, SPACES_PLUGIN)) {
      return "manager";
    }
    return "ordinary";
  } catch {
    return "damaged";
  }
}

function parsePlanRequest(input: unknown): WorkbenchPlanRequest {
  const body = expectObject(input);
  const kind = body.kind;
  if (typeof kind !== "string") throw new WorkbenchPublicError("workbench/invalid-input");
  switch (kind) {
    case "space.stop":
    case "space.restart":
      expectKeys(body, ["kind", "spaceId"]);
      return { kind, spaceId: parseSpaceName(body.spaceId) };
    case "space.delete":
      expectKeys(body, ["kind", "spaceId"], ["removeData"]);
      return {
        kind,
        spaceId: parseSpaceName(body.spaceId),
        removeData: body.removeData === undefined ? false : body.removeData === true,
      };
    case "controller.release":
    case "controller.shutdown":
      expectKeys(body, ["kind"]);
      return { kind };
    case "plugin.install":
      expectKeys(body, ["kind", "spaceIds", "catalogId", "version"]);
      return {
        kind,
        spaceIds: parseIdList(body.spaceIds).map((id) => parseSpaceName(id)),
        catalogId: parsePluginKey(body.catalogId),
        version: parseId(body.version),
      };
    case "plugin.remove":
      expectKeys(body, ["kind", "spaceId", "packageName"]);
      return { kind, spaceId: parseSpaceName(body.spaceId), packageName: parsePluginKey(body.packageName) };
    case "plugin.toggle":
      expectKeys(body, ["kind", "spaceId", "pluginId", "enabled"]);
      if (typeof body.enabled !== "boolean") throw new WorkbenchPublicError("workbench/invalid-input");
      return { kind, spaceId: parseSpaceName(body.spaceId), pluginId: parsePluginKey(body.pluginId), enabled: body.enabled };
    case "plugin.cleanup-manager":
      expectKeys(body, ["kind", "spaceId"]);
      return { kind, spaceId: parseSpaceName(body.spaceId) };
    case "snapshot.create":
      expectKeys(body, ["kind"]);
      return { kind };
    case "snapshot.restore":
    case "snapshot.delete":
      expectKeys(body, ["kind", "snapshotId"]);
      return { kind, snapshotId: parseId(body.snapshotId) };
    case "config.restore":
      expectKeys(body, ["kind", "spaceId", "backupId"]);
      return { kind, spaceId: parseSpaceName(body.spaceId), backupId: parseId(body.backupId) };
    case "runtime.install":
    case "runtime.upgrade":
      expectKeys(body, ["kind", "version"]);
      return { kind, version: parseId(body.version) };
    case "workbench.upgrade":
      expectKeys(body, ["kind", "catalogId", "version"]);
      if (body.catalogId !== "bundled-workbench") throw new WorkbenchPublicError("workbench/invalid-input");
      return { kind, catalogId: "bundled-workbench", version: parseId(body.version) };
    default:
      throw new WorkbenchPublicError("workbench/invalid-input");
  }
}

function parseIcon(value: string): string {
  if (GLYPH_RE.test(value)) return value;
  return sanitizeSpaceIcon(value);
}

function parseId(value: unknown): string {
  if (typeof value !== "string" || !ENTITY_RE.test(value)) {
    throw new WorkbenchPublicError("workbench/invalid-input");
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new WorkbenchPublicError("workbench/invalid-input");
  }
  return value;
}

function parsePluginKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 214 ||
    !/^(?:@?[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value)) {
    throw new WorkbenchPublicError("workbench/invalid-input");
  }
  return value;
}

function parseSpaceName(value: unknown): string {
  const id = parseId(value);
  try {
    return parseSpaceId(id);
  } catch (error) {
    if (error instanceof SpacesPublicError) throw new WorkbenchPublicError("workbench/invalid-input");
    throw error;
  }
}

function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new WorkbenchPublicError("workbench/invalid-input");
  return value.map(parseId);
}

function parseRequestId(value: unknown): string {
  if (typeof value !== "string" || !ENTITY_RE.test(value)) {
    throw new WorkbenchPublicError("workbench/invalid-input");
  }
  return value;
}

function expectObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkbenchPublicError("workbench/invalid-input");
  }
  return value as Record<string, unknown>;
}

function expectKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new WorkbenchPublicError("workbench/invalid-input");
  }
  for (const key of required) {
    if (!(key in value)) throw new WorkbenchPublicError("workbench/invalid-input");
  }
}

function syntheticJob(requestId: string, kind: string, status: WorkbenchJob["status"], message: string): WorkbenchJob {
  const now = new Date().toISOString();
  return {
    id: requestId,
    requestId,
    kind,
    status,
    phase: status,
    message,
    affectedSpaceIds: [],
    createdAt: now,
    updatedAt: now,
    canCancel: false,
  };
}

function termPid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T"], { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => {
        killer.kill();
        resolve();
      }, 5_000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      killer.once("exit", done);
      killer.once("error", done);
    });
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  return Promise.resolve();
}
