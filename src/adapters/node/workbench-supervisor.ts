import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SupervisorDashboard, DASHBOARD_LAUNCH_ENV } from "./dashboard/supervisor";
import { atomicWrite } from "./atomic";
import { SpaceMessageRouter } from "./message-bus/router";
import { CooperativeChildren } from "./cooperative-children";
import { observeMaintenanceChild, withChildObservation } from "./owned-process-record";
import { inspectHomeToolchain } from "./control-residue";
import { CoordinatedUpgrade } from "./coordinated-upgrade";
import { DiagnosticsService, sanitizeLogText } from "./diagnostics";
import { WorkbenchLog } from "./workbench-log";
import { setManagedCliPrefix, setManagedNodeExecutable, setSelectedDshResolver } from "./dsh-cli";
import { assertNotRealHome, authorizeProductHome } from "./home-guard";
import { PatchWriter, SESSION_ROW_ID, STORAGE_ROW_ID, extractRoot } from "./patch-writer";
import { archiveAbsPath } from "./plugin-library";
import { pluginAdd } from "./plugin-ops";
import { ProcessManager, type KillKind, type ProcessRuntime } from "./process-manager";
import { writeSpaceLlmLaunchSnapshot } from "./llm-snapshot";
import { ProfileRegistry } from "./profile-registry";
import { describeRuntime, readRuntimeRef } from "./runtime-descriptor";
import { RuntimeStore } from "./runtime-store";
import { assertOwnedProfilePath, migrateLegacyProfileSettings } from "./profile-settings";
import { migrateProfileToAlpha } from "./profile-alpha-migration";
import { cliLoadError, dshPeerRangesFromProfile, unmetDshPeers } from "./component-cli";
import { SnapshotExecutor } from "./snapshot-executor";
import { setPackageSource, setToolchainRoot } from "./toolchain";
import type { ProfileStatus } from "../../shared/types";
import { redactPublicReason } from "../../shared/public-reason";
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
  type SpacesLoaderView,
} from "./spaces-control";
import {
  HOME_CONTROL_DIR_NAME,
  HomeControlBusyError,
  HomeController,
  defaultPidAlive,
  parseControlEndpoint,
  type PidAliveFn,
} from "./home-controller";
import {
  validateComponentPayload,
  type ValidatedComponentPayload,
} from "./component-payload";
import { HomeOperationLock, canonicalHome } from "./home-operation-lock";
import {
  WorkbenchJobStore,
  type WorkbenchJobContext,
} from "./workbench-jobs";
import {
  WorkbenchMaintenance as WorkbenchMaintenanceService,
} from "./workbench-maintenance";
import type { WorkbenchMaintenancePorts } from "./workbench-maintenance-ports";
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
import { GlobalLlmHost } from "../../core/application/global-llm-host";
import type { LlmApiRequest, LlmApiResult } from "../../shared/llm-api";
import { SupervisorDashboardHost } from "./supervisor/dashboard-host";
import { STOP_KEPT_REASON, WORKBENCH_ERROR, WorkbenchPublicError, WRITABLE_STARTUP_FAILED_REASON } from "./supervisor/errors";
import {
  expectKeys,
  expectObject,
  parseIcon,
  parseId,
  parsePlanRequest,
  parseRequestId,
  parseSpaceName,
} from "./supervisor/input";
import { SupervisorInstanceRecords } from "./supervisor/instance-records";
import { SupervisorLifecycle } from "./supervisor/lifecycle";
import { SupervisorLlm } from "./supervisor/llm";
import {
  bindSelectedCli,
  defaultSnapshotWorkerFile,
  preflightSupervisorComponentPayload,
} from "./supervisor/payload";
import {
  inspectManagerInstall,
  profileHasViewBridge,
  publicPluginVersion,
} from "./supervisor/profile-probe";
import { SupervisorPlans } from "./supervisor/plans";
import { SpaceRunRegistry } from "./supervisor/space-runs";
import type {
  BoundCli,
  WorkbenchMaintenance,
  WorkbenchSupervisorHandle,
  WorkbenchSupervisorOptions,
} from "./supervisor/types";

export { WORKBENCH_API_METHODS, expectedAuthCookieName } from "./workbench-http";
export { isCompatibleDshCliVersion };
export { WORKBENCH_ERROR, WorkbenchPublicError };
export type { WorkbenchErrorCode } from "./supervisor/errors";
export type {
  SupervisorCliOptions,
  WorkbenchMaintenance,
  WorkbenchSupervisorHandle,
  WorkbenchSupervisorOptions,
} from "./supervisor/types";
export {
  bindSupervisorComponentPayload,
  preflightSupervisorComponentPayload,
  validateSupervisorComponentPayload,
} from "./supervisor/payload";
export { parseSupervisorArgs, supervisorCliArgs } from "./supervisor/cli-args";

const STOP_NOT_FORCED = "Timed stop did not force-kill the process. The instance is still recorded.";
const ENDPOINT_FILE = "endpoint.json";
const HOST_BEARER_FILE = "host.bearer";
const VIEW_BRIDGE_ID = "dsh-spaces-view-bridge";

const SUPERVISOR_PLAN_KINDS = new Set<WorkbenchPlanRequest["kind"]>([
  "space.stop",
  "space.restart",
  "space.delete",
  "service.shutdown",
  "dashboard.publication.set",
]);
const REMOVED_COMMAND_KINDS = new Set(["controller.acquire", "recovery.resume"]);
const REMOVED_PLAN_KINDS = new Set(["controller.release", "controller.shutdown", "snapshot.restore", "config.restore", "workbench.upgrade"]);

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
  private readonly lifecycle = new SupervisorLifecycle();
  private jobs: WorkbenchJobStore | undefined;
  private processes: ProcessManager | undefined;
  private spaces: NodeSpacesControl | undefined;
  private maintenance: WorkbenchMaintenance | null = null;
  private products: WorkbenchProductService | null = null;
  private dashboard: SupervisorDashboard | null = null;
  private diagnostics: DiagnosticsService | undefined;
  private homeSettings: WorkbenchHomeSettings | undefined;
  private cli: BoundCli | null = null;
  private managerId: string | null = null;
  private managerInstall: "missing" | "manager" | "ordinary" | "damaged" = "missing";
  private readonly messageBus = new SpaceMessageRouter();
  private readonly runs = new SpaceRunRegistry();
  private readonly supervisorPlans: SupervisorPlans;
  private httpClose: (() => Promise<void>) | undefined;
  private runtimeStore: RuntimeStore | undefined;
  private readonly pidAlive: PidAliveFn;
  private selectedPayload: ValidatedComponentPayload | undefined;
  readonly llmHost: GlobalLlmHost;
  private readonly instances: SupervisorInstanceRecords;
  private readonly llmOps: SupervisorLlm;
  private readonly dashboardHost: SupervisorDashboardHost;
  constructor(options: WorkbenchSupervisorOptions, selectedPayload?: ValidatedComponentPayload) {
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
      // Reuse the launch validation when provided; it must belong to this root.
      this.selectedPayload = selectedPayload ?? validateComponentPayload(options.componentPayloadRoot);
    }
    this.supervisorPlans = new SupervisorPlans({
      home: this.home,
      lifecycle: this.lifecycle,
      runs: this.runs,
      instances: () => this.instances,
      lock: this.lock,
      registry: this.registry,
      now: this.now,
      messageBus: this.messageBus,
      options: this.options,
      dashboard: () => this.dashboard,
      dashboardHost: () => this.dashboardHost,
      jobs: () => this.jobs,
      maintenance: () => this.maintenance,
      closeHttp: async () => { await this.httpClose?.(); },
      dropWritable: () => this.dropWritable(),
      requireSpace: (spaceId) => this.requireSpace(spaceId),
      requireManaged: (spaceId) => this.requireManaged(spaceId),
      protectSpecial: (id, options) => this.protectSpecial(id, options),
      statusOf: (id) => this.statusOf(id),
      ownedSpaceIds: () => this.ownedSpaceIds(),
      stopOwned: (spaceId) => this.stopOwned(spaceId),
      stopOwnedAll: () => this.stopOwnedAll(),
      startSpace: (spaceId, ctx) => this.startSpace(spaceId, ctx),
      currentServiceEpoch: () => this.currentServiceEpoch(),
      stateRevision: () => this.stateRevision(),
      productObservation: () => this.productObservation(),
      assertLiveContext: (context) => this.assertLiveContext(context),
    });
    this.instances = new SupervisorInstanceRecords({
      controlDir: this.controlDir,
      runs: this.runs,
      lifecycle: this.lifecycle,
      pidAlive: this.pidAlive,
      plans: this.supervisorPlans.plans,
    });
    this.llmOps = new SupervisorLlm({
      home: this.home,
      llmHost: () => this.llmHost,
      jobs: () => this.jobs,
      lifecycle: this.lifecycle,
      managerId: () => this.managerId,
      llmBridgeArtifact: () => this.options.llmBridgeArtifact,
      runs: this.runs,
      observeChildWork: (action) => this.observeChildWork(action),
      requireManaged: (spaceId) => this.requireManaged(spaceId),
      stopOwned: (spaceId) => this.stopOwned(spaceId),
      startSpace: (spaceId, ctx) => this.startSpace(spaceId, ctx),
      installArtifact: (profileId, artifact, id) => this.installArtifact(profileId, artifact, id),
      homeProfileNames: () => this.homeProfileNames(),
      publicStatus: (id) => this.publicStatus(id),
      currentServiceEpoch: () => this.currentServiceEpoch(),
    });
    this.dashboardHost = new SupervisorDashboardHost({
      home: this.home,
      controller: this.controller,
      lock: this.lock,
      now: this.now,
      origin: () => this.origin,
      dashboard: () => this.dashboard,
      setDashboard: (dashboard) => { this.dashboard = dashboard; },
      lifecycle: this.lifecycle,
      hasMaintenanceEvidence: () => this.hasMaintenanceEvidence(),
      requireServiceEpoch: () => this.requireServiceEpoch(),
      managerOrigin: () => this.managerOrigin(),
      listSpaces: () => this.listSpaces(),
      runs: this.runs,
      cookieName: () => this.cookieName(),
      sessionEquals: (value) => this.sessionEquals(value),
    });
    this.llmHost = createHomeLlmHost(this.home, {
      listSpaceIds: async () => this.homeProfileNames(),
      instances: {
        list: async () => this.llmOps.listLlmInstances(),
        get: async (spaceId) => this.llmOps.listLlmInstances().find((row) => row.spaceId === spaceId),
        markApplied: async (spaceId, catalogRevision) => {
          this.runs.llmApplied.set(spaceId, catalogRevision);
        },
      },
      assertWritable: () => this.llmOps.assertLlmWritable(),
      submitApply: (command, requestId) => this.llmOps.submitLlmApply(command, requestId),
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
    return this.managerId ? this.runs.views.get(this.managerId)?.origin ?? null : null;
  }
  isWorkspaceOrigin(origin: string): boolean {
    return this.runs.workspaceOrigins.has(origin);
  }

  attachHttp(origin: string, close: () => Promise<void>): void {
    this.origin = origin;
    this.httpClose = close;
    this.session = randomBytes(32).toString("hex");
    this.bootstrap.set(randomBytes(24).toString("base64url"), this.now().getTime() + 600_000);
  }

  async handleDashboardRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!req.url?.startsWith("/api/dashboard/") && !req.url?.startsWith("/internal/dashboard/")) return false;
    return this.dashboardHost.handle(req, res);
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
      this.lifecycle.reasons = this.heldReasons(inspection);
      return;
    }
    try {
      this.lifecycle.handle = this.controller.acquire("web", this.origin);
    } catch (error) {
      if (error instanceof HomeControlBusyError) {
        this.lifecycle.reasons = this.heldReasons(error.inspection);
        return;
      }
      this.lifecycle.blocked = true;
      this.lifecycle.reasons = [WRITABLE_STARTUP_FAILED_REASON];
      return;
    }
    this.writeHostBearer();
    this.writeEndpointFile();
    try {
      await this.initWritable();
    } catch {
      this.lifecycle.blocked = true;
      this.lifecycle.reasons = [
        ...this.lifecycle.reasons,
        WRITABLE_STARTUP_FAILED_REASON,
      ];
    }
  }

  async close(): Promise<void> {
    if (this.lifecycle.closed) return;
    this.lifecycle.sealing = true;
    try {
      if (this.jobs) await this.jobs.whenIdle();
      await this.stopOwnedAll();
      this.messageBus.close();
      await this.dashboard?.close();
    } catch (error) {
      this.lifecycle.maintenanceBlocked = true;
      this.lifecycle.blocked = true;
      this.lifecycle.addReason(STOP_KEPT_REASON);
      throw error instanceof Error ? error : new Error(STOP_NOT_FORCED);
    }
    this.dropWritable();
    this.lifecycle.closed = true;
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
      case "backups":
        expectKeys(body, ["spaceId"]);
        return this.backups(parseSpaceName(body.spaceId));
      case "llm":
        return this.llmOps.dispatchLlm(body);
      case "llmCredential":
        return this.llmOps.dispatchLlmCredential(body);
      case "product":
        expectKeys(body, ["request"]);
        return this.product(parseWorkbenchProductRequest(body.request));
    }
  }

  async llm(request: LlmApiRequest): Promise<LlmApiResult> {
    return this.llmOps.dispatchLlm(request) as Promise<LlmApiResult>;
  }

  entryPage(): string {
    const managerId = this.managerId;
    const view = managerId ? this.runs.views.get(managerId) : undefined;
    const running = managerId ? this.statusOf(managerId) === "running" : false;
    const epoch = this.currentServiceEpoch();
    const viewPath =
      running && view
        ? `/view/${encodeURIComponent(view.spaceId)}/${view.generation}${epoch ? `?epoch=${encodeURIComponent(epoch)}` : ""}`
        : null;
    return renderEntryPage({
      managerRunning: running,
      managerViewPath: viewPath,
      maintenance: this.lifecycle.maintenanceFlag,
      writable: Boolean(this.lifecycle.handle),
      reasons: this.lifecycle.reasons,
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
    const view = this.runs.views.get(id);
    const owned = this.processes?.statusOf(id) === "running";
    if (!view || view.generation !== gen || !owned || view.serviceEpoch !== currentEpoch) {
      return { status: 403, message: "View entry is only issued for owned ready children." };
    }
    const launch = this.processes?.urlOf(id);
    if (!launch) return { status: 403, message: "View entry is only issued for owned ready children." };
    const port = this.processes?.portOf(id);
    if (!port || this.runs.unmanaged.has(id)) {
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
    const owner = this.lifecycle.maintenanceFlag && this.lifecycle.handle
      ? { kind: this.lifecycle.handle.owner.kind, since: this.lifecycle.handle.owner.startedAt }
      : this.readOwner();
    const inventory = this.lifecycle.maintenanceFlag ? this.lifecycle.maintenanceInventory : null;
    const spaces = inventory ? inventory.spaces.map(row => ({
      ...row,
      status: this.runs.unmanaged.has(row.id) ? "unknown" as const : this.publicStatus(row.id),
      generation: this.runs.views.get(row.id)?.generation ?? this.runs.generations.get(row.id) ?? row.generation,
      managed: Boolean(this.lifecycle.handle) && !this.runs.unmanaged.has(row.id),
    })) : this.listSpaces();
    return {
      protocolVersion: WORKBENCH_PROTOCOL_VERSION,
      serviceEpoch: this.currentServiceEpoch(),
      revision: this.stateRevision(spaces),
      availability: this.availability(),
      role: this.role(),
      managerId: this.managerId,
      owner,
      writable: Boolean(this.lifecycle.handle),
      mode: inventory?.mode ?? this.spaces?.capabilities().mode ?? "unknown-readonly",
      dshVersion: this.cli?.version ?? null,
      maintenance: this.lifecycle.maintenanceFlag,
      reasons: [...this.lifecycle.reasons],
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
      diagnostics: this.lifecycle.reasons.map((message) => ({ level: "warning" as const, code: "WORKBENCH", message })),
    };
  }

  async submit(command: WorkbenchCommand, requestId: string, context: WorkbenchMutationContext): Promise<WorkbenchJob> {
    const parsedContext = parseMutationContext(context);
    if (REMOVED_COMMAND_KINDS.has((command as { kind?: string }).kind ?? "")) {
      throw new WorkbenchPublicError("workbench/unsupported");
    }
    this.lifecycle.admitSubmission();
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    const parsedCommand = isWorkbenchProductCommand(command) ? parseWorkbenchProductCommand(command) : command;
    const job = await this.jobs.submit(parsedCommand, requestId, (ctx) => {
      this.lifecycle.activeJobId = requestId;
      return this.observeChildWork(async () => {
        try {
          this.assertLiveContext(parsedContext);
          return await this.runCommand(parsedCommand, ctx);
        } finally {
          this.lifecycle.activeJobId = undefined;
        }
      });
    });
    if (parsedCommand.kind === "plan.execute") {
      const jobId = job.id;
      void this.jobs.whenIdle().then(() => this.supervisorPlans.afterPlanJobSettled(jobId));
    }
    return job;
  }

  async job(id: string): Promise<WorkbenchJob> {
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    return this.jobs.job(id);
  }

  async cancel(id: string): Promise<WorkbenchJob> {
    this.lifecycle.assertWritable();
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    return this.jobs.cancel(id);
  }

  async view(spaceId: string): Promise<WorkbenchView> {
    const id = this.requireSpace(spaceId);
    if (this.runs.unmanaged.has(id) || this.statusOf(id) !== "running") {
      throw new WorkbenchPublicError("workbench/not-found");
    }
    const port = this.processes?.portOf(id);
    if (!port) throw new WorkbenchPublicError("workbench/not-found");
    const epoch = this.requireServiceEpoch();
    const current = this.runs.issueView(id, port, epoch);
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
    this.lifecycle.assertWritable();
    this.assertLiveContext(parsedContext);
    if (REMOVED_PLAN_KINDS.has((request as { kind?: string }).kind ?? "")) {
      throw new WorkbenchPublicError("workbench/unsupported");
    }
    const parsed = parsePlanRequest(request);
    if (("spaceId" in parsed && parsed.spaceId === "desktop") ||
      ("spaceIds" in parsed && parsed.spaceIds.includes("desktop"))) {
      throw new WorkbenchPublicError("workbench/protected");
    }
    if (parsed.kind === "dashboard.publication.set") {
      return this.lock.run("dashboard.publication.preview", async () => {
        const dashboard = this.dashboardHost.requireDashboard();
        this.assertLiveContext(parsedContext);
        this.protectSpecial(this.requireManaged(parsed.spaceId), { allowManager: false });
        if (this.runs.unmanaged.has(parsed.spaceId)) throw new WorkbenchPublicError("workbench/unmanaged");
        await dashboard.validatePreview(parsed);
        this.assertLiveContext(parsedContext);
        return this.supervisorPlans.previewLocal(parsed);
      });
    }
    if (SUPERVISOR_PLAN_KINDS.has(parsed.kind)) return this.supervisorPlans.previewLocal(parsed);
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
    this.dashboardHost.initDashboard();
    this.bindProductService();
    this.instances.reconcileInstanceRecords();
    if (this.hasMaintenanceEvidence() || this.lock.inspect().held || this.runs.unmanaged.size) {
      this.maintenance = this.createMaintenance();
      this.refreshAvailability();
      return;
    }
    const bootstrapPending = this.ownsBootstrap(identity.profileId);
    if (this.managerInstall === "ordinary" && !bootstrapPending) {
      this.lifecycle.blocked = true;
      this.lifecycle.reasons = [
        "The reserved manager name already belongs to an ordinary profile. It was not overwritten.",
      ];
      this.refreshAvailability();
      return;
    }
    if (this.managerInstall === "damaged") {
      this.lifecycle.blocked = true;
      this.lifecycle.reasons = ["The manager profile record is damaged and was not rebuilt."];
      this.refreshAvailability();
      return;
    }
    let managerDump: string | undefined;
    if (this.managerInstall === "missing" || bootstrapPending) {
      if (!this.cli) {
        this.lifecycle.blocked = true;
        this.lifecycle.reasons = ["A compatible DSH CLI is required before the manager profile can be created."];
        this.refreshAvailability();
        return;
      }
      try {
        managerDump = await this.observeChildWork(() => this.bootstrapManager(identity.profileId));
        this.managerInstall = inspectManagerInstall(this.home, identity.profileId);
      } catch (error) {
        this.lifecycle.blocked = true;
        this.lifecycle.reasons = ["Manager initialization did not complete. Its local diagnostic record is available."];
        atomicWrite(join(this.controlDir, "manager-bootstrap-error.json"), `${JSON.stringify({
          version: 1, at: this.now().toISOString(),
          detail: sanitizeLogText(error instanceof Error ? error.message : String(error)).slice(0, 4000),
        })}\n`);
      }
    }
    const loader = this.managerId
      ? await this.syncLoader(this.managerId, this.managerId === identity.profileId ? managerDump : undefined)
      : undefined;
    this.spaces = this.createSpacesControlWithLoader(loader);
    try {
      this.maintenance = this.createMaintenance();
    } catch {
      this.lifecycle.reasons.push("Maintenance could not be composed.");
    }
    if (this.managerInstall === "manager" && this.selectedPayload && this.options.pluginArtifact) {
      try {
        await this.alignManagerPlugin(identity.profileId);
      } catch (error) {
        this.lifecycle.blocked = true;
        const detail = sanitizeLogText(error instanceof Error ? error.message : String(error)).slice(0, 400);
        this.lifecycle.reasons.push(`The manager plugin could not be aligned with the selected Spaces version. ${detail}`.trim());
      }
    }
    this.refreshAvailability();

    if (this.managerInstall === "manager" && this.cli && !this.lifecycle.blocked && !this.runs.unmanaged.has(identity.profileId)) {
      try {
        await this.startSpace(identity.profileId, silentJobContext());
      } catch (error) {
        this.lifecycle.blocked = true;
        const detail = (error instanceof Error && error.message
          ? error.message
          : "The manager process could not be started.").slice(0, 400);
        this.lifecycle.reasons.push(`${detail} The stable entry is still available.`);
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
      this.lifecycle.blocked = true;
      this.lifecycle.reasons = [
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
    if (this.lifecycle.handle?.owner.endpoint && this.lifecycle.handle.owner.endpoint !== origin) {
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

  /**
   * Bootstraps the reserved manager profile and returns the config dump read
   * during this run, so an immediate loader sync for the same profile can
   * reuse it instead of spawning a second `--dump-config`. Returns undefined
   * when no dump was read (already installed, or the CLI produced none);
   * callers must treat undefined as "read fresh".
   */
  private async bootstrapManager(profileId: string, lockHeld = false): Promise<string | undefined> {
    const initialize = async () => this.observeChildWork(async (): Promise<string | undefined> => {
      const existing = inspectManagerInstall(this.home, profileId);
      const pending = this.ownsBootstrap(profileId);
      if ((existing === "ordinary" && !pending) || existing === "damaged") {
        throw new WorkbenchPublicError(
          "workbench/protected",
          "The reserved manager name already belongs to an ordinary profile. It was not overwritten.",
        );
      }
      if (existing === "manager" && !pending) return undefined;
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
      return dump;
    });
    if (lockHeld) return await initialize();
    return await this.lock.run("bootstrap-manager", initialize);
  }

  private async alignManagerPlugin(profileId: string): Promise<void> {
    const selected = this.selectedPayload!;
    const installed = () => {
      const lib = this.installedManagerPluginLib(profileId);
      if (!lib) return undefined;
      try {
        return validateComponentPayload(lib);
      } catch {
        return undefined;
      }
    };
    if (installed()?.digest === selected.digest) return;
    await this.lock.run("manager.align", () => this.observeChildWork(async () => {
      await this.installArtifact(profileId, this.options.pluginArtifact!, "dsh-spaces-plugin");
      if (this.options.viewBridgeArtifact) {
        await this.installArtifact(profileId, this.options.viewBridgeArtifact, VIEW_BRIDGE_ID);
      }
      if (installed()?.digest !== selected.digest) {
        throw new Error("The installed manager plugin payload does not match the selected component group.");
      }
    }));
  }

  private installedManagerPluginLib(profileId: string): string | undefined {
    const target = join(this.home, "profiles", profileId, "node_modules", "@dsh-spaces", "plugin", "lib", "index.js");
    let st;
    try {
      st = lstatSync(target);
    } catch {
      return undefined;
    }
    if (st.isSymbolicLink() || !st.isFile()) return undefined;
    try {
      const real = realpathSync(target);
      const rel = relative(resolve(this.home), real);
      if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return undefined;
      return dirname(real);
    } catch {
      return undefined;
    }
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
        const env: NodeJS.ProcessEnv = {
          ...(options.env as NodeJS.ProcessEnv | undefined),
          DSH_HOME: this.home,
          ...this.runs.childViewEnv(profile, {
            managerId: this.managerId,
            origin: this.origin,
            managerOrigin: this.managerOrigin(),
            currentEpoch: this.currentServiceEpoch(),
          }),
          ...writeSpaceLlmLaunchSnapshot(this.home, profile),
        };
        delete env[DASHBOARD_LAUNCH_ENV]; // never inherit another Host's private handoff
        Object.assign(env, this.dashboard?.environment(profile, this.runs.generation(profile)));
        const dashboardGeneration = this.runs.generation(profile);
        const spawnFn = injected.spawn ?? children.spawn;
        const port = Number(args[args.indexOf("--port") + 1]);
        mkdirSync(this.instances.instancesDir(), { recursive: true });
        atomicWrite(this.instances.instancePath(profile), `${JSON.stringify({ version: 1, spaceId: profile,
          phase: "spawning", port, generation: this.runs.generation(profile),
          origin: `http://127.0.0.1:${port}`, startedAt: this.now().toISOString() })}\n`);
        let child;
        try { child = spawnFn(args, { ...options, env }); }
        catch (error) { this.instances.removeInstanceRecord(profile); throw error; }
        if (child.pid) {
          if (profile !== this.managerId) this.messageBus.attach(profile, child);
          this.runs.spawned.set(profile, { pid: child.pid, startedAt: this.now().toISOString() });
          try { this.instances.writeInstanceRecord(profile, port, this.runs.generation(profile)); }
          catch {
            this.lifecycle.maintenanceBlocked = true;
            this.lifecycle.reasons.push("The child identity record could not be saved. Run rights were kept.");
          }
          child.once("exit", () => {
            const recorded = this.runs.spawned.get(profile);
            if (recorded?.pid === child.pid) {
              this.dashboardHost.retireDashboardRun(profile, dashboardGeneration);
              this.runs.spawned.delete(profile);
              this.instances.removeInstanceRecord(profile);
            }
          });
        } else child.once("error", () => {
          this.dashboardHost.retireDashboardRun(profile, dashboardGeneration);
          this.instances.removeInstanceRecord(profile);
        });
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
      if (!this.lifecycle.reasons.includes("The workbench log could not be written.")) {
        this.lifecycle.reasons.push("The workbench log could not be written.");
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
      observeChild: () => observeMaintenanceChild(this.home, () => { this.lifecycle.maintenanceBlocked = true; }),
      profiles: () => this.homeProfileNames(),
      stopAll: () => this.stopOwnedAll(),
      snapshots,
      runtimes,
      runtimeDescriptor: () => this.currentRuntime(),
    });
    const diagnostics = this.ensureDiagnostics();
    const ports = this.maintenancePorts(snapshots, runtimes, upgrades, diagnostics);
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
          this.lifecycle.maintenanceBlocked = true;
          if (!this.lifecycle.reasons.includes("Maintenance diagnostics could not be saved. Further changes are blocked.")) {
            this.lifecycle.reasons.push("Maintenance diagnostics could not be saved. Further changes are blocked.");
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
      assertWritable: () => this.lifecycle.assertWritable(),
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
        if (active && !this.lifecycle.maintenanceFlag) {
          this.lifecycle.maintenanceInventory = {
            mode: this.spaces?.capabilities().mode ?? "unknown-readonly",
            spaces: this.listSpaces(),
          };
        }
        this.lifecycle.maintenanceFlag = active;
        if (!active) this.lifecycle.maintenanceInventory = null;
      },
      hasUnfinishedPlan: planId => this.jobs?.hasUnfinishedPlan(planId) ?? false,
      unfinishedPlanIds: () => this.jobs?.unfinishedPlanIds() ?? [],
      isCompatibleRuntime: (version) => isCompatibleDshCliVersion(version),
      observation: () => this.productObservation(),
    };
  }

  private async syncLoader(profileId: string, bootstrapDump?: string): Promise<SpacesLoaderView | undefined> {
    // `bootstrapDump` may only be the dump bootstrapManager just read for this
    // same profile in this same run; otherwise (other profile, no bootstrap
    // dump, later re-sync) the dump is read fresh.
    const dump = bootstrapDump ?? await this.readDump(profileId);
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
    let managerDump: string | undefined;
    if (this.managerId) {
      this.managerInstall = inspectManagerInstall(this.home, this.managerId);
      if (this.managerInstall === "missing") {
        managerDump = await this.bootstrapManager(this.managerId, true);
        this.managerInstall = inspectManagerInstall(this.home, this.managerId);
      }
      if (this.managerInstall !== "manager") throw new WorkbenchPublicError("workbench/unavailable");
    }
    const loader = this.managerId ? await this.syncLoader(this.managerId, managerDump) : undefined;
    this.spaces = this.createSpacesControlWithLoader(loader);
    if (this.managerId && this.managerInstall === "manager" && !this.runs.unmanaged.has(this.managerId)) {
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

  private async runCommand(command: WorkbenchCommand, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void> {
    if (this.lifecycle.sealing) {
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
        return this.supervisorPlans.executePlan(command.planId, ctx);
      case "llm.apply":
        return this.llmOps.runLlmApply(command, ctx);
      default:
        if (isWorkbenchProductCommand(command)) return this.runProductCommand(command, ctx);
        throw new WorkbenchPublicError("workbench/unsupported");
    }
  }

  private async createSpace(
    input: { name: string; displayName?: string; icon?: string; useSharedLlm?: boolean; browser?: boolean },
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchJob["result"]> {
    ctx.phase("create");
    ctx.cancellable(false);
    const name = parseSpaceName(input.name);
    this.protectSpecial(name, { allowManager: false });
    if (input.browser && (!this.options.browserArtifact || !this.options.viewBridgeArtifact)) {
      throw new WorkbenchPublicError("workbench/unavailable", "The bundled Browser or its view bridge is unavailable.");
    }
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
      if (input.browser) {
        await this.installArtifact(name, this.options.browserArtifact!, "dsh-spaces-browser");
      }
    });
    // Spaces inherit shared connections by default; only an explicit choice is persisted.
    // Blueprint/template callers omit the flag so their own policy write keeps revision 0.
    if (input.useSharedLlm !== undefined) {
      ctx.phase("llm-policy");
      await this.llmHost.dispatch({
        method: "updateSpacePolicy",
        spaceId: name,
        shared: input.useSharedLlm ? { mode: "all" } : { mode: "none" },
        expectedRevision: 0,
      });
      if (input.useSharedLlm) await this.llmOps.ensureLlmBridge(name);
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
    if (id === "web" || id === "desktop") throw new WorkbenchPublicError("workbench/protected");
    if (this.runs.unmanaged.has(id)) throw new WorkbenchPublicError("workbench/unmanaged");
    if (this.statusOf(id) === "running") {
      if (!this.runs.views.has(id)) throw new WorkbenchPublicError("workbench/unavailable");
      return { spaceId: id, view: await this.view(id) };
    }
    if (id !== this.managerId) await this.ensureViewBridge(id);
    await this.llmOps.ensureLlmBridge(id);
    const gen = this.runs.nextGeneration(id);
    const channel = randomBytes(8).toString("hex");
    const epoch = this.requireServiceEpoch();
    this.runs.views.set(id, {
      spaceId: id,
      generation: gen,
      origin: this.origin,
      channel,
      serviceEpoch: epoch,
      issued: false,
    });
    try {
      if (id !== this.managerId && this.dashboard) {
        const pkg = JSON.parse(readFileSync(join(this.home, "profiles", id, "package.json"), "utf8"));
        const installed = typeof pkg.dependencies?.["@dsh-spaces/dashboard"] === "string" &&
          Array.isArray(pkg.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes("@dsh-spaces/dashboard");
        await this.dashboard.prepare(id, gen, installed);
      }
      await this.startOwned(id);
    } catch (error) {
      this.dashboardHost.retireDashboardRun(id, gen);
      throw error;
    }
    if (this.lifecycle.maintenanceBlocked) throw new WorkbenchPublicError("workbench/unavailable");
    const port = this.processes?.portOf(id);
    if (!port) throw new WorkbenchPublicError("workbench/failed");
    const childOrigin = `http://127.0.0.1:${port}`;
    const current = this.runs.views.get(id);
    if (!current || current.generation !== gen) {
      throw new WorkbenchPublicError("workbench/failed");
    }
    current.origin = childOrigin;
    if (id !== this.managerId) this.runs.workspaceOrigins.add(childOrigin);
    this.instances.writeInstanceRecord(id, port, gen);
    this.runs.llmApplied.set(id, await this.llmHost.catalogRevision());
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

  private observeChildWork<T>(action: () => T): T {
    return withChildObservation(
      () => observeMaintenanceChild(this.home, () => {
        this.lifecycle.maintenanceBlocked = true;
      }),
      action,
    );
  }

  private dropWritable(): void {
    this.lifecycle.handle?.release(() => this.removeEndpointFile());
    this.lifecycle.handle = undefined;
    this.jobs = undefined;
    this.processes = undefined;
    this.spaces = undefined;
    this.maintenance = null;
    this.products = null;
    this.dashboard = null;
  }

  private async startOwned(spaceId: string): Promise<void> {
    this.lifecycle.assertWritable();
    if (!this.processes) throw new WorkbenchPublicError("workbench/read-only");
    if (this.runs.unmanaged.has(spaceId)) throw new WorkbenchPublicError("workbench/unmanaged");
    if (spaceId === "web") throw new WorkbenchPublicError("workbench/protected");
    if (this.options.componentPayloadRoot) {
      if (!["stopped", "crashed"].includes(this.statusOf(spaceId))) throw new WorkbenchPublicError("workbench/conflict");
      await this.lock.run("space.alpha-migrate", () => migrateProfileToAlpha({
        home: this.home, profileId: spaceId, payloadRoot: this.options.componentPayloadRoot!,
        bin: this.cli?.bin, cliVersion: this.cli?.version,
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
    } else {
      const cliBlock = this.cli ? unmetDshPeers(this.cli.version, dshPeerRangesFromProfile(join(this.home, "profiles", spaceId))) : [];
      if (cliBlock.length && this.cli) {
        throw new WorkbenchPublicError("workbench/incompatible", cliLoadError(this.cli.version, cliBlock));
      }
      if (existsSync(join(this.home, "hub", spaceId, "settings.yaml"))) {
        await this.lock.run("space.settings-migrate", async () => {
          const dump = await this.readDump(spaceId);
          if (!dump) throw new Error("Could not inspect profile configuration before migrating legacy settings.");
          migrateLegacyProfileSettings(this.home, spaceId, dump);
        });
      }
    }
    await this.processes.start(spaceId);
  }

  private async stopOwned(spaceId: string): Promise<void> {
    if (!this.processes) return;
    if (this.runs.unmanaged.has(spaceId)) return;
    const dashboardError = this.dashboardHost.retireDashboardRun(spaceId);
    await this.processes.stop(spaceId);
    this.runs.nextGeneration(spaceId);
    this.runs.views.delete(spaceId);
    this.instances.removeInstanceRecord(spaceId);
    if (dashboardError) throw dashboardError;
  }

  private async stopOwnedAll(): Promise<void> {
    if (!this.processes) return;
    const names = this.ownedSpaceIds().filter((id) => !this.runs.unmanaged.has(id));
    for (const name of names) {
      try {
        await this.stopOwned(name);
      } catch (error) {
        if (!this.lifecycle.reasons.some((row) => row.includes("could not be stopped"))) {
          this.lifecycle.reasons.push(STOP_KEPT_REASON);
        }
        throw error instanceof Error ? error : new Error(STOP_NOT_FORCED);
      }
    }
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
        const leftover = this.runs.unmanaged.has(row.name);
        const status = leftover ? "unknown" : this.publicStatus(row.name);
        const view = this.runs.views.get(row.name);
        return {
          id: row.name,
          displayName: row.meta.displayName || row.name,
          isHost: row.name === this.managerId,
          hasWebApp: row.hasWebApp,
          isolation: row.needsConversion ? "unverified" : "verified",
          icon: row.meta.icon ?? "",
          status,
          generation: view?.generation ?? this.runs.generation(row.name),
          managed: Boolean(this.lifecycle.handle) && !leftover,
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
      .filter((row) => row.managed && !this.runs.unmanaged.has(row.id))
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
    if (id === "web" || id === "desktop") throw new WorkbenchPublicError("workbench/protected");
    if (!options.allowManager && id === this.managerId) throw new WorkbenchPublicError("workbench/protected");
  }

  private role(): WorkbenchState["role"] {
    if (!this.managerId) return "uninitialized";
    if (this.managerInstall === "manager") return "manager";
    if (this.managerInstall === "ordinary") return "workspace";
    return "uninitialized";
  }

  private currentServiceEpoch(): string {
    const nonce = this.lifecycle.handle?.owner.nonce ?? this.peekOwnerNonce();
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
    return this.lifecycle.availability({
      cli: Boolean(this.cli),
      managerUsable: !(this.managerId && this.managerInstall !== "manager"),
      unmanaged: this.runs.unmanaged.size,
    });
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
      llm: (request) => this.llmOps.dispatchLlmAdmitted(request),
      llmAdmitted: (request) => this.llmOps.dispatchLlmAdmitted(request),
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
      llmCatalogObservation: () => this.llmOps.llmCatalogObservation(),
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
    });
  }

  private ensureDiagnostics(): DiagnosticsService {
    this.diagnostics ??= new DiagnosticsService({
      home: this.home,
      profiles: () => this.registry.scan(),
      statusOf: (name) => this.statusOf(name),
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
      if (this.lifecycle.maintenanceFlag || this.hasMaintenanceEvidence() || this.lock.inspect().held) extra.push("Unfinished Home maintenance journal is present.");
    }

    if (!this.cli) extra.push(WORKBENCH_ERROR["workbench/incompatible"]);
    if (this.managerId && this.managerInstall !== "manager") {
      extra.push("The manager profile cannot be used.");
    }
    if (this.runs.unmanaged.size) extra.push("Leftover processes were not adopted.");
    if (this.lifecycle.maintenanceBlocked) extra.push(STOP_KEPT_REASON);
    this.lifecycle.applyDerivedReasons(extra, latchBlock);
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
}

export async function createWorkbenchSupervisor(
  options: WorkbenchSupervisorOptions,
  validated?: ValidatedComponentPayload,
): Promise<WorkbenchSupervisorHandle> {
  const resolved = await preflightSupervisorComponentPayload(options, validated);
  const runtime = new WorkbenchSupervisorRuntime(resolved, validated);
  let port = resolved.port;
  if (port === undefined) {
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

function silentJobContext(): WorkbenchJobContext {
  return {
    signal: new AbortController().signal,
    phase: () => undefined,
    message: () => undefined,
    cancellable: () => undefined,
    result: () => undefined,
  };
}
