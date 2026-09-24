import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { atomicWrite } from "./atomic";
import { CooperativeChildren } from "./cooperative-children";
import { observeMaintenanceChild, withChildObservation } from "./owned-process-record";
import { inspectHomeToolchain } from "./control-residue";
import { CoordinatedUpgrade } from "./coordinated-upgrade";
import { DiagnosticsService, sanitizeLogText } from "./diagnostics";
import { WorkbenchLog } from "./workbench-log";
import { setManagedCliPrefix, setManagedNodeExecutable, setSelectedDshResolver, spawnNode } from "./dsh-cli";
import { assertNotRealHome, authorizeProductHome, samePath } from "./home-guard";
import { PatchWriter, SESSION_ROW_ID, STORAGE_ROW_ID, extractRoot } from "./patch-writer";
import { archiveAbsPath } from "./plugin-library";
import { pluginAdd } from "./plugin-ops";
import { ProcessManager, type KillKind, type ProcessRuntime } from "./process-manager";
import { writeSpaceLlmLaunchSnapshot } from "./llm-snapshot";
import { llmCatalogPath } from "./llm-paths";
import { ProfileRegistry } from "./profile-registry";
import { describeRuntime, readRuntimeRef } from "./runtime-descriptor";
import { RuntimeStore } from "./runtime-store";
import { assertOwnedProfilePath, migrateLegacyProfileSettings } from "./profile-settings";
import { migrateProfileToAlpha } from "./profile-alpha-migration";
import { cliLoadError, dshPeerRangesFromProfile, unmetDshPeers } from "./component-cli";
import { SnapshotExecutor } from "./snapshot-executor";
import { setPackageSource, setToolchainRoot } from "./toolchain";
import { beginLaunchDiagnostics } from "./supervisor-launch";
import type { ProfileStatus } from "../../shared/types";
import { isExactRuntimeVersion } from "../../shared/runtime";
import { redactPublicReason } from "../../shared/public-reason";
import { sanitizeSpaceIcon } from "../../shared/space-icon";
import type { SnapshotRuntime } from "../../shared/snapshots";
import type { SpaceDetail } from "../../shared/spaces-control";
import type {
  WorkbenchApi,
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchMutationContext,
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
import { isWorkbenchProductCommand } from "../../shared/workbench-product";
import type {
  WorkbenchDiagnostics,
  WorkbenchHomeSettings,
  WorkbenchProductCommand,
  WorkbenchProductRequest,
} from "../../shared/workbench-product";
import { parseWorkbenchProductCommand, parseWorkbenchProductRequest } from "../../shared/workbench-product-schemas";
import { readSettings } from "./hub-settings";
import {
  WORKBENCH_PROTOCOL_VERSION,
  WorkbenchProtocolConflictError,
  WorkbenchProtocolInputError,
  assertMutationContext,
  computeWorkbenchRevision,
  deriveServiceEpoch,
  digestHomeIdentity,
  parseMutationContext,
} from "./workbench-protocol";
import { WorkbenchProductService } from "./workbench-products";
import {
  composeBlueprintRuntime,
  inspectBlueprintRuntime,
  resolveBlueprintModule,
} from "./blueprint-runtime";
import {
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
import {
  COMPONENT_PAYLOAD_ENTRIES,
  ComponentPayloadError,
  validateComponentPayload,
  type ValidatedComponentPayload,
} from "./component-payload";
import {
  COMPONENT_HANDOFF_FLAG,
  createComponentHandoffBinding,
  spawnComponentLauncher,
  type ComponentHandoffCommit,
  type SpawnComponentLauncherOptions,
} from "./component-handoff";
import { HomeOperationLock, canonicalHome } from "./home-operation-lock";
import {
  WorkbenchJobError,
  WorkbenchJobStore,
  WORKBENCH_JOBS_DIR_NAME,
  type WorkbenchJobContext,
  type WorkbenchJobsInject,
} from "./workbench-jobs";
import { packLocalArtifacts } from "../../../packages/plugin/src/host/supervisor-pack.ts";
import {
  WorkbenchMaintenance as WorkbenchMaintenanceService,
  WORKBENCH_PLANS_DIR_NAME,
  type WorkbenchRecoveryOutcome,
} from "./workbench-maintenance";
import type { WorkbenchMaintenancePorts } from "./workbench-maintenance-ports";
import {
  WorkbenchPackageUpgrade,
  validateComponentPayloadArtifacts,
  type WorkbenchPackageHandoff,
  type WorkbenchPackageHandoffInput,
} from "./workbench-package-upgrade";
import {
  expectedAuthCookieName,
  renderEntryPage,
  safeEqual,
  startWorkbenchHttp,
  type WorkbenchApiMethod,
  type WorkbenchHttpRuntime,
  type ViewBootstrap,
} from "./workbench-http";
import { createHomeLlmHost } from "./llm-host";
import { GlobalLlmHost, type LlmApplyCommand } from "../../core/application/global-llm-host";
import { LLM_ERROR, LlmConfigError } from "../../core/domain/llm-connections";
import type { LlmInstanceRecord } from "../../core/ports/llm-runtime";
import { isLlmWriteMethod, type LlmApiRequest, type LlmApiResult } from "../../shared/llm-api";

export { WORKBENCH_API_METHODS, expectedAuthCookieName } from "./workbench-http";
export { isCompatibleDshCliVersion };

const SPACES_PLUGIN = "@dsh-spaces/plugin";
const VIEW_ENV = {
  parent: "DSH_SPACES_VIEW_PARENT_ORIGIN",
  id: "DSH_SPACES_VIEW_ID",
  generation: "DSH_SPACES_VIEW_GENERATION",
  channel: "DSH_SPACES_VIEW_CHANNEL",
  epoch: "DSH_SPACES_VIEW_SERVICE_EPOCH",
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
  "service.shutdown",
]);
const REMOVED_COMMAND_KINDS = new Set(["controller.acquire", "recovery.resume"]);
const REMOVED_PLAN_KINDS = new Set(["controller.release", "controller.shutdown", "snapshot.restore", "config.restore"]);

export const WORKBENCH_ERROR = {
  "workbench/invalid-input": "The request is not a valid workbench operation.",
  "workbench/unauthorized": "Authentication is required.",
  "workbench/forbidden": "This origin cannot call that workbench method.",
  "workbench/not-found": "That item was not found.",
  "workbench/read-only": "The workbench is read-only until control is acquired.",
  "workbench/unavailable": "The workbench cannot accept this request.",
  "workbench/unsupported": "That command is not supported.",
  "workbench/conflict": "The service epoch or state revision does not match.",
  "workbench/busy": "Another controller already holds run rights for this home.",
  "workbench/unmanaged": "This instance is not managed here. It can be viewed only.",
  "workbench/protected": "The web profile and manager space cannot be changed this way.",
  "workbench/incompatible": "The bound DSH CLI could not be validated as an exact installed version.",
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
  llmBridgeArtifact?: string;
  snapshotWorkerFile?: string;
  snapshotRoot?: string;
  /** Selected v2 payload `lib` root (`--component-payload`). Absent keeps library callers compatible. */
  componentPayloadRoot?: string;
  /** Internal-only accepted run owner. Never a public browser field. */
  acceptedHandle?: HomeControlHandle;
  /** CLI-only: process may exit after a durable shutdown or flushed handoff commit. */
  onNormalExit?: () => void | Promise<void>;
  /** Test seam forwarded to WorkbenchJobStore. */
  jobsInject?: WorkbenchJobsInject;
  /** Test seam for the one-shot launcher spawn. Production uses spawnComponentLauncher. */
  spawnLauncher?: (options: SpawnComponentLauncherOptions) => ReturnType<typeof spawnComponentLauncher>;
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
  acceptHandoff?: boolean;
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
  serviceEpoch: string;
  issued: boolean;
}

interface StoredPlan {
  plan: WorkbenchPlan;
  request: WorkbenchPlanRequest;
  fingerprint: string;
  consumed?: boolean;
}

type PendingComponentHandoff = {
  jobId: string;
  planId: string;
  snapshotId: string;
  payload: ValidatedComponentPayload;
  pluginArtifact?: string;
  viewBridgeArtifact?: string;
  llmBridgeArtifact?: string;
};

interface BoundCli {
  bin: string;
  version: string;
}

/**
 * Independent web supervisor: stable 127.0.0.1 entry, HomeController run
 * rights, profile/view/lifecycle, and WorkbenchApi over POST JSON.
 */
function dispatchEventName(method: string, payload: unknown): string {
  if (method === "product" && payload && typeof payload === "object") {
    const request = (payload as { request?: unknown }).request;
    const inner = request && typeof request === "object" ? (request as { method?: unknown }).method : "";
    if (typeof inner === "string" && /^[a-z][a-z0-9.-]{0,40}$/.test(inner)) return `product.${inner}`.slice(0, 80);
  }
  const event = method.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 80);
  return event || "request";
}

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
  private products: WorkbenchProductService | null = null;
  private diagnostics: DiagnosticsService | undefined;
  private homeSettings: WorkbenchHomeSettings | undefined;
  private cli: BoundCli | null = null;
  private managerId: string | null = null;
  private managerInstall: "missing" | "manager" | "ordinary" | "damaged" = "missing";
  private maintenanceFlag = false;
  // Inventory is a display snapshot while maintenance swaps its backing tree.
  // Admission still uses the live controller and transaction locks.
  private maintenanceInventory: { mode: WorkbenchState["mode"]; spaces: WorkbenchSpace[] } | null = null;
  private blocked = false;
  private reasons: string[] = [];
  private derivedRecoveryReasons = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly views = new Map<string, ChildView>();
  private readonly workspaceOrigins = new Set<string>();
  private readonly plans = new Map<string, StoredPlan>();
  private httpClose: (() => Promise<void>) | undefined;
  private relinquishKind: "service.shutdown" | null = null;
  private relinquishJobId: string | null = null;
  private closed = false;
  private sealing = false;
  private maintenanceBlocked = false;
  private runtimeStore: RuntimeStore | undefined;
  private readonly unmanaged = new Set<string>();
  /** Skip starting the manager while recovery jobs are still being bound. */
  private holdManagerStart = false;
  private readonly spawned = new Map<string, { pid: number; startedAt: string }>();
  private readonly pidAlive: PidAliveFn;
  private readonly llmApplied = new Map<string, number>();
  private readonly llmBusy = new Set<string>();
  private activeJobId: string | undefined;
  private pendingHandoff: PendingComponentHandoff | undefined;
  private transferredOwner = false;
  private selectedPayload: ValidatedComponentPayload | undefined;
  private packageUpgrade: WorkbenchPackageUpgrade | undefined;
  readonly llmHost: GlobalLlmHost;

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
    if (options.componentPayloadRoot) {
      this.selectedPayload = validateComponentPayload(options.componentPayloadRoot);
    }
    this.llmHost = createHomeLlmHost(this.home, {
      listSpaceIds: async () => this.homeProfileNames(),
      instances: {
        list: async () => this.listLlmInstances(),
        get: async (spaceId) => this.listLlmInstances().find((row) => row.spaceId === spaceId),
        markApplied: async (spaceId, catalogRevision) => {
          this.llmApplied.set(spaceId, catalogRevision);
        },
      },
      assertWritable: () => this.assertLlmWritable(),
      submitApply: (command, requestId) => this.submitLlmApply(command, requestId),
    });
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
      this.blocked = true;
      this.reasons = ["Writable startup did not finish. The stable entry is still available."];
      return;
    }
    this.writeHostBearer();
    this.writeEndpointFile();
    try {
      await this.initWritable();
    } catch {
      this.blocked = true;
      this.reasons = [
        ...this.reasons,
        "Writable startup did not finish. The stable entry is still available.",
      ];
    }
  }

  /**
   * Use an already-accepted run owner instead of acquire. Fresh bearer; epoch
   * follows the accepted nonce. Failure does not acquire a fallback owner.
   */
  async takeAcceptedOwner(handle: HomeControlHandle): Promise<void> {
    this.assertAcceptedHandle(handle);
    this.handle = handle;
    this.writeHostBearer();
    this.writeEndpointFile();
    await this.initWritable();
    this.assertAcceptedStartupReady();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.transferredOwner) {
      this.closed = true;
      this.sealing = true;
      this.handle = undefined;
      await this.httpClose?.();
      return;
    }
    this.sealing = true;
    try {
      if (this.jobs) await this.jobs.whenIdle();
      await this.stopOwnedAll();
    } catch (error) {
      this.maintenanceBlocked = true;
      this.blocked = true;
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
    try {
      return await this.dispatchRequest(method, payload);
    } catch (error) {
      this.rememberDispatchFailure(method, payload, error);
      throw error;
    }
  }

  private async dispatchRequest(method: WorkbenchApiMethod, payload: unknown): Promise<unknown> {
    const body = expectObject(payload);
    switch (method) {
      case "state":
        expectKeys(body, []);
        return this.state();
      case "detail":
        expectKeys(body, ["spaceId"]);
        return this.detail(parseSpaceName(body.spaceId));
      case "submit":
        expectKeys(body, ["command", "requestId", "context"]);
        return this.submit(
          body.command as WorkbenchCommand,
          parseRequestId(body.requestId),
          parseMutationContext(body.context),
        );
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
        expectKeys(body, ["request", "context"]);
        return this.preview(body.request as WorkbenchPlanRequest, parseMutationContext(body.context));
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
      case "llm":
        return this.dispatchLlm(body);
      case "llmCredential":
        return this.dispatchLlmCredential(body);
      case "product":
        expectKeys(body, ["request"]);
        return this.product(parseWorkbenchProductRequest(body.request));
    }
  }

  async llm(request: LlmApiRequest): Promise<LlmApiResult> {
    return this.dispatchLlm(request) as Promise<LlmApiResult>;
  }

  private async dispatchLlm(body: unknown): Promise<unknown> {
    const method = body && typeof body === "object" ? (body as { method?: unknown }).method : undefined;
    if (method === "applyPlan") {
      if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
      return this.llmHost.dispatch(body);
    }
    if (typeof method === "string" && isLlmWriteMethod(method)) {
      if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
      return this.jobs.runExclusive(async () => {
        this.assertLlmMutationAllowed();
        const result = await this.llmHost.dispatch(body);
        await this.maybeInstallLlmBridge(body);
        return result;
      });
    }
    const result = await this.llmHost.dispatch(body);
    await this.maybeInstallLlmBridge(body);
    return result;
  }

  private async dispatchLlmCredential(body: unknown): Promise<unknown> {
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    return this.jobs.runExclusive(async () => {
      this.assertLlmMutationAllowed();
      return this.llmHost.dispatchCredential(body);
    });
  }

  private assertLlmMutationAllowed(): void {
    this.assertWritable();
    if (this.sealing) {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor is releasing run rights.");
    }
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
  }

  private async dispatchLlmAdmitted(body: unknown): Promise<LlmApiResult> {
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    return this.jobs.runAdmitted(async () => {
      const method = body && typeof body === "object" ? (body as { method?: unknown }).method : undefined;
      if (typeof method === "string" && isLlmWriteMethod(method)) {
        this.assertLlmMutationAllowed();
      }
      const result = await this.llmHost.dispatch(body);
      await this.maybeInstallLlmBridge(body);
      return result as LlmApiResult;
    });
  }

  private llmCatalogObservation(): { revision: number; digest: string } {
    const path = llmCatalogPath(this.home);
    let digest = createHash("sha256").update("").digest("hex");
    let revision = 0;
    try {
      const bytes = readFileSync(path);
      digest = createHash("sha256").update(bytes).digest("hex");
      const parsed = JSON.parse(bytes.toString("utf8")) as { revision?: unknown };
      if (typeof parsed.revision === "number" && Number.isInteger(parsed.revision) && parsed.revision >= 0) {
        revision = parsed.revision;
      }
    } catch {
      /* missing catalog is an empty observation */
    }
    return { revision, digest };
  }

  private async maybeInstallLlmBridge(body: unknown): Promise<void> {
    const request = body as { method?: string; spaceId?: string; shared?: { mode?: string } };
    if (
      typeof request.spaceId === "string" &&
      (request.method === "mapImported" ||
        (request.method === "updateSpacePolicy" && request.shared?.mode && request.shared.mode !== "none"))
    ) {
      await this.installLlmBridgeIfExplicit(request.spaceId);
    }
  }

  entryPage(): string {
    const managerId = this.managerId;
    const view = managerId ? this.views.get(managerId) : undefined;
    const running = managerId ? this.statusOf(managerId) === "running" : false;
    const epoch = this.currentServiceEpoch();
    const viewPath =
      running && view
        ? `/view/${encodeURIComponent(view.spaceId)}/${view.generation}${epoch ? `?epoch=${encodeURIComponent(epoch)}` : ""}`
        : null;
    return renderEntryPage({
      managerRunning: running,
      managerViewPath: viewPath,
      maintenance: this.maintenanceFlag,
      writable: Boolean(this.handle),
      reasons: this.reasons,
      serviceEpoch: epoch,
    });
  }

  async viewEntry(
    spaceId: string,
    generation: string,
    epoch?: string | null,
  ): Promise<ViewBootstrap | { status: number; message: string }> {
    const id = parseSpaceName(spaceId);
    const gen = Number(generation);
    if (!Number.isInteger(gen) || gen < 0) {
      return { status: 404, message: "That view entry was not found." };
    }
    const currentEpoch = this.currentServiceEpoch();
    if (!epoch || epoch !== currentEpoch) {
      return { status: 403, message: "View entry requires the current service epoch." };
    }
    const view = this.views.get(id);
    const owned = this.processes?.statusOf(id) === "running";
    if (!view || view.generation !== gen || !owned || view.serviceEpoch !== currentEpoch) {
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
    if (response.status !== 303 || !["/", "./"].includes(response.headers.get("location") ?? "") || setCookies.length === 0) {
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
    this.refreshAvailability(false);
    const owner = this.maintenanceFlag && this.handle
      ? { kind: this.handle.owner.kind, since: this.handle.owner.startedAt }
      : this.readOwner();
    const inventory = this.maintenanceFlag ? this.maintenanceInventory : null;
    const spaces = inventory ? inventory.spaces.map(row => ({
      ...row,
      status: this.unmanaged.has(row.id) ? "unknown" as const : this.publicStatus(row.id),
      generation: this.views.get(row.id)?.generation ?? this.generations.get(row.id) ?? row.generation,
      managed: Boolean(this.handle) && !this.unmanaged.has(row.id),
    })) : this.listSpaces();
    return {
      protocolVersion: WORKBENCH_PROTOCOL_VERSION,
      serviceEpoch: this.currentServiceEpoch(),
      revision: this.stateRevision(spaces),
      availability: this.availability(),
      role: this.role(),
      managerId: this.managerId,
      owner,
      writable: Boolean(this.handle),
      mode: inventory?.mode ?? this.spaces?.capabilities().mode ?? "unknown-readonly",
      dshVersion: this.cli?.version ?? null,
      maintenance: this.maintenanceFlag,
      reasons: [...this.reasons],
      spaces,
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

  async submit(command: WorkbenchCommand, requestId: string, context: WorkbenchMutationContext): Promise<WorkbenchJob> {
    const parsedContext = parseMutationContext(context);
    if (REMOVED_COMMAND_KINDS.has((command as { kind?: string }).kind ?? "")) {
      throw new WorkbenchPublicError("workbench/unsupported");
    }
    if (this.closed || this.sealing || this.relinquishKind) {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor is releasing run rights.");
    }
    this.assertWritable();
    if (this.maintenanceBlocked) {
      throw new WorkbenchPublicError("workbench/unavailable", "Stop failed; new maintenance is refused.");
    }
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    const parsedCommand = isWorkbenchProductCommand(command) ? parseWorkbenchProductCommand(command) : command;
    const job = await this.jobs.submit(parsedCommand, requestId, (ctx) => {
      this.activeJobId = requestId;
      return this.observeChildWork(async () => {
        try {
          this.assertLiveContext(parsedContext);
          return await this.runCommand(parsedCommand, ctx);
        } finally {
          this.activeJobId = undefined;
        }
      });
    });
    if (parsedCommand.kind === "plan.execute") {
      const jobId = job.id;
      void this.jobs.whenIdle().then(() => this.afterPlanJobSettled(jobId));
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
    const epoch = this.requireServiceEpoch();
    let current = this.views.get(id);
    if (!current || current.generation !== generation || current.serviceEpoch !== epoch) {
      current = {
        spaceId: id,
        generation,
        origin: `http://127.0.0.1:${port}`,
        channel: randomBytes(8).toString("hex"),
        serviceEpoch: epoch,
        issued: true,
      };
      this.views.set(id, current);
    }
    current.issued = true;
    return {
      serviceEpoch: current.serviceEpoch,
      spaceId: current.spaceId,
      generation: current.generation,
      origin: current.origin,
      entryOrigin: this.origin,
      entryPath: `/view/${encodeURIComponent(current.spaceId)}/${current.generation}`,
      channel: current.channel,
    };
  }

  async preview(request: WorkbenchPlanRequest, context: WorkbenchMutationContext): Promise<WorkbenchPlan> {
    const parsedContext = parseMutationContext(context);
    this.assertWritable();
    this.assertLiveContext(parsedContext);
    if (REMOVED_PLAN_KINDS.has((request as { kind?: string }).kind ?? "")) {
      throw new WorkbenchPublicError("workbench/unsupported");
    }
    const parsed = parsePlanRequest(request);
    if (SUPERVISOR_PLAN_KINDS.has(parsed.kind)) return this.previewLocal(parsed);
    if (!this.maintenance) throw new WorkbenchPublicError("workbench/maintenance");
    return this.maintenance.preview(parsed);
  }

  async product(request: WorkbenchProductRequest): Promise<Awaited<ReturnType<WorkbenchApi["product"]>>> {
    if (!this.products) throw new WorkbenchPublicError("workbench/read-only");
    return this.products.read(parseWorkbenchProductRequest(request));
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

  private async initWritable(): Promise<void> {
    this.bindToolchain();
    mkdirSync(this.controlDir, { recursive: true });
    const identity = await this.controller.ensureManager();
    this.managerId = identity.profileId;
    this.managerInstall = inspectManagerInstall(this.home, identity.profileId);
    this.jobs = new WorkbenchJobStore({ home: this.home, now: this.now, inject: this.options.jobsInject });
    this.processes = this.createProcessManager();
    this.bindProductService();
    this.reconcileInstanceRecords();
    if (this.hasMaintenanceEvidence() || this.lock.inspect().held || this.unmanaged.size) {
      this.maintenance = this.createMaintenance();
      this.refreshAvailability();
      return;
    }
    const bootstrapPending = this.ownsBootstrap(identity.profileId);
    if (this.managerInstall === "ordinary" && !bootstrapPending) {
      this.blocked = true;
      this.reasons = [
        "The reserved manager name already belongs to an ordinary profile. It was not overwritten.",
      ];
      this.jobs = new WorkbenchJobStore({ home: this.home, now: this.now, inject: this.options.jobsInject });
      this.refreshAvailability();
      return;
    }
    if (this.managerInstall === "damaged") {
      this.blocked = true;
      this.reasons = ["The manager profile record is damaged and was not rebuilt."];
      this.jobs = new WorkbenchJobStore({ home: this.home, now: this.now, inject: this.options.jobsInject });
      this.refreshAvailability();
      return;
    }
    if (this.managerInstall === "missing" || bootstrapPending) {
      if (!this.cli) {
        this.blocked = true;
        this.reasons = ["A compatible DSH CLI is required before the manager profile can be created."];
        this.jobs = new WorkbenchJobStore({ home: this.home, now: this.now, inject: this.options.jobsInject });
        return;
      }
      try {
        await this.observeChildWork(() => this.bootstrapManager(identity.profileId));
        this.managerInstall = inspectManagerInstall(this.home, identity.profileId);
      } catch (error) {
        this.blocked = true;
        this.reasons = ["Manager initialization did not complete. Its local diagnostic record is available."];
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
    this.refreshAvailability();

    if (this.managerInstall === "manager" && this.cli && !this.blocked && !this.unmanaged.has(identity.profileId)) {
      try {
        await this.startSpace(identity.profileId, silentJobContext());
      } catch (error) {
        this.blocked = true;
        const detail = (error instanceof Error && error.message
          ? error.message
          : "The manager process could not be started.").slice(0, 400);
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
      this.blocked = true;
      this.reasons = [
        error instanceof WorkbenchPublicError ? error.message : WORKBENCH_ERROR["workbench/incompatible"],
      ];
      return;
    }
    mkdirSync(this.controlDir, { recursive: true });
    const toolRoot = this.options.controlToolRoot ?? join(this.controlDir, "toolchain");
    setToolchainRoot(toolRoot);
    setManagedCliPrefix(this.options.controlToolRoot ?? join(this.controlDir, "cli"));
    setManagedNodeExecutable(this.nodeExe);
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
    this.bearer = randomBytes(32).toString("hex");
    const path = join(this.controlDir, HOST_BEARER_FILE);
    atomicWrite(path, `${this.bearer}\n`);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows may ignore mode; the file is still local to this Home. */
    }
  }

  private writeEndpointFile(): void {
    if (!this.origin || !this.bearer) return;
    mkdirSync(this.controlDir, { recursive: true });
    let origin = this.origin;
    try {
      origin = parseControlEndpoint(this.origin);
    } catch {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor origin is not a valid loopback endpoint.");
    }
    if (this.handle?.owner.endpoint && this.handle.owner.endpoint !== origin) {
      throw new WorkbenchPublicError("workbench/unavailable", "The owner endpoint origin does not match this supervisor.");
    }
    const epoch = this.currentServiceEpoch();
    if (!epoch) return;
    atomicWrite(
      join(this.controlDir, ENDPOINT_FILE),
      `${JSON.stringify({
        version: 2,
        protocolVersion: WORKBENCH_PROTOCOL_VERSION,
        homeId: digestHomeIdentity(this.home),
        serviceEpoch: epoch,
        origin,
        bearer: this.bearer,
      })}\n`,
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
      // Clone the shipped preset directly into the dedicated manager. Reading
      // the shipped web profile through the CLI would materialize user defaults.
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
    assertOwnedProfilePath(this.home, dest);
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
          ...writeSpaceLlmLaunchSnapshot(this.home, profile),
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
      // Managed profiles are already prepared independently. Even dump-config
      // can materialize files in the user's default web profile.
      prepareHome: injected.prepareHome ?? (async () => undefined),
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

  private workbenchLogStore: WorkbenchLog | null = null;
  private lastDispatchLog = "";

  private workbenchLog(): WorkbenchLog {
    this.workbenchLogStore ??= new WorkbenchLog(this.home, () => this.now());
    return this.workbenchLogStore;
  }

  private rememberDispatchFailure(method: string, payload: unknown, error: unknown): void {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    const raw = error instanceof Error ? error.message : "The workbench request failed.";
    const message = redactPublicReason(sanitizeLogText(raw)) || "The workbench request failed.";
    const event = dispatchEventName(method, payload);
    const signature = `${event}\n${code}\n${message}`;
    if (signature === this.lastDispatchLog) return;
    try {
      this.workbenchLog().append({
        level: "error",
        area: "http",
        event,
        message,
        ...(/^(?:workbench|spaces)\/[a-z0-9-]+$|^LLM_[A-Z0-9_]+$/.test(code) ? { code } : {}),
      });
      this.lastDispatchLog = signature;
    } catch {
      if (!this.reasons.includes("The workbench log could not be written.")) {
        this.reasons.push("The workbench log could not be written.");
      }
    }
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
      source: () => this.readHomeSettings().packageSource,
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
    const diagnostics = this.ensureDiagnostics();
    const ports = this.maintenancePorts(snapshots, runtimes, upgrades, diagnostics);
    const toolsRoot = this.toolsRootOutsideHome();
    const handoff = this.componentHandoffCallback();
    this.packageUpgrade = new WorkbenchPackageUpgrade({
      home: this.home, managerId: () => this.managerId,
      pluginArtifact: this.options.pluginArtifact, viewBridgeArtifact: this.options.viewBridgeArtifact,
      snapshots, upgrades, currentRuntime: () => this.currentRuntime(),
      stopAll: () => this.stopOwnedAll(), reinitializeManager: () => this.reinitializeManager(),
      pluginAdd: this.options.pluginAdd,
      execPath: this.nodeExe,
      ...(toolsRoot ? { toolsRoot } : {}),
      ...(handoff ? { handoff } : {}),
    });
    ports.packageUpgrade = this.packageUpgrade;
    const create = this.options.createMaintenance ?? ((next) => new WorkbenchMaintenanceService(next, {
      packageSource: () => this.readHomeSettings().packageSource,
      log: (operation, error) => {
        const detail = sanitizeLogText(error instanceof Error ? error.message : String(error ?? ""));
        try {
          this.workbenchLog().append({
            level: "error",
            area: "maintenance",
            event: operation.replace(/[^A-Za-z0-9._:-]/g, "-").replace(/^-+/, "").slice(0, 80) || "maintenance",
            message: detail || "The maintenance operation failed.",
          });
        } catch {
          this.maintenanceBlocked = true;
          if (!this.reasons.includes("Maintenance diagnostics could not be saved. Further changes are blocked.")) {
            this.reasons.push("Maintenance diagnostics could not be saved. Further changes are blocked.");
          }
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
      observation: () => this.productObservation(),
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
      [VIEW_ENV.epoch]: view?.serviceEpoch ?? this.currentServiceEpoch(),
    };
  }

  private async runCommand(command: WorkbenchCommand, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void> {
    if (this.sealing) {
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
      case "llm.apply":
        return this.runLlmApply(command, ctx);
      default:
        if (isWorkbenchProductCommand(command)) return this.runProductCommand(command, ctx);
        throw new WorkbenchPublicError("workbench/unsupported");
    }
  }

  private async createSpace(
    input: { name: string; displayName?: string; icon?: string; useSharedLlm?: boolean },
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
    if (input.useSharedLlm === true) {
      ctx.phase("llm-policy");
      await this.llmHost.dispatch({
        method: "updateSpacePolicy",
        spaceId: name,
        shared: { mode: "all" },
        expectedRevision: 0,
      });
      await this.installLlmBridgeIfExplicit(name);
    }
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
    const epoch = this.requireServiceEpoch();
    this.views.set(id, {
      spaceId: id,
      generation: gen,
      origin: this.origin,
      channel,
      serviceEpoch: epoch,
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
    this.llmApplied.set(id, await this.llmHost.catalogRevision());
    return {
      spaceId: id,
      view: {
        serviceEpoch: epoch,
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
      if (!stored.plan.serviceEpoch || stored.plan.serviceEpoch !== this.currentServiceEpoch()) {
        throw new WorkbenchPublicError("workbench/conflict", "The preview belongs to another service epoch.");
      }
      if (!stored.plan.stateRevision || stored.plan.stateRevision !== this.stateRevision()) {
        throw new WorkbenchPublicError("workbench/conflict", "The target changed. Request a new preview.");
      }
      const fingerprint = this.fingerprint(stored.request);
      if (fingerprint !== stored.fingerprint) {
        throw new WorkbenchPublicError("workbench/conflict", "The target changed. Request a new preview.");
      }
      this.consumeLifecyclePlan(planId);
      if (stored.request.kind === "service.shutdown") {
        if (!this.activeJobId) throw new WorkbenchPublicError("workbench/invalid-input", "Shutdown requires an active job.");
        this.relinquishKind = stored.request.kind;
        this.relinquishJobId = this.activeJobId;
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
      case "service.shutdown": {
        ctx.phase("stopping-children");
        this.sealing = true;
        try {
          await this.stopOwnedAll();
        } catch (error) {
          this.sealing = false;
          this.relinquishKind = null;
          this.relinquishJobId = null;
          this.maintenanceBlocked = true;
          throw error;
        }
        ctx.phase("finalizing");
        this.relinquishKind = "service.shutdown";
        return;
      }
      default:
        throw new WorkbenchPublicError("workbench/invalid-input");
    }
  }

  private async resumeRecovery(_ctx: WorkbenchJobContext): Promise<void> {
    throw new WorkbenchPublicError("workbench/unsupported");
  }

  private async settleProvedRecoveryJobs(_outcome: WorkbenchRecoveryOutcome): Promise<void> {
    return;
  }

  private async finishRelinquish(): Promise<void> {
    const kind = this.relinquishKind;
    if (!kind) return;
    this.relinquishKind = null;
    this.relinquishJobId = null;
    this.dropWritable();
    if (kind === "service.shutdown") {
      this.sealing = true;
      this.closed = true;
      await this.httpClose?.();
      await this.options.onNormalExit?.();
    }
  }

  private async afterPlanJobSettled(jobId: string): Promise<void> {
    const pending = this.pendingHandoff;
    if (pending && pending.jobId === jobId) {
      if (this.jobPersistedSuccess(jobId)) {
        try {
          await this.finalizeComponentHandoff(pending);
        } catch (error) {
          this.recordHandoffDiagnostic(error);
        }
        return;
      }
      this.pendingHandoff = undefined;
      this.recordHandoffDiagnostic("Handoff was not transferred because the job did not persist success.");
      return;
    }
    if (this.relinquishKind && this.relinquishJobId === jobId) {
      if (!this.jobPersistedSuccess(jobId)) {
        this.relinquishKind = null;
        this.relinquishJobId = null;
        this.maintenanceBlocked = true;
        this.blocked = true;
        this.reasons.push("Shutdown completion could not be saved. Run rights were kept.");
        return;
      }
      await this.finishRelinquish();
    }
  }

  /**
   * Package-upgrade handoff port. Confirms owned children are stopped, seals
   * further mutations, and records an in-memory pending transfer. Does not wait
   * for this job's tail.
   */
  async handoffWorkbenchPackage(input: WorkbenchPackageHandoffInput, ctx: WorkbenchJobContext): Promise<void> {
    if (this.ownedChildStillRunning()) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        "Owned processes are still running. The component handoff was not started.",
      );
    }
    const jobId = this.activeJobId;
    if (!jobId) {
      throw new WorkbenchPublicError("workbench/unavailable", "Component handoff requires the running upgrade job.");
    }
    const artifacts = await this.artifactsForPayload(input.payload);
    this.sealing = true;
    this.pendingHandoff = {
      jobId,
      planId: input.planId,
      snapshotId: input.snapshotId,
      payload: input.payload,
      ...artifacts,
    };
    ctx.phase("handoff-pending");
    ctx.message("Handoff preparation is complete. New service startup is unconfirmed.");
    ctx.result({ snapshotId: input.snapshotId });
  }

  private toolsRootOutsideHome(): string | undefined {
    const toolsRoot = this.options.controlToolRoot;
    if (typeof toolsRoot !== "string" || !toolsRoot.trim()) return undefined;
    const resolved = resolve(toolsRoot.trim());
    if (pathInsideHome(this.home, resolved)) return undefined;
    return resolved;
  }

  private componentHandoffCallback(): WorkbenchPackageHandoff | undefined {
    if (typeof this.options.onNormalExit !== "function" || !this.selectedPayload) return undefined;
    if (!this.toolsRootOutsideHome()) return undefined;
    return (input, ctx) => this.handoffWorkbenchPackage(input, ctx);
  }

  private componentHandoffPort(): { toolsRoot: string; handoff: WorkbenchPackageHandoff } | undefined {
    const toolsRoot = this.toolsRootOutsideHome();
    const handoff = this.componentHandoffCallback();
    if (!toolsRoot || !handoff) return undefined;
    return { toolsRoot, handoff };
  }

  private jobPersistedSuccess(jobId: string): boolean {
    if (!this.jobs) return false;
    try {
      if (this.jobs.job(jobId).status !== "succeeded") return false;
    } catch {
      return false;
    }
    try {
      const raw = readFileSync(join(this.controlDir, WORKBENCH_JOBS_DIR_NAME, `${jobId}.json`), "utf8");
      const parsed = JSON.parse(raw) as { status?: string };
      return parsed.status === "succeeded";
    } catch {
      return false;
    }
  }

  private ownedChildStillRunning(): boolean {
    const ids = new Set([...this.ownedSpaceIds(), ...this.spawned.keys()]);
    for (const id of ids) {
      const spawned = this.spawned.get(id);
      if (spawned) {
        const liveness = this.pidAlive(spawned.pid, spawned.startedAt);
        if (liveness === "alive" || liveness === "ambiguous") return true;
      }
      const status = this.statusOf(id);
      if (status === "running" || status === "starting") return true;
    }
    return false;
  }

  private async finalizeComponentHandoff(pending: PendingComponentHandoff): Promise<void> {
    this.pendingHandoff = undefined;
    if (this.ownedChildStillRunning()) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        "Owned processes are still running. The component handoff was not transferred.",
      );
    }
    const owner = this.handle;
    if (!owner) {
      throw new WorkbenchPublicError("workbench/unavailable", "Run rights are not held for the component handoff.");
    }
    const toolsRoot = this.componentHandoffPort()?.toolsRoot ?? this.options.controlToolRoot;
    if (!toolsRoot) {
      throw new WorkbenchPublicError("workbench/unavailable", "A tools root outside Home is required for handoff.");
    }
    const targetDiagnosticFile = beginLaunchDiagnostics(this.home, resolve(toolsRoot));
    const port = Number(new URL(this.origin).port);
    if (!Number.isInteger(port) || port < 1) {
      throw new WorkbenchPublicError("workbench/invalid-input", "Handoff requires the preserved nonzero management port.");
    }

    await this.httpClose?.();
    this.httpClose = undefined;
    this.removeEndpointFile();

    const oldPayload = this.selectedPayload;
    if (!oldPayload) {
      throw new WorkbenchPublicError("workbench/unavailable", "The running component group is not validated.");
    }
    const launcherEntry = resolveLauncherEntry(oldPayload);
    const spawnFn = this.options.spawnLauncher ?? spawnComponentLauncher;
    let launcher;
    try {
      launcher = spawnFn({
        home: this.home,
        launcherEntry,
        execPath: this.nodeExe,
        allowRealHome: this.options.allowRealHome,
      });
    } catch (error) {
      this.recordHandoffDiagnostic(error);
      throw error;
    }

    let token;
    try {
      token = await this.controller.transferToLauncher({
        nonce: owner.owner.nonce,
        binding: createComponentHandoffBinding(
          this.home,
          owner.owner.nonce,
          pending.payload.digest,
          undefined,
          { allowRealHome: this.options.allowRealHome },
        ),
        launcher: { pid: launcher.pid, startedAt: launcher.startedAt },
      });
    } catch (error) {
      try {
        launcher.disconnect();
      } catch {
        /* ignore */
      }
      this.recordHandoffDiagnostic(error);
      throw error;
    }
    this.transferredOwner = true;

    const newEntry = payloadRel(pending.payload.packageRoot, COMPONENT_PAYLOAD_ENTRIES.supervisor);
    const newWorker = payloadRel(pending.payload.packageRoot, COMPONENT_PAYLOAD_ENTRIES["installation-worker"]);
    const argv = supervisorCliArgs({
      home: this.home,
      bin: this.options.bin,
      nodeExe: this.nodeExe,
      port,
      allowRealHome: this.options.allowRealHome,
      controlToolRoot: resolve(toolsRoot),
      snapshotRoot: this.options.snapshotRoot,
      pluginArtifact: pending.pluginArtifact,
      viewBridgeArtifact: pending.viewBridgeArtifact,
      llmBridgeArtifact: pending.llmBridgeArtifact,
      snapshotWorkerFile: newWorker,
      componentPayloadRoot: pending.payload.payloadRootLib,
      acceptHandoff: true,
    });
    const commit: ComponentHandoffCommit = {
      token,
      home: this.home,
      toolsRoot: resolve(toolsRoot),
      artifactDigest: pending.payload.digest,
      oldPid: process.pid,
      oldStartedAt: owner.owner.startedAt,
      cleanStopConfirmed: true,
      runtime: {
        execPath: this.nodeExe,
        entry: newEntry,
        argv,
        cwd: dirname(newEntry),
        env: { ...process.env, DSH_SPACES_SUPERVISOR_DIAGNOSTICS: targetDiagnosticFile },
      },
      ...(this.options.allowRealHome ? { allowRealHome: true } : {}),
    };
    try {
      await launcher.sendCommit(commit);
    } catch (error) {
      this.recordHandoffDiagnostic(error);
      throw error;
    }
    launcher.disconnect();
    this.closed = true;
    this.handle = undefined;
    if (this.options.onNormalExit) await this.options.onNormalExit();
  }

  private async artifactsForPayload(
    payload: ValidatedComponentPayload,
  ): Promise<{ pluginArtifact: string; viewBridgeArtifact: string; llmBridgeArtifact?: string }> {
    const live = validateComponentPayload(payload.payloadRootLib);
    const toolsRoot = this.options.controlToolRoot;
    if (typeof toolsRoot !== "string" || !toolsRoot.trim() || pathInsideHome(this.home, resolve(toolsRoot))) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        "Selected component artifacts require a tools root outside Home.",
      );
    }
    const packed = await packLocalArtifacts({
      pluginPackageRoot: live.packageRoot,
      viewBridgeRoot: join(live.payloadRootLib, "view-bridge"),
      llmBridgeRoot: join(live.payloadRootLib, "llm-bridge"),
      artifactDir: join(resolve(toolsRoot), "artifacts"),
      home: this.home,
      execPath: this.nodeExe,
    });
    if ("reasons" in packed) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        packed.reasons[0] ?? "Selected component artifacts could not be packed.",
      );
    }
    if (!packed.pluginArtifact || !packed.viewBridgeArtifact) {
      throw new WorkbenchPublicError("workbench/unavailable", "Selected component artifacts could not be packed.");
    }
    return {
      pluginArtifact: packed.pluginArtifact,
      viewBridgeArtifact: packed.viewBridgeArtifact,
      ...(packed.llmBridgeArtifact ? { llmBridgeArtifact: packed.llmBridgeArtifact } : {}),
    };
  }

  private recordHandoffDiagnostic(error: unknown): void {
    const message = sanitizeLogText(
      error instanceof Error ? error.message : typeof error === "string" ? error : "Component handoff failed.",
    ).slice(0, 400);
    if (!this.reasons.includes(message)) this.reasons.push(message);
    this.blocked = true;
  }

  private assertAcceptedStartupReady(): void {
    if (this.maintenanceBlocked) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        "Accepted startup could not stop owned processes. Run rights were kept.",
      );
    }
    const managerId = this.managerId;
    if (!managerId || this.managerInstall !== "manager" || this.unmanaged.has(managerId)) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        "Accepted startup did not start the manager. Run rights were kept.",
      );
    }
    if (this.statusOf(managerId) !== "running") {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        "Accepted startup did not start the manager. Run rights were kept.",
      );
    }
    const epoch = this.currentServiceEpoch();
    const view = this.views.get(managerId);
    if (!epoch || !view || view.serviceEpoch !== epoch || !view.origin || view.origin === this.origin) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        "Accepted startup did not bind a ready manager view. Run rights were kept.",
      );
    }
  }

  private assertAcceptedHandle(handle: HomeControlHandle): void {
    const inspection = this.controller.inspect();
    if (!inspection.held || !("owner" in inspection)) {
      throw new WorkbenchPublicError("workbench/unavailable", "Accepted run rights are not held.");
    }
    if (inspection.owner.pid !== handle.owner.pid || inspection.owner.nonce !== handle.owner.nonce) {
      throw new WorkbenchPublicError("workbench/unavailable", "Accepted run rights do not match the current owner.");
    }
    let origin: string;
    try {
      origin = parseControlEndpoint(this.origin);
    } catch {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor origin is not a valid loopback endpoint.");
    }
    if (handle.owner.endpoint && parseControlEndpoint(handle.owner.endpoint) !== origin) {
      throw new WorkbenchPublicError("workbench/unavailable", "The owner endpoint origin does not match this supervisor.");
    }
    if (inspection.owner.endpoint && parseControlEndpoint(inspection.owner.endpoint) !== origin) {
      throw new WorkbenchPublicError("workbench/unavailable", "The owner endpoint origin does not match this supervisor.");
    }
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
    if (!this.transferredOwner) {
      this.handle?.release(() => this.removeEndpointFile());
    }
    this.handle = undefined;
    this.jobs = undefined;
    this.processes = undefined;
    this.spaces = undefined;
    this.maintenance = null;
    this.products = null;
    this.packageUpgrade = undefined;
  }

  private previewLocal(request: WorkbenchPlanRequest): WorkbenchPlan {
    const id = "spaceId" in request ? this.requireSpace(request.spaceId) : "";
    if (request.kind === "space.stop" || request.kind === "space.restart" || request.kind === "space.delete") {
      this.requireManaged(id);
      this.protectSpecial(id, { allowManager: request.kind !== "space.delete" });
      if (request.kind === "space.delete") this.protectSpecial(id, { allowManager: false });
    }
    const running = id && this.statusOf(id) === "running" ? [id] : [];
    const observed = this.productObservation();
    const plan: WorkbenchPlan = {
      id: randomUUID(),
      kind: request.kind,
      title: request.kind,
      scope: request.kind === "service.shutdown" ? "controller" : "space",
      affectedSpaceIds: id ? [id] : this.ownedSpaceIds(),
      runningSpaceIds: request.kind === "service.shutdown"
        ? this.ownedSpaceIds().filter((name) => this.statusOf(name) === "running")
        : running,
      changes: request.kind === "space.delete" ? [
        "Remove this space's profile and installed plugins.",
        request.removeData ? "Delete this space's isolated sessions and storage." : "Keep this space's isolated sessions and storage on disk.",
      ] : [request.kind],
      destructive: request.kind === "space.delete" || request.kind === "service.shutdown",
      expiresAt: new Date(this.now().getTime() + PLAN_TTL_MS).toISOString(),
      serviceEpoch: observed.serviceEpoch,
      stateRevision: observed.expectedRevision,
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
    if (spaceId === "web") throw new WorkbenchPublicError("workbench/protected");
    const cliBlock = this.cli ? unmetDshPeers(this.cli.version, dshPeerRangesFromProfile(join(this.home, "profiles", spaceId))) : [];
    if (cliBlock.length && this.cli) {
      throw new WorkbenchPublicError("workbench/incompatible", cliLoadError(this.cli.version, cliBlock));
    }
    if (this.options.componentPayloadRoot) {
      if (!["stopped", "crashed"].includes(this.statusOf(spaceId))) throw new WorkbenchPublicError("workbench/conflict");
      await this.lock.run("space.alpha-migrate", () => migrateProfileToAlpha({
        home: this.home, profileId: spaceId, payloadRoot: this.options.componentPayloadRoot!,
        install: async (bridge) => {
          const artifact = bridge === "view-bridge" ? this.options.viewBridgeArtifact : this.options.llmBridgeArtifact;
          if (!artifact) throw new Error(`The selected ${bridge} archive is unavailable.`);
          const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex").slice(0, 20);
          await this.installArtifact(spaceId, artifact, `dsh-spaces-${bridge}-${digest}`);
        },
        dump: async () => {
          const dump = await this.readDump(spaceId);
          if (!dump) throw new Error("Could not inspect profile configuration before migrating legacy settings.");
          return dump;
        },
      }));
    } else if (existsSync(join(this.home, "hub", spaceId, "settings.yaml"))) {
      await this.lock.run("space.settings-migrate", async () => {
        const dump = await this.readDump(spaceId);
        if (!dump) throw new Error("Could not inspect profile configuration before migrating legacy settings.");
        migrateLegacyProfileSettings(this.home, spaceId, dump);
      });
    }
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
    if (this.maintenanceBlocked) {
      throw new WorkbenchPublicError("workbench/unavailable", "Stop failed; new maintenance is refused.");
    }
    if (this.sealing && !this.relinquishKind) throw new WorkbenchPublicError("workbench/unavailable");
  }

  private assertLlmWritable(): void {
    if (!this.handle) {
      throw new LlmConfigError(LLM_ERROR.WRITE_OWNER_REQUIRED, "Home write owner is required for this change");
    }
    if (this.maintenanceBlocked) {
      throw new WorkbenchPublicError("workbench/unavailable", "Stop failed; new maintenance is refused.");
    }
    if (this.sealing && !this.relinquishKind) throw new WorkbenchPublicError("workbench/unavailable");
  }

  private async submitLlmApply(command: LlmApplyCommand, requestId: string): Promise<WorkbenchJob> {
    this.assertLlmMutationAllowed();
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    return this.jobs.submit(command, requestId, (ctx) =>
      this.observeChildWork(() => this.runLlmApply(command, ctx)),
    );
  }

  private async runLlmApply(command: LlmApplyCommand, ctx: WorkbenchJobContext): Promise<void> {
    this.assertLlmMutationAllowed();
    ctx.phase("apply");
    await this.llmHost.executeApply(command, async (spaceId) => {
      ctx.message(`restart ${spaceId}`);
      const id = this.requireManaged(spaceId);
      await this.stopOwned(id);
      await this.startSpace(id, ctx);
    });
  }

  private listLlmInstances(): LlmInstanceRecord[] {
    return this.homeProfileNames().map((id) => {
      const leftover = this.unmanaged.has(id);
      const status = leftover ? "unknown" : this.publicStatus(id);
      return {
        spaceId: id,
        status,
        generation: this.generations.get(id) ?? 0,
        catalogRevision: this.llmApplied.get(id) ?? null,
        policyRevision: null,
        busy: this.llmBusy.has(id),
        serviceEpoch: this.currentServiceEpoch(),
      };
    });
  }

  private role(): WorkbenchState["role"] {
    if (!this.managerId) return "uninitialized";
    if (this.managerInstall === "manager") return "manager";
    if (this.managerInstall === "ordinary") return "workspace";
    return "uninitialized";
  }

  private currentServiceEpoch(): string {
    const nonce = this.handle?.owner.nonce ?? this.peekOwnerNonce();
    if (!nonce) return "";
    return deriveServiceEpoch(nonce);
  }

  private peekOwnerNonce(): string | undefined {
    const inspection = this.controller.inspect();
    if (inspection.held && "owner" in inspection) return inspection.owner.nonce;
    return undefined;
  }

  private requireServiceEpoch(): string {
    const epoch = this.currentServiceEpoch();
    if (!epoch) throw new WorkbenchPublicError("workbench/unavailable");
    return epoch;
  }

  private stateRevision(spaces: WorkbenchSpace[] = this.listSpaces()): string {
    return computeWorkbenchRevision({ spaces, settings: this.readHomeSettings() });
  }

  private readHomeSettings(): WorkbenchHomeSettings {
    if (this.homeSettings) return this.homeSettings;
    const raw = readSettings(this.home);
    this.homeSettings = {
      portStart: raw.portStart,
      portEnd: raw.portEnd,
      packageSource: raw.packageSource,
      catalogUrl: raw.catalogUrl,
    };
    return this.homeSettings;
  }

  private availability(): WorkbenchState["availability"] {
    if (!this.handle || this.closed || this.sealing) return "unavailable";
    if (this.blocked || this.maintenanceBlocked || this.unmanaged.size > 0 || !this.cli) return "limited";
    if (this.managerId && this.managerInstall !== "manager") return "limited";
    if (this.derivedRecoveryReasons.size > 0) return "limited";
    return "ready";
  }

  private productObservation() {
    return { serviceEpoch: this.requireServiceEpoch(), expectedRevision: this.stateRevision() };
  }

  private assertLiveContext(context: WorkbenchMutationContext): void {
    try {
      assertMutationContext(context, {
        serviceEpoch: this.requireServiceEpoch(),
        revision: this.stateRevision(),
      });
    } catch (error) {
      if (error instanceof WorkbenchProtocolConflictError) {
        throw new WorkbenchPublicError("workbench/conflict", error.message);
      }
      if (error instanceof WorkbenchProtocolInputError) {
        throw new WorkbenchPublicError("workbench/invalid-input", error.message);
      }
      throw error;
    }
  }

  private bindProductService(): void {
    this.homeSettings = this.readHomeSettings();
    this.products = new WorkbenchProductService({
      home: this.home,
      observation: () => this.productObservation(),
      managerId: () => this.managerId,
      listSpaces: () => this.listSpaces(),
      createSpace: (input, ctx) => this.createSpace(input, ctx),
      installPlugin: async (spaceId, spec) => {
        const add = this.options.pluginAdd ?? pluginAdd;
        await add(this.home, spaceId, spec);
      },
      llm: (request) => this.dispatchLlmAdmitted(request),
      llmAdmitted: (request) => this.dispatchLlmAdmitted(request),
      llmBridgeAvailable: () => Boolean(this.options.llmBridgeArtifact),
      dshVersion: () => this.cli?.version ?? null,
      spacesVersion: () => {
        const version = this.selectedPayload?.manifest.version;
        return typeof version === "string" && version.length > 0 ? version : null;
      },
      runtimeBin: () => this.cli?.bin ?? this.options.bin,
      inspectRuntime: (options) => inspectBlueprintRuntime(options),
      composeRuntime: (options, input) => composeBlueprintRuntime(options, input),
      resolveModule: (options, input) => resolveBlueprintModule(options, input),
      llmCatalogObservation: () => this.llmCatalogObservation(),
      diagnostics: (spaceId) => this.productDiagnostics(spaceId),
      workbenchLog: () => this.workbenchLog(),
      withWrite: (label, action) => this.lock.run(label, action),
      settingsChanged: (settings) => {
        this.homeSettings = {
          portStart: settings.portStart,
          portEnd: settings.portEnd,
          packageSource: settings.packageSource,
          catalogUrl: settings.catalogUrl,
        };
        setPackageSource(settings.packageSource);
        this.processes?.setPortRange(settings.portStart, settings.portEnd);
      },
      now: this.now,
      prepareWorkbench: async (input, ctx) => {
        if (!this.packageUpgrade) {
          throw new WorkbenchPublicError("workbench/unavailable", "Workbench update preparation is unavailable.");
        }
        setPackageSource(this.readHomeSettings().packageSource);
        return this.packageUpgrade.prepare({ version: input.version }, ctx);
      },
    });
  }

  private ensureDiagnostics(): DiagnosticsService {
    this.diagnostics ??= new DiagnosticsService({
      home: this.home,
      profiles: () => this.registry.scan(),
      statusOf: (name) => this.statusOf(name),
      stop: (name) => this.stopOwned(name),
      isMaintenance: () => this.maintenanceFlag,
    });
    return this.diagnostics;
  }

  private productDiagnostics(spaceId: string): WorkbenchDiagnostics {
    const id = this.requireSpace(spaceId);
    const snap = this.ensureDiagnostics().get(id);
    return {
      spaceId: id,
      status: this.publicStatus(id),
      lastError: snap.lastError,
      logs: snap.logs.slice(0, 256),
      logError: snap.logError,
      backups: snap.backups,
    };
  }

  private async runProductCommand(
    command: WorkbenchProductCommand,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchJob["result"]> {
    if (!this.products) throw new WorkbenchPublicError("workbench/unavailable");
    if (command.kind === "plugin.download") setPackageSource(this.readHomeSettings().packageSource);
    const outcome = await this.products.execute(command, ctx);
    const result = { product: outcome };
    ctx.result(result);
    return result;
  }

  private readOwner(): WorkbenchState["owner"] {
    const inspection = this.controller.inspect();
    if (!inspection.held || !("owner" in inspection)) return null;
    return { kind: inspection.owner.kind, since: inspection.owner.startedAt };
  }

  /** Public `state()` passes false so a first-boot poll cannot latch a transient extra. */
  private refreshAvailability(latchBlock = true): void {
    const extra: string[] = [];
    if (!this.jobs?.list().some(job => job.status === "running")) {
      if (this.maintenanceFlag || this.hasMaintenanceEvidence() || this.lock.inspect().held) extra.push("Unfinished Home maintenance journal is present.");
    }

    if (!this.cli) extra.push(WORKBENCH_ERROR["workbench/incompatible"]);
    if (this.managerId && this.managerInstall !== "manager") {
      extra.push("The manager profile cannot be used.");
    }
    if (this.unmanaged.size) extra.push("Leftover processes were not adopted.");
    if (this.maintenanceBlocked) extra.push("Owned processes could not be stopped. Run rights were kept.");
    this.reasons = [...new Set([
      ...this.reasons.filter(reason => !this.derivedRecoveryReasons.has(reason)),
      ...extra,
    ])];
    this.derivedRecoveryReasons = new Set(extra);
    if (latchBlock && extra.length > 0) this.blocked = true;
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
      return ["A previous controller is dead. Run rights were not taken."];
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
      if (!parsed.plan.serviceEpoch || !parsed.plan.stateRevision) return undefined;
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async ensureViewBridge(profileId: string): Promise<void> {
    if (!this.options.viewBridgeArtifact) return;
    if (profileId === this.managerId) return;
    if (profileHasViewBridge(this.home, profileId)) return;
    await this.installArtifact(profileId, this.options.viewBridgeArtifact, VIEW_BRIDGE_ID);
  }

  private async installLlmBridgeIfExplicit(profileId: string): Promise<void> {
    if (!this.options.llmBridgeArtifact) return;
    if (profileId === "web" || profileId === this.managerId) return;
    if (profileHasLlmBridge(this.home, profileId)) return;
    await this.installArtifact(profileId, this.options.llmBridgeArtifact, "dsh-spaces-llm-bridge");
  }
}

/**
 * Cold-start binding for `--component-payload`. Library callers that omit the
 * root stay unchanged. A present root is v2-validated and fail-closed: worker
 * and supervisor assets come from that group, and packed view/llm artifacts
 * must be real files already supplied by bootstrap.
 */
export function bindSupervisorComponentPayload(options: WorkbenchSupervisorOptions): WorkbenchSupervisorOptions {
  const root = options.componentPayloadRoot;
  if (root === undefined) return options;
  if (typeof root !== "string" || !root.trim()) {
    throw new WorkbenchPublicError("workbench/invalid-input", "--component-payload must be a filesystem path.");
  }
  let selected: ValidatedComponentPayload;
  try {
    selected = validateComponentPayload(root);
  } catch (error) {
    const detail = error instanceof ComponentPayloadError || error instanceof Error
      ? error.message
      : "Component payload is invalid.";
    throw new WorkbenchPublicError("workbench/invalid-input", detail);
  }
  options.componentPayloadRoot = selected.payloadRootLib;
  const worker = payloadRel(selected.packageRoot, COMPONENT_PAYLOAD_ENTRIES["installation-worker"]);
  const supervisorDir = payloadRel(selected.packageRoot, "lib/supervisor");
  const viewEntry = payloadRel(selected.packageRoot, COMPONENT_PAYLOAD_ENTRIES["view-bridge"]);
  const llmEntry = payloadRel(selected.packageRoot, COMPONENT_PAYLOAD_ENTRIES["llm-bridge"]);
  const launcher = payloadRel(selected.packageRoot, "lib/supervisor/launcher.mjs");
  assertRealFile(worker, "Selected snapshot worker");
  assertRealDirectory(supervisorDir, "Selected supervisor assets");
  assertRealFile(launcher, "Selected launcher");
  assertRealFile(viewEntry, "Selected view-bridge");
  assertRealFile(llmEntry, "Selected llm-bridge");

  if (options.snapshotWorkerFile !== undefined && !sameRealPath(options.snapshotWorkerFile, worker)) {
    throw new WorkbenchPublicError(
      "workbench/invalid-input",
      "snapshot-worker is not from the selected component group.",
    );
  }
  options.snapshotWorkerFile = worker;

  if (options.supervisorAssetRoot !== undefined && !sameRealPath(options.supervisorAssetRoot, supervisorDir)) {
    throw new WorkbenchPublicError(
      "workbench/invalid-input",
      "supervisor-asset-root is not from the selected component group.",
    );
  }
  options.supervisorAssetRoot = supervisorDir;

  if (options.viewBridgeArtifact !== undefined) {
    assertRealFile(options.viewBridgeArtifact, "view-bridge-artifact");
  }
  if (options.llmBridgeArtifact !== undefined) {
    assertRealFile(options.llmBridgeArtifact, "llm-bridge-artifact");
  }
  if (options.pluginArtifact !== undefined) {
    assertRealFile(options.pluginArtifact, "plugin-artifact");
  }
  return options;
}

export function assertHandoffTokenMatchesSelectedPayload(
  token: { artifactDigest: string },
  payloadRoot: string,
  runningEntry?: string,
): ValidatedComponentPayload {
  const selected = validateComponentPayload(payloadRoot);
  if (token.artifactDigest !== selected.digest) {
    throw new WorkbenchPublicError(
      "workbench/invalid-input",
      "Handoff token artifactDigest does not match the selected component group.",
    );
  }
  if (runningEntry) {
    const expected = payloadRel(selected.packageRoot, COMPONENT_PAYLOAD_ENTRIES.supervisor);
    if (!sameRealPath(runningEntry, expected)) {
      throw new WorkbenchPublicError(
        "workbench/invalid-input",
        "Supervisor entry is not from the selected component group.",
      );
    }
  }
  return selected;
}

/**
 * Async group preflight: bind the v2 payload, require the plugin/view/llm
 * artifact tuple, and validate tar bytes against the selected manifest.
 * Call before runtime construction, HTTP, or Home writers.
 */
export async function preflightSupervisorComponentPayload(
  options: WorkbenchSupervisorOptions,
): Promise<WorkbenchSupervisorOptions> {
  const resolved: WorkbenchSupervisorOptions = { ...options };
  bindSupervisorComponentPayload(resolved);
  if (resolved.componentPayloadRoot === undefined) return resolved;
  const pluginArtifact = resolved.pluginArtifact;
  const viewBridgeArtifact = resolved.viewBridgeArtifact;
  const llmBridgeArtifact = resolved.llmBridgeArtifact;
  if (!pluginArtifact || !viewBridgeArtifact || !llmBridgeArtifact) {
    throw new WorkbenchPublicError(
      "workbench/invalid-input",
      "A component payload requires plugin, view-bridge, and llm-bridge artifacts from the same group.",
    );
  }
  const payload = validateComponentPayload(resolved.componentPayloadRoot);
  try {
    await validateComponentPayloadArtifacts(payload, {
      pluginArtifact,
      viewBridgeArtifact,
      llmBridgeArtifact,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Component payload artifacts are invalid.";
    throw new WorkbenchPublicError("workbench/invalid-input", detail);
  }
  return resolved;
}

export async function createWorkbenchSupervisor(
  options: WorkbenchSupervisorOptions,
): Promise<WorkbenchSupervisorHandle> {
  const resolved = await preflightSupervisorComponentPayload(options);
  const runtime = new WorkbenchSupervisorRuntime(resolved);
  let port = resolved.port;
  if (resolved.acceptedHandle) {
    if (!Number.isInteger(port) || port! < 1 || port! > 65535) {
      throw new WorkbenchPublicError(
        "workbench/invalid-input",
        "Accepted handoff requires an explicit nonzero --port.",
      );
    }
  } else if (port === undefined) {
    const path = join(resolve(resolved.home), HOME_CONTROL_DIR_NAME, "entry-port.json");
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
    if (resolved.acceptedHandle) {
      await runtime.takeAcceptedOwner(resolved.acceptedHandle);
    } else {
      await runtime.tryOwn();
    }
  } catch (error) {
    if (resolved.acceptedHandle) {
      try {
        await http.close();
      } catch {
        /* owner and selected pointer stay; HTTP must not leak */
      }
      throw error;
    }
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
    if (token === COMPONENT_HANDOFF_FLAG || token === "--accept-handoff") {
      flags.acceptHandoff = "1";
      continue;
    }
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
  if (flags.acceptHandoff === "1") options.acceptHandoff = true;
  if (flags.node) options.nodeExe = requirePath(flags.node, "--node");
  if (flags.port) {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new WorkbenchPublicError("workbench/invalid-input", "Port must be an integer 0-65535.");
    }
    options.port = port;
  }
  if (options.acceptHandoff) {
    if (!Number.isInteger(options.port) || options.port! < 1 || options.port! > 65535) {
      throw new WorkbenchPublicError(
        "workbench/invalid-input",
        "--accept-handoff requires an explicit nonzero --port.",
      );
    }
  }
  if (flags["control-tool-root"]) options.controlToolRoot = requirePath(flags["control-tool-root"], "--control-tool-root");
  if (flags["supervisor-asset-root"]) {
    options.supervisorAssetRoot = requirePath(flags["supervisor-asset-root"], "--supervisor-asset-root");
  }
  if (flags["plugin-artifact"]) options.pluginArtifact = requirePath(flags["plugin-artifact"], "--plugin-artifact");
  if (flags["view-bridge-artifact"]) {
    options.viewBridgeArtifact = requirePath(flags["view-bridge-artifact"], "--view-bridge-artifact");
  }
  if (flags["llm-bridge-artifact"]) {
    options.llmBridgeArtifact = requirePath(flags["llm-bridge-artifact"], "--llm-bridge-artifact");
  }
  if (flags["snapshot-worker"]) options.snapshotWorkerFile = requirePath(flags["snapshot-worker"], "--snapshot-worker");
  if (flags["snapshot-root"]) options.snapshotRoot = requirePath(flags["snapshot-root"], "--snapshot-root");
  if (flags["component-payload"]) {
    options.componentPayloadRoot = requirePath(flags["component-payload"], "--component-payload");
  }
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
  if (options.llmBridgeArtifact) args.push("--llm-bridge-artifact", options.llmBridgeArtifact);
  if (options.snapshotWorkerFile) args.push("--snapshot-worker", options.snapshotWorkerFile);
  if (options.snapshotRoot) args.push("--snapshot-root", options.snapshotRoot);
  if (options.componentPayloadRoot) args.push("--component-payload", options.componentPayloadRoot);
  if (options.acceptHandoff) args.push(COMPONENT_HANDOFF_FLAG);
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
    "--llm-bridge-artifact": "llm-bridge-artifact",
    "--snapshot-worker": "snapshot-worker",
    "--snapshot-root": "snapshot-root",
    "--component-payload": "component-payload",
  };
  return names[token];
}

function requirePath(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new WorkbenchPublicError("workbench/invalid-input", `${flag} is required.`);
  const resolved = resolve(value);
  if (!isAbsolute(resolved)) throw new WorkbenchPublicError("workbench/invalid-input", `${flag} must be a filesystem path.`);
  return resolved;
}

function payloadRel(packageRoot: string, rel: string): string {
  return join(packageRoot, ...rel.split("/").filter(Boolean));
}

function assertRealFile(path: string, label: string): string {
  const abs = resolve(path);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is missing.`);
  }
  if (st.isSymbolicLink()) {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is a symlink or junction.`);
  }
  if (!st.isFile()) {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is not a regular file.`);
  }
  return abs;
}

function assertRealDirectory(path: string, label: string): string {
  const abs = resolve(path);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is missing.`);
  }
  if (st.isSymbolicLink()) {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is a symlink or junction.`);
  }
  if (!st.isDirectory()) {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is not a directory.`);
  }
  return abs;
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return samePath(realpathSync(resolve(left)), realpathSync(resolve(right)));
  } catch {
    return false;
  }
}

function pathInsideHome(home: string, path: string): boolean {
  const rel = relative(resolve(home), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveLauncherEntry(payload: ValidatedComponentPayload): string {
  const live = validateComponentPayload(payload.payloadRootLib);
  const declared = live.manifest.components.supervisor.files.some((file) => file.path === "lib/supervisor/launcher.mjs");
  if (!declared) {
    throw new WorkbenchPublicError(
      "workbench/invalid-input",
      "Selected component group does not declare lib/supervisor/launcher.mjs.",
    );
  }
  return assertRealFile(payloadRel(live.packageRoot, "lib/supervisor/launcher.mjs"), "Selected launcher");
}

function bindSelectedCli(bin: string): BoundCli {
  const bound = bindDshCli(resolve(bin));
  if (!bound) {
    throw new WorkbenchPublicError("workbench/incompatible", "The selected DSH CLI could not be bound from disk.");
  }
  if (!isCompatibleDshCliVersion(bound.version)) {
    throw new WorkbenchPublicError("workbench/incompatible");
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

function profileHasLlmBridge(home: string, profileId: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(home, "profiles", profileId, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      dsh?: { profile?: { bundles?: unknown } };
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...(Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []),
    ];
    return names.some((name) => typeof name === "string" && /llm-bridge/i.test(name));
  } catch {
    return false;
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
    case "snapshot.restore":
    case "config.restore":
      throw new WorkbenchPublicError("workbench/unsupported");
    case "service.shutdown":
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
    case "snapshot.delete":
      expectKeys(body, ["kind", "snapshotId"]);
      return { kind, snapshotId: parseId(body.snapshotId) };
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
