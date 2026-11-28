import { VIEW_ENTRY_PATH } from "../../shared/space-host";
import { SpaceBaseCreation } from './supervisor/base-creation';
import { profileBase } from './profile/space-base';
import { lstatSync } from "../../shared/node/filesystem";
import { assertSupportedNode } from "../../shared/node-version";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { atomicWrite } from "./atomic";
import { SpaceMessageRouter } from "./message-bus/router";
import { CooperativeChildren, COOPERATIVE_STOP_WAIT_MS } from "./runtime/cooperative-children";
import { observeMaintenanceChild, withChildObservation } from "./runtime/owned-process-record";
import { sanitizeLogText } from "./diagnostics/diagnostics";
import type { DiagnosticsService } from "./diagnostics/diagnostics";
import { WorkbenchLog } from "./maintenance/workbench-log";
import { createDiagnosticLogger, type DiagnosticLogger } from "./diagnostics/rotating-log";
import { currentOperationDetails, diagnosticNested, diagnosticStep } from "./diagnostics/operation-log";
import { assertNotRealHome, authorizeProductHome } from "./home/home-guard";
import { PatchWriter, SESSION_ROW_ID, extractRoot } from "./profile/patch-writer";
import { composeMainProfileDump } from "./profile/bound-app-boot";
import { pluginAdd, pluginLinkDirectory, pluginRemove } from "./products/plugin-ops";
import { ProcessManager, type KillKind, type ProcessRuntime } from "./runtime/process-manager";
import { setSelectedDshResolver } from "./runtime/dsh-cli";
import { setPackageSource } from "./runtime/toolchain";
import { describeModelSync, prepareMainModelSync, readSpaceModelConfig, syncMainModels, type ModelSyncSummary, type PreparedMainModelSync, type ModelSyncInput } from "./llm/main-model-sync";
import { runLiveModelSync } from "./llm/live-model-sync";
import { ProfileRegistry } from "./profile/profile-registry";
import type { RuntimeStore } from "./runtime/runtime-store";
import { validateComponentPayload, type ValidatedComponentPayload } from "./payload/component-payload";
import { redactPublicReason } from "../../shared/public-reason";
import { WORKBENCH_QUIET_READS } from "../../shared/workbench";
import { spaceIdFromName } from "../../shared/types";
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
  WorkbenchState,
  WorkbenchSpace,
  WorkbenchView,
} from "../../shared/workbench";
import type { WorkbenchStartupStatus } from "../../shared/workbench-startup";
import { isWorkbenchProductCommand } from "../../shared/workbench-product";
import { isSpacesBlueprintMethod, SPACES_BLUEPRINT_SEALED } from "../../shared/blueprint-sealed";
import { requestsBrowserSpace, SPACES_BROWSER_SEALED } from "../../shared/browser-sealed";
import type {
  WorkbenchHomeSettings,
  WorkbenchProductCommand,
  WorkbenchProductRequest,
} from "../../shared/workbench-product";
import { parseWorkbenchProductCommand, parseWorkbenchProductRequest } from "../../shared/workbench-product-schemas";
import { WORKBENCH_PROTOCOL_VERSION, digestHomeIdentity, parseMutationContext } from "./server/workbench-protocol";
import { WorkbenchProductService } from "./products/workbench-products";
import { listSpaceTemplates } from "./products/space-templates";
import {
  composeBlueprintRuntime,
  inspectBlueprintRuntime,
  resolveBlueprintModule,
} from "./blueprint/blueprint-runtime";
import { isCompatibleDshCliVersion } from "./products/spaces-service";
import type { NodeSpacesService } from "./products/spaces-service";
import {
  HOME_CONTROL_DIR_NAME,
  HomeControlBusyError,
  HomeLease,
  defaultPidAlive,
  parseControlEndpoint,
  type PidAliveFn,
} from "./home/home-lease";
import { HomeOperationLock, canonicalHome } from "./home/home-operation-lock";
import {
  WorkbenchJobStore,
  type WorkbenchJobContext,
} from "./maintenance/workbench-jobs";
import {
  expectedAuthCookieName,
  renderEntryPage,
  safeEqual,
  startWorkbenchHttp,
  type WorkbenchApiMethod,
  type WorkbenchHttpRuntime,
  type ViewBootstrap,
} from "./server/workbench-http";
import { STOP_KEPT_REASON, STOP_NOT_FORCED, WORKBENCH_ERROR, WorkbenchPublicError, WRITABLE_STARTUP_FAILED_REASON } from "./supervisor/errors";
import {
  expectKeys,
  expectObject,
  parseId,
  parsePlanRequest,
  parseRequestId,
  parseSpaceName,
} from "./supervisor/input";
import { SupervisorInstanceRecords } from "./supervisor/instance-records";
import { silentJobContext } from "./supervisor/job-context";
import { SupervisorLifecycle } from "./supervisor/lifecycle";
import { SupervisorStartup } from "./supervisor/startup";
import { publicReason, startupFailureFrom } from "./runtime/start-failure";
import { SupervisorAttention } from "./supervisor/attention";
import { SupervisorLlm } from "./supervisor/llm";
import { SupervisorControl } from "./supervisor/control";
import { SupervisorCreator } from "./supervisor/creator";
import { UiAutomationManager } from "./supervisor/ui-automation";
import { ChildRemoteClient, runLivePlan, runMaintenanceLivePlugin } from "./supervisor/child-remote";
import { SupervisorMaintenanceGate } from "./supervisor/maintenance";
import {
  bindSelectedCli,
  preflightSupervisorComponentPayload,
} from "./supervisor/payload";
import { inspectManagerInstall, publicPluginVersion } from "./supervisor/profile-probe";
import { SupervisorPlans } from "./supervisor/plans";
import { SupervisorSpaceCommands } from "./supervisor/space-commands";
import { SupervisorSpaceLifecycle } from "./supervisor/space-lifecycle";
import { SpaceRunRegistry } from "./supervisor/space-runs";
import { SupervisorSpaces } from "./supervisor/spaces";
import { SupervisorState } from "./supervisor/state";
import { SupervisorToolchain } from "./supervisor/toolchain";
import type {
  BoundCli,
  WorkbenchMaintenance,
  WorkbenchSupervisorHandle,
  WorkbenchSupervisorOptions,
} from "./supervisor/types";

export { WORKBENCH_API_METHODS, expectedAuthCookieName } from "./server/workbench-http";
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

const ENDPOINT_FILE = "endpoint.json";
const HOST_BEARER_FILE = "host.bearer";

const SUPERVISOR_PLAN_KINDS = new Set<WorkbenchPlanRequest["kind"]>([
  "space.stop",
  "space.restart",
  "space.delete",
  "space.models.sync",
  "service.shutdown",
]);
const REMOVED_COMMAND_KINDS = new Set([
  "controller.acquire",
  "recovery.resume",
  "space.verify",
  ...(SPACES_BLUEPRINT_SEALED ? ["blueprint.apply"] : []),
]);
const REMOVED_PLAN_KINDS = new Set(["controller.release", "controller.shutdown", "snapshot.restore", "config.restore", "workbench.upgrade", "runtime.install", "runtime.upgrade"]);

/**
 * Independent web supervisor: stable 127.0.0.1 entry, HomeLease run
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
  private readonly lease: HomeLease;
  private readonly lock: HomeOperationLock;
  private readonly registry: ProfileRegistry;
  private readonly patchWriter: PatchWriter;
  private readonly now: () => Date;
  readonly diagnosticLog: DiagnosticLogger;
  private withDiagnostics<T>(action: () => T): T { return diagnosticNested(this.diagnosticLog, action); }
  private readonly fetchImpl: typeof fetch;
  private readonly lifecycle = new SupervisorLifecycle(() => this.spaceInventory.assertRegistryReadable());
  private readonly startup = new SupervisorStartup();
  private jobs: WorkbenchJobStore | undefined;
  private processes: ProcessManager | undefined;
  private spaces: NodeSpacesService | undefined;
  private maintenance: WorkbenchMaintenance | null = null;
  private products: WorkbenchProductService | null = null;
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
  private readonly instances: SupervisorInstanceRecords;
  private readonly llmOps: SupervisorLlm;
  private readonly spaceAttention: SupervisorAttention;
  private readonly creator: SupervisorCreator;
  private readonly control: SupervisorControl;
  private readonly uiAutomation: UiAutomationManager;
  private readonly spaceInventory: SupervisorSpaces;
  private readonly spaceLifecycle: SupervisorSpaceLifecycle;
  private readonly bases: SpaceBaseCreation;
  private readonly spaceCommands: SupervisorSpaceCommands;
  private readonly stateModel: SupervisorState;
  private readonly maintenanceGate: SupervisorMaintenanceGate;
  private readonly toolchain: SupervisorToolchain;
  constructor(options: WorkbenchSupervisorOptions, selectedPayload?: ValidatedComponentPayload) {
    assertSupportedNode();
    const original = { ...options };
    this.options = {
      ...original,
      ...(original.pluginAdd ? {} : { pluginAdd: (home, profile, spec, addOptions) => this.withDiagnostics(() => pluginAdd(home, profile, spec, addOptions)) }),
      ...(original.pluginRemove ? {} : { pluginRemove: (home, profile, packageName) => this.withDiagnostics(() => pluginRemove(home, profile, packageName)) }),
      ...(original.pluginLink ? {} : { pluginLink: (home, profile, dir, expectedName) => this.withDiagnostics(() => pluginLinkDirectory(home, profile, dir, expectedName)) }),
    };
    this.home = canonicalHome(options.home, { allowRealHome: options.allowRealHome });
    if (options.allowRealHome) authorizeProductHome(this.home);
    if (!options.allowRealHome) assertNotRealHome(this.home);
    this.nodeExe = resolve(options.nodeExe ?? process.execPath);
    this.controlDir = join(this.home, HOME_CONTROL_DIR_NAME);
    this.lease = new HomeLease(this.home, {
      allowRealHome: options.allowRealHome,
      pidAlive: options.pidAlive,
    });
    this.lock = new HomeOperationLock(this.home, { allowRealHome: options.allowRealHome });
    this.registry = new ProfileRegistry(this.home, { allowRealHome: options.allowRealHome });
    this.patchWriter = options.patchWriter ?? new PatchWriter(this.home);
    this.now = options.now ?? (() => new Date());
    this.diagnosticLog = createDiagnosticLogger(this.home, "supervisor", {
      now: this.now,
      allowRealHome: options.allowRealHome,
    });
    this.diagnosticLog.debug("supervisor.runtime-created", "Supervisor runtime constructed.", { devCheckout: options.devCheckoutRoot !== undefined });
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.pidAlive = options.pidAlive ?? defaultPidAlive;
    if (options.componentPayloadRoot) {
      // Reuse the launch validation when provided; it must belong to this root.
      this.selectedPayload = selectedPayload ?? validateComponentPayload(options.componentPayloadRoot);
    }
    this.spaceAttention = new SupervisorAttention({
      runs: this.runs,
      currentServiceEpoch: () => this.stateModel.currentServiceEpoch(),
    });
    this.spaceInventory = new SupervisorSpaces({
      home: this.home,
      registry: this.registry,
      lifecycle: this.lifecycle,
      runs: this.runs,
      processes: () => this.processes,
      managerId: () => this.managerId,
      attentionOf: (id) => this.spaceAttention.attentionOf(id),
      workingOf: (id) => this.llmOps.workingOf(id),
    });
    this.spaceLifecycle = new SupervisorSpaceLifecycle({
      diagnosticLog: this.diagnosticLog,
      home: this.home,
      origin: () => this.origin,
      managerId: () => this.managerId,
      lifecycle: this.lifecycle,
      runs: this.runs,
      instances: () => this.instances,
      processes: () => this.processes,
      options: this.options,
      lock: this.lock,
      statusOf: (name) => this.spaceInventory.statusOf(name),
      requireSpace: (spaceId) => this.spaceInventory.requireSpace(spaceId),
      view: (spaceId) => this.view(spaceId),
      requireServiceEpoch: () => this.stateModel.requireServiceEpoch(),
      ensureViewBridge: (profileId) => this.toolchain.ensureViewBridge(profileId),
      ensureBundledDeps: (profileId) => this.toolchain.ensureBundledDependencies(profileId),
      installComponent: (profileId, component) => this.toolchain.installComponent(profileId, component),
      removePlugin: (profileId, packageName) => (this.options.pluginRemove ?? pluginRemove)(this.home, profileId, packageName),
      componentAligned: (profileId, component) => this.toolchain.componentAligned(profileId, component),
      readDump: (profile) => this.toolchain.readDump(profile),
      pinnedDshVersion: (spaceId) => this.toolchain.pinnedDshVersion(spaceId),
      resolveSpaceRuntime: (spaceId) => this.toolchain.resolveSpaceRuntime(spaceId),
    });
    this.bases = new SpaceBaseCreation({ diagnosticLog: this.diagnosticLog, home: this.home, nodeExe: this.nodeExe, options: this.options, cli: () => this.cli, runtimes: () => this.runtimeStore });
    this.spaceCommands = new SupervisorSpaceCommands({
      bases: this.bases,
      home: this.home,
      lock: this.lock,
      registry: this.registry,
      options: this.options,
      cli: () => this.cli,
      spaces: () => this.spaces,
      requireSpace: (spaceId) => this.spaceInventory.requireSpace(spaceId),
      protectSpecial: (id, protectOptions) => this.spaceInventory.protectSpecial(id, protectOptions),
      ensureViewBridge: (profileId) => this.toolchain.ensureViewBridge(profileId),
      mainProfile: () => this.mainProfile(),
      syncMainModels: (spaceId) => this.syncMainModels(spaceId),
      hasComponent: (component) => this.toolchain.hasComponent(component),
    });
    this.stateModel = new SupervisorState({
      home: this.home,
      lease: this.lease,
      lifecycle: this.lifecycle,
      runs: this.runs,
      lock: this.lock,
      cli: () => this.cli,
      managerId: () => this.managerId,
      managerInstall: () => this.managerInstall,
      jobs: () => this.jobs,
      spaces: () => this.spaces,
      listSpaces: () => this.spaceInventory.listSpaces(),
      publicStatus: (id) => this.spaceInventory.publicStatus(id),
      hasMaintenanceEvidence: () => this.maintenanceGate.hasMaintenanceEvidence(),
      homeSettings: () => this.homeSettings,
      setHomeSettings: (settings) => { this.homeSettings = settings; },
    });
    this.maintenanceGate = new SupervisorMaintenanceGate({
      home: this.home,
      registry: this.registry,
      lock: this.lock,
      lifecycle: this.lifecycle,
      options: this.options,
      cli: () => this.cli,
      managerId: () => this.managerId,
      processes: () => this.processes,
      spaces: () => this.spaces,
      jobs: () => this.jobs,
      runtimeStore: () => this.runtimeStore,
      setRuntimeStore: (store) => { this.runtimeStore = store; },
      diagnostics: () => this.diagnostics,
      setDiagnostics: (diagnostics) => { this.diagnostics = diagnostics; },
      snapshotRoot: () => this.toolchain.snapshotRoot(),
      runtimeRoot: () => this.toolchain.runtimeRoot(),
      readHomeSettings: () => this.stateModel.readHomeSettings(),
      workbenchLog: () => this.workbenchLog(),
      listSpaces: () => this.spaceInventory.listSpaces(),
      requireSpace: (spaceId) => this.spaceInventory.requireSpace(spaceId),
      validateSpace: (spaceId, allowManager) => this.spaceInventory.validateSpace(spaceId, allowManager),
      publicStatus: (id) => this.spaceInventory.publicStatus(id),
      statusOf: (name) => this.spaceInventory.statusOf(name),
      generationOf: (spaceId) => this.runs.generation(spaceId),
      ownedSpaceIds: () => this.spaceInventory.ownedSpaceIds(),
      stopOwned: (spaceId) => this.spaceLifecycle.stopOwned(spaceId),
      stopOwnedAll: () => this.spaceLifecycle.stopOwnedAll(),
      startSpace: (spaceId, ctx) => this.spaceLifecycle.startSpace(spaceId, ctx),
      pluginLive: (input, ctx, options) => {
        const client = this.childRemoteClient(input.spaceId);
        if (!client) throw new WorkbenchPublicError("workbench/unavailable", "The child remote surface is unavailable.");
        return runMaintenanceLivePlugin(client, this.home, input, ctx, options);
      },
      currentRuntime: () => this.toolchain.currentRuntime(),
      reinitializeManager: () => this.reinitializeManager(),
      productObservation: () => this.stateModel.productObservation(),
    });
    this.toolchain = new SupervisorToolchain({
      diagnosticLog: this.diagnosticLog,
      home: this.home,
      controlDir: this.controlDir,
      nodeExe: this.nodeExe,
      lifecycle: this.lifecycle,
      lock: this.lock,
      registry: this.registry,
      options: this.options,
      now: this.now,
      cli: () => this.cli,
      setCli: (cli) => { this.cli = cli; },
      managerId: () => this.managerId,
      selectedPayload: () => this.selectedPayload,
      runtimeStore: () => this.runtimeStore,
      observeChildWork: (action) => this.observeChildWork(action),
    });
    this.supervisorPlans = new SupervisorPlans({
      diagnosticLog: this.diagnosticLog,
      whileIdle: (id, action) => this.llmOps.whileIdle(id, action),
      home: this.home,
      lifecycle: this.lifecycle,
      runs: this.runs,
      instances: () => this.instances,
      lock: this.lock,
      registry: this.registry,
      now: this.now,
      messageBus: this.messageBus,
      options: this.options,
      jobs: () => this.jobs,
      maintenance: () => this.maintenance,
      closeHttp: async () => { await this.httpClose?.(); },
      dropWritable: () => this.dropWritable(),
      requireSpace: (spaceId) => this.spaceInventory.requireSpace(spaceId),
      requireManaged: (spaceId) => this.spaceInventory.requireManaged(spaceId),
      protectSpecial: (id, protectOptions) => this.spaceInventory.protectSpecial(id, protectOptions),
      statusOf: (id) => this.spaceInventory.statusOf(id),
      ownedSpaceIds: () => this.spaceInventory.ownedSpaceIds(),
      stopOwned: (spaceId) => this.spaceLifecycle.stopOwned(spaceId),
      stopOwnedAll: () => this.spaceLifecycle.stopOwnedAll(),
      startSpace: (spaceId, ctx) => this.spaceLifecycle.startSpace(spaceId, ctx),
      mainProfile: () => this.mainProfile(),
      prepareModelSync: (spaceId) => this.prepareModelSync(spaceId),
      modelLive: (prepared, spaceId, ctx) => {
        const client = this.childRemoteClient(spaceId);
        if (!client) throw new WorkbenchPublicError("workbench/unavailable", "The child settings surface is unavailable.");
        return runLiveModelSync(client, prepared, spaceId, ctx);
      },
      pluginLive: (request, ctx) => {
        const client = this.childRemoteClient(request.spaceId);
        if (!client) throw new WorkbenchPublicError("workbench/unavailable", "The child remote surface is unavailable.");
        return runLivePlan(client, request, ctx);
      },
      currentServiceEpoch: () => this.stateModel.currentServiceEpoch(),
      stateRevision: () => this.stateModel.stateRevision(),
      productObservation: () => this.stateModel.productObservation(),
      assertLiveContext: (context) => this.stateModel.assertLiveContext(context),
    });
    this.instances = new SupervisorInstanceRecords({
      controlDir: this.controlDir,
      runs: this.runs,
      lifecycle: this.lifecycle,
      pidAlive: this.pidAlive,
      plans: this.supervisorPlans.plans,
    });
    this.llmOps = new SupervisorLlm({
      runs: this.runs,
      publicStatus: (id) => this.spaceInventory.publicStatus(id),
      currentServiceEpoch: () => this.stateModel.currentServiceEpoch(),
    });
    this.creator = new SupervisorCreator({
      diagnosticLog: this.diagnosticLog,
      home: this.home,
      origin: () => this.origin,
      now: this.now,
      fetch: this.fetchImpl,
      lifecycle: this.lifecycle,
      lock: this.lock,
      registry: this.registry,
      runs: this.runs,
      jobs: () => this.jobs,
      managerId: () => this.managerId,
      cli: () => this.cli,
      spaces: () => this.spaces,
      bases: this.bases,
      hostBearerEquals: value => this.hostBearerEquals(value),
      assertOwner: () => {
        this.lifecycle.assertWritable();
        const current = this.lease.inspect(), expected = this.lifecycle.handle?.owner;
        if (!expected || !current.held || !("owner" in current) || current.handoff || current.liveness !== "alive" ||
            current.owner.nonce !== expected.nonce || current.owner.pid !== expected.pid || current.owner.startedAt !== expected.startedAt || this.lifecycle.closed || this.lifecycle.blocked) {
          throw new WorkbenchPublicError("workbench/read-only");
        }
      },
      currentServiceEpoch: () => this.stateModel.currentServiceEpoch(),
      stateRevision: () => this.stateModel.stateRevision(),
      registeredSpaceIds: () => this.spaceInventory.listSpaces().map(row => row.id),
      maintenance: () => this.lifecycle.maintenanceFlag,
      hasComponent: component => this.toolchain.hasComponent(component),
      ensureViewBridge: profileId => this.toolchain.ensureViewBridge(profileId),
      syncMainModels: spaceId => this.syncMainModels(spaceId),
      installedRuntimeBin: version => this.runtimeStore?.installedBin(version),
      startSpace: (spaceId, ctx) => this.spaceLifecycle.startSpace(spaceId, ctx),
      pluginAdd: (home, profile, spec) => {
        const add = this.options.pluginAdd ?? pluginAdd;
        return add(home, profile, spec);
      },
      observeChildWork: action => this.observeChildWork(action),
      setActiveJob: id => { this.lifecycle.activeJobId = id; },
    });
    this.control = new SupervisorControl({
      creator: this.creator,
      origin: () => this.origin,
      now: this.now,
      hostBearerEquals: value => this.hostBearerEquals(value),
      currentServiceEpoch: () => this.stateModel.currentServiceEpoch(),
      stateRevision: () => this.stateModel.stateRevision(),
      writable: () => Boolean(this.lifecycle.handle),
      maintenance: () => this.lifecycle.maintenanceFlag,
      dshVersion: () => this.cli?.version ?? null,
      jobs: () => this.jobs,
      maintenanceService: () => this.maintenance,
      managerId: () => this.managerId,
      listSpaces: () => this.spaceInventory.listSpaces(),
      requireSpace: spaceId => this.spaceInventory.requireSpace(spaceId),
      unmanaged: id => this.runs.unmanaged.has(id),
      detail: id => this.detail(id),
      diagnostics: spaceId => this.maintenanceGate.productDiagnostics(spaceId),
      observeTaskActivity: spaceId => this.llmOps.observeTaskActivity(spaceId),
      admitSubmission: () => this.lifecycle.admitSubmission(),
      assertWritable: () => this.lifecycle.assertWritable(),
      assertLiveContext: context => this.stateModel.assertLiveContext(context),
      previewPlan: request => this.previewPlan(request),
      previewLocalPlan: request => this.supervisorPlans.previewLocal(request),
      executePlan: (planId, ctx) => this.supervisorPlans.executePlan(planId, ctx),
      startSpace: (spaceId, ctx) => this.spaceLifecycle.startSpace(spaceId, ctx),
      childRemote: (spaceId, generation, serviceEpoch) => this.childRemoteClient(spaceId, generation, serviceEpoch),
      observeChildWork: action => this.observeChildWork(action),
      setActiveJob: id => { this.lifecycle.activeJobId = id; },
      templates: () => listSpaceTemplates(this.home),
      stagedImport: (importId) => {
        if (!this.products) throw new WorkbenchPublicError("workbench/read-only");
        return this.products.peekImport(importId);
      },
      sharePreview: async (archiveBase64) => {
        if (!this.products) throw new WorkbenchPublicError("workbench/read-only");
        const result = await this.products.read({ method: "share.previewImport", archiveBase64 });
        if (result.method !== "share.previewImport") throw new WorkbenchPublicError("workbench/unavailable");
        return { importId: result.importId, expiresAt: result.expiresAt, preview: result.preview };
      },
      runProductCommand: (command, ctx) => this.runProductCommand(command, ctx),
      afterPlanJobSettled: jobId => {
        const jobs = this.jobs;
        if (jobs) void jobs.whenIdle()
          .then(() => this.supervisorPlans.afterPlanJobSettled(jobId))
          .catch((error: unknown) => this.diagnosticLog.error("plan.settle-failed", "The settled-plan hook failed.", error, { job: jobId }));
      },
      uiAutomation: () => this.uiAutomation,
    });
    this.uiAutomation = new UiAutomationManager({
      requireSpace: spaceId => this.spaceInventory.requireSpace(spaceId),
      managerId: () => this.managerId,
      unmanaged: id => this.runs.unmanaged.has(id),
      statusOf: id => this.spaceInventory.statusOf(id),
      generationOf: id => this.runs.generation(id),
      spawned: id => this.runs.spawned.has(id),
      urlOf: id => this.processes?.urlOf(id),
      portOf: id => this.processes?.portOf(id),
      currentServiceEpoch: () => this.stateModel.currentServiceEpoch(),
      fetch: this.fetchImpl,
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

  /** The verified main profile of this service epoch, from the main-channel registration. */
  private mainProfile(): string {
    const profile = this.creator.registrationView()?.profile;
    if (!profile) {
      throw new WorkbenchPublicError("workbench/unavailable", "The main space is not connected to this Spaces service, so its models cannot be read.");
    }
    return profile;
  }

  private modelSyncInput(spaceId: string): ModelSyncInput {
    return {
      home: this.home,
      mainProfile: this.mainProfile(),
      spaceId,
      dumpConfig: async (profile) => {
        // The main profile runs the host DSH, so the bound host's app-boot
        // composes it: the official CLI refuses the Electron-owned "desktop"
        // profile, and its dump rewrites the profile root.
        if (this.options.dumpConfig) return this.options.dumpConfig(profile);
        const bin = this.toolchain.resolveCliBin();
        if (!bin) throw new WorkbenchPublicError("workbench/incompatible");
        try {
          return await composeMainProfileDump({ home: this.home, profile, bin });
        } catch (error) {
          this.diagnosticLog.error("models.main-dump-failed", "The main space configuration could not be read.", error, { profile });
          throw new WorkbenchPublicError("workbench/failed", "The main space configuration could not be read.");
        }
      },
    };
  }

  private prepareModelSync(spaceId: string): Promise<PreparedMainModelSync> {
    return prepareMainModelSync(this.modelSyncInput(spaceId));
  }

  /** Creation-time copy; explicit syncs are prepared and executed by SupervisorPlans. */
  private async syncMainModels(spaceId: string): Promise<ModelSyncSummary> {
    const summary = await syncMainModels(this.modelSyncInput(spaceId));
    this.workbenchLog().append({ level: "info", area: "models", event: "sync", message: `${spaceId}: ${describeModelSync(summary)}` });
    return summary;
  }

  handleCreatorRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    return this.creator.handle(req, res);
  }

  handleControlRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    return this.control.handle(req, res);
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

  async startupStatus(): Promise<WorkbenchStartupStatus> {
    return this.startup.snapshot({
      serviceEpoch: this.stateModel.currentServiceEpoch(),
      managerId: this.managerId,
    });
  }

  async tryOwn(): Promise<void> {
    this.diagnosticLog.info("supervisor.ownership", "Supervisor run-rights inspection began.");
    const inspection = this.lease.inspect();
    if (inspection.held) {
      this.diagnosticLog.info("supervisor.ownership-result", "Supervisor run-rights inspection completed.", { acquired: false, reason: "held" });
      this.lifecycle.reasons = this.heldReasons(inspection);
      this.startup.fail(this.lifecycle.reasons[0] ?? "Another controller holds run rights. This entry stays read-only.", "ownership", {
        reasons: this.lifecycle.reasons,
      });
      return;
    }
    try {
      this.lifecycle.handle = this.lease.acquire("web", this.origin);
    } catch (error) {
      if (error instanceof HomeControlBusyError) {
        this.lifecycle.reasons = this.heldReasons(error.inspection);
        this.startup.fail(this.lifecycle.reasons[0] ?? error, "ownership", { reasons: this.lifecycle.reasons });
        this.diagnosticLog.error("supervisor.ownership-failed", "Supervisor could not acquire run rights.", error, { stage: "ownership" });
        return;
      }
      this.lifecycle.blocked = true;
      this.lifecycle.reasons = [WRITABLE_STARTUP_FAILED_REASON];
      this.startup.fail(error, "acquire", { reasons: [WRITABLE_STARTUP_FAILED_REASON] });
      this.diagnosticLog.error("supervisor.ownership-failed", "Supervisor could not acquire run rights.", error, { stage: "acquire" });
      return;
    }
    try {
      this.writeHostBearer();
      this.writeEndpointFile();
    } catch (error) {
      this.lifecycle.blocked = true;
      this.lifecycle.reasons = [
        ...this.lifecycle.reasons,
        WRITABLE_STARTUP_FAILED_REASON,
      ];
      this.startup.fail(error, "prepare", { reasons: [WRITABLE_STARTUP_FAILED_REASON] });
      this.diagnosticLog.error("supervisor.prepare-failed", "Supervisor endpoint preparation failed.", error, { stage: "endpoint" });
      return;
    }
    this.diagnosticLog.info("supervisor.ownership-result", "Supervisor run rights and endpoint were published.", { acquired: true });
    this.lifecycle.initializing = true;
    try {
      await this.initWritable();
    } catch (error) {
      this.lifecycle.blocked = true;
      this.lifecycle.reasons = [
        ...this.lifecycle.reasons,
        WRITABLE_STARTUP_FAILED_REASON,
      ];
      this.startup.fail(error, "prepare", { reasons: [WRITABLE_STARTUP_FAILED_REASON] });
      this.diagnosticLog.error("supervisor.initialize-failed", "Supervisor writable initialization failed.", error, { stage: "prepare" });
    } finally {
      this.lifecycle.initializing = false;
    }
    this.diagnosticLog.info("supervisor.initialization", "Supervisor writable initialization completed.", { blocked: this.lifecycle.blocked });
  }

  async close(): Promise<void> {
    if (this.lifecycle.closed) return;
    this.diagnosticLog.info("supervisor.stopping", "Supervisor shutdown began.");
    this.lifecycle.sealing = true;
    try {
      await this.creator.close();
      await this.control.close();
      // Releases the automation browser and every session page/context;
      // failures inside are already bounded by the manager.
      await this.uiAutomation.closeAll();
      if (this.jobs) await this.jobs.whenIdle();
      await this.spaceLifecycle.stopOwnedAll();
      this.messageBus.close();
    } catch (error) {
      this.lifecycle.maintenanceBlocked = true;
      this.lifecycle.blocked = true;
      this.lifecycle.addReason(STOP_KEPT_REASON);
      this.diagnosticLog.fault("supervisor.stop-failed", "Supervisor shutdown failed; run rights and failure evidence are preserved.", error);
      throw error instanceof Error ? error : new Error(STOP_NOT_FORCED);
    }
    this.dropWritable();
    this.lifecycle.closed = true;
    await this.httpClose?.();
    this.diagnosticLog.info("supervisor.stopped", "Supervisor shutdown completed.");
  }

  async dispatch(method: WorkbenchApiMethod, payload: unknown): Promise<unknown> {
    const started = Date.now();
    const correlation = currentOperationDetails();
    const quiet = WORKBENCH_QUIET_READS.has(method);
    if (!quiet) this.diagnosticLog.debug("request.started", "Workbench request accepted for dispatch.", { event: dispatchEventName(method, payload), ...correlation, request: correlation?.operationId ?? null });
    try {
      const result = await this.dispatchRequest(method, payload);
      if (!quiet) this.diagnosticLog.debug("request.completed", "Workbench request completed.", { event: dispatchEventName(method, payload), durationMs: Date.now() - started, ...currentOperationDetails() });
      return result;
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
      case "startupStatus":
        expectKeys(body, []);
        return this.startupStatus();
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
      case "product":
        expectKeys(body, ["request"]);
        return this.product(parseWorkbenchProductRequest(body.request));
      default: {
        // The canonical API surface is the only source of method names, so an
        // unhandled method is a compile error rather than a silent hole.
        const unhandled: never = method;
        return unhandled;
      }
    }
  }

  entryPage(): string {
    const managerId = this.managerId;
    const view = managerId ? this.runs.views.get(managerId) : undefined;
    const running = managerId ? this.spaceInventory.statusOf(managerId) === "running" : false;
    const epoch = this.stateModel.currentServiceEpoch();
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
    const currentEpoch = this.stateModel.currentServiceEpoch();
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
    const location = id === this.managerId ? `${view.origin}/` : `${view.origin}${VIEW_ENTRY_PATH}`;
    if (/[?&]token=/i.test(location) || named.some((row) => /token=/i.test(row.split(";", 1)[0] ?? ""))) {
      return { status: 502, message: "The child authentication exchange failed." };
    }
    return { setCookies: named, location };
  }

  async state(): Promise<WorkbenchState> {
    return this.stateModel.state();
  }

  async detail(spaceId: string): Promise<SpaceDetail> {
    const id = this.spaceInventory.requireSpace(spaceId);
    if (this.spaces) return this.spaces.detail(id);
    const space = this.spaceInventory.listSpaces().find((row) => row.id === id);
    if (!space) throw new WorkbenchPublicError("workbench/not-found");
    return {
      space: {
        id: space.id,
        displayName: space.displayName,
        isHost: space.id === this.managerId,
        hasWebApp: true,
        status: space.status === "running" ? "running" : space.status === "unknown" ? "unknown" : "stopped",
      },
      plugins: this.spaceInventory.readPlugins(id).map((row) => ({
        name: row.name,
        version: publicPluginVersion(row.version),
      })),
      models: readSpaceModelConfig(this.home, id),
      snapshots: [],
      diagnostics: this.lifecycle.reasons.map((message) => ({ level: "warning" as const, code: "WORKBENCH", message })),
    };
  }

  async submit(command: WorkbenchCommand, requestId: string, context: WorkbenchMutationContext): Promise<WorkbenchJob> {
    const parsedContext = parseMutationContext(context);
    if (command?.kind === "creator.create" || command?.kind === "control.execute") {
      throw new WorkbenchPublicError("workbench/unsupported");
    }
    if (SPACES_BROWSER_SEALED && command?.kind === 'space.create' && requestsBrowserSpace(command.input)) {
      throw new WorkbenchPublicError('workbench/unsupported');
    }
    if (REMOVED_COMMAND_KINDS.has((command as { kind?: string }).kind ?? "")) {
      throw new WorkbenchPublicError("workbench/unsupported");
    }
    this.lifecycle.admitSubmission();
    if (!this.jobs) throw new WorkbenchPublicError("workbench/read-only");
    const parsedCommand = isWorkbenchProductCommand(command) ? parseWorkbenchProductCommand(command) : command;
    const epochMatches = parsedContext.serviceEpoch === this.stateModel.currentServiceEpoch();
    let planAdmission: { scope: WorkbenchPlan["scope"]; affectedSpaceIds: string[] } | undefined;
    let planAdmitError: unknown;
    let submitTargetSpace: { spaceId: string; fingerprint: string } | undefined;
    if (epochMatches && parsedCommand?.kind === "plan.execute" && typeof parsedCommand.planId === "string") {
      try {
        planAdmission = this.supervisorPlans.admitPlan(parsedCommand.planId);
      } catch (error) {
        planAdmitError = error;
      }
    } else if (epochMatches && parsedContext.expectedRevision === this.stateModel.stateRevision()) {
      const targetSpaceId = this.directTargetSpaceId(parsedCommand);
      if (targetSpaceId) {
        submitTargetSpace = {
          spaceId: targetSpaceId,
          fingerprint: this.spaceMutationFingerprint(targetSpaceId),
        };
      }
    }
    const job = await this.jobs.submit(parsedCommand, requestId, (ctx) => {
      this.lifecycle.activeJobId = requestId;
      return this.observeChildWork(async () => {
        try {
          this.lifecycle.assertWritable();
          if (parsedCommand.kind === "plan.execute") {
            if (parsedContext.serviceEpoch !== this.stateModel.requireServiceEpoch()) {
              throw new WorkbenchPublicError("workbench/conflict", "Mutation context belongs to another service epoch.");
            }
            if (planAdmitError !== undefined) throw planAdmitError;
            if (planAdmission?.scope !== "space") {
              this.stateModel.assertLiveContext(parsedContext);
            }
          } else if (submitTargetSpace) {
            if (parsedContext.serviceEpoch !== this.stateModel.requireServiceEpoch()) {
              throw new WorkbenchPublicError("workbench/conflict", "Mutation context belongs to another service epoch.");
            }
            if (this.spaceMutationFingerprint(submitTargetSpace.spaceId) !== submitTargetSpace.fingerprint) {
              throw new WorkbenchPublicError("workbench/conflict", "The target space changed since the request was submitted.");
            }
          } else {
            this.stateModel.assertLiveContext(parsedContext);
          }
          return await this.runCommand(parsedCommand, ctx);
        } finally {
          this.lifecycle.activeJobId = undefined;
        }
      });
    }, planAdmission ? { affectedSpaceIds: planAdmission.affectedSpaceIds } : undefined);
    if (parsedCommand.kind === "plan.execute") {
      const jobId = job.id;
      void this.jobs.whenIdle()
        .then(() => this.supervisorPlans.afterPlanJobSettled(jobId))
        .catch((error: unknown) => this.diagnosticLog.error("plan.settle-failed", "The settled-plan hook failed.", error, { job: jobId }));
    }
    return job;
  }

  private directTargetSpaceId(command: WorkbenchCommand): string | null {
    if (!command || typeof command !== "object") return null;
    switch (command.kind) {
      case "space.start":
      case "space.update":
      case "template.save":
        return typeof command.spaceId === "string" && command.spaceId.length > 0 ? command.spaceId : null;
      case "space.create":
        return typeof command.input?.name === "string" && command.input.name.trim().length > 0
          ? spaceIdFromName(command.input.name.trim().toLowerCase())
          : null;
      case "template.create":
      case "space.import":
        return typeof command.name === "string" && command.name.trim().length > 0
          ? spaceIdFromName(command.name.trim().toLowerCase())
          : null;
      default:
        return null;
    }
  }

  private spaceMutationFingerprint(spaceId: string): string {
    const space = this.spaceInventory.listSpaces().find((item) => item.id === spaceId) ?? null;
    return JSON.stringify({
      spaceId,
      space,
      plugins: space ? this.spaceInventory.readPlugins(spaceId) : [],
    });
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
    const id = this.spaceInventory.requireSpace(spaceId);
    if (this.runs.unmanaged.has(id) || this.spaceInventory.statusOf(id) !== "running") {
      throw new WorkbenchPublicError("workbench/not-found");
    }
    const port = this.processes?.portOf(id);
    if (!port) throw new WorkbenchPublicError("workbench/not-found");
    const epoch = this.stateModel.requireServiceEpoch();
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
    this.stateModel.assertLiveContext(parsedContext);
    return this.previewPlan(request);
  }

  /**
   * The preview body shared with the scoped control channel: removed kinds
   * are refused, protected ids are refused, local lifecycle requests go to
   * supervisor plans and the rest fall to maintenance. Callers perform their
   * own writable/context admission first.
   */
  private async previewPlan(request: WorkbenchPlanRequest): Promise<WorkbenchPlan> {
    if (REMOVED_PLAN_KINDS.has((request as { kind?: string }).kind ?? "")) {
      throw new WorkbenchPublicError("workbench/unsupported");
    }
    const parsed = parsePlanRequest(request);
    if (("spaceId" in parsed && parsed.spaceId === "desktop") ||
      ("spaceIds" in parsed && parsed.spaceIds.includes("desktop"))) {
      throw new WorkbenchPublicError("workbench/protected");
    }
    if (SUPERVISOR_PLAN_KINDS.has(parsed.kind)) {
      const activity = parsed.kind === "space.stop" || parsed.kind === "space.restart"
        ? await this.llmOps.observeTaskActivity(parsed.spaceId) : undefined;
      return this.supervisorPlans.previewLocal(parsed, activity);
    }
    if (!this.maintenance) throw new WorkbenchPublicError("workbench/maintenance");
    return this.maintenance.preview(parsed);
  }

  async product(request: WorkbenchProductRequest): Promise<Awaited<ReturnType<WorkbenchApi["product"]>>> {
    if (SPACES_BLUEPRINT_SEALED && isSpacesBlueprintMethod((request as { method?: string }).method ?? "")) {
      throw new WorkbenchPublicError("workbench/unsupported");
    }
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
    this.diagnosticLog.info("manager.initialize.started", "Manager initialization started.");
    this.spaceInventory.assertRegistryReadable();
    this.assertManagerBootstrapNotInterrupted();
    this.toolchain.bindToolchain();
    mkdirSync(this.controlDir, { recursive: true });
    const identity = await this.lease.ensureManager();
    this.diagnosticLog.info("manager.identity", "Manager identity allocated.", { manager: identity.profileId });
    this.managerId = identity.profileId;
    this.managerInstall = inspectManagerInstall(this.home, identity.profileId);
    this.jobs = new WorkbenchJobStore({ home: this.home, now: this.now, inject: this.options.jobsInject, diagnosticLog: this.diagnosticLog });
    this.processes = this.createProcessManager();
    this.diagnosticLog.debug("manager.process-runtime", "Manager process runtime created.");
    this.bindProductService();
    this.instances.reconcileInstanceRecords();
    if (this.maintenanceGate.hasMaintenanceEvidence() || this.lock.inspect().held || this.runs.unmanaged.size) {
      this.maintenance = this.maintenanceGate.createMaintenance();
      this.stateModel.refreshAvailability();
      const reasons = [
        ...(this.maintenanceGate.hasMaintenanceEvidence() || this.lock.inspect().held
          ? ["Unfinished Home maintenance journal is present."]
          : []),
        ...(this.runs.unmanaged.size ? ["Leftover processes were not adopted."] : []),
      ];
      this.startup.fail(reasons[0] ?? "The start failed.", "maintenance", { reasons });
      return;
    }
    if (this.managerInstall === "ordinary") {
      this.lifecycle.blocked = true;
      this.lifecycle.reasons = [
        "The reserved manager name already belongs to an ordinary profile. It was not overwritten.",
      ];
      this.stateModel.refreshAvailability();
      this.startup.fail(this.lifecycle.reasons[0] ?? "The reserved manager name already belongs to an ordinary profile. It was not overwritten.", "profile");
      return;
    }
    if (this.managerInstall === "damaged") {
      this.lifecycle.blocked = true;
      this.lifecycle.reasons = ["The manager profile record is damaged and was not rebuilt."];
      this.stateModel.refreshAvailability();
      this.startup.fail(this.lifecycle.reasons[0] ?? "The manager profile record is damaged and was not rebuilt.", "manager");
      return;
    }
    let managerDump: string | undefined;
    if (this.managerInstall === "missing") {
      if (!this.cli) {
        this.lifecycle.blocked = true;
        this.lifecycle.reasons = ["A compatible DSH CLI is required before the manager profile can be created."];
        this.stateModel.refreshAvailability();
        this.startup.fail(this.lifecycle.reasons[0] ?? "A compatible DSH CLI is required before the manager profile can be created.", "cli");
        return;
      }
      try {
        managerDump = await this.observeChildWork(() => this.bootstrapManager(identity.profileId));
        this.managerInstall = inspectManagerInstall(this.home, identity.profileId);
      } catch (error) {
        this.diagnosticLog.error("manager.bootstrap-failed", "Manager bootstrap failed; initialization evidence is retained.", error, { space: identity.profileId });
        this.lifecycle.blocked = true;
        this.lifecycle.managerBootstrapFailure = "Manager initialization did not complete.";
        this.lifecycle.reasons = [this.lifecycle.managerBootstrapFailure];
        this.startup.fail(error, "bootstrap", { reasons: [this.lifecycle.managerBootstrapFailure] });
        try {
          atomicWrite(join(this.controlDir, "manager-bootstrap-error.json"), `${JSON.stringify({
            version: 1, at: this.now().toISOString(),
            detail: sanitizeLogText(error instanceof Error ? error.message : String(error)).slice(0, 4000),
          })}\n`);
        } catch (diagnostic) {
          const detail = publicReason(diagnostic, "The diagnostic record could not be written.");
          const labelled = publicReason(`Diagnostic write: ${detail}`, "Diagnostic write: The diagnostic record could not be written.");
          this.lifecycle.addReason(labelled);
          this.startup.note(labelled);
        }
        return;
      }
    }
    const loader = this.managerId
      ? await this.toolchain.syncLoader(this.managerId, this.managerId === identity.profileId ? managerDump : undefined)
      : undefined;
    this.spaces = this.toolchain.createSpacesServiceWithLoader(loader);
    try {
      this.maintenance = this.maintenanceGate.createMaintenance();
    } catch (error) {
      this.diagnosticLog.error("manager.maintenance-compose-failed", "Maintenance could not be composed.", error);
      this.lifecycle.reasons.push("Maintenance could not be composed.");
    }
    if (this.managerInstall === "manager" && this.selectedPayload && this.toolchain.hasComponent("plugin")) {
      try {
        await this.toolchain.alignManagerPlugin(identity.profileId);
      } catch (error) {
        this.diagnosticLog.error("manager.align-failed", "Manager plugin alignment failed.", error, { space: identity.profileId });
        this.lifecycle.blocked = true;
        const detail = sanitizeLogText(error instanceof Error ? error.message : String(error)).slice(0, 400);
        this.lifecycle.managerStartFailure = `The manager plugin could not be aligned with the selected Spaces version. ${detail}`.trim();
        this.lifecycle.reasons.push(this.lifecycle.managerStartFailure);
        this.startup.fail(error, "align", {
          reasons: ["The manager plugin could not be aligned with the selected Spaces version."],
        });
      }
    }
    // Initialization and alignment have settled before admitting normal work,
    // including the initial manager start through the same writable boundary.
    this.lifecycle.initializing = false;
    this.stateModel.refreshAvailability();

    if (this.managerInstall === "manager" && this.cli && !this.lifecycle.blocked && !this.runs.unmanaged.has(identity.profileId)) {
      this.startup.starting();
      try {
        await this.spaceLifecycle.startSpace(identity.profileId, silentJobContext());
        this.startup.ready();
        if (this.options.startDesktopSpaces) await this.startDesktopSpaces();
      } catch (error) {
        this.diagnosticLog.error("manager.start-failed", "The management space did not become ready.", error, { space: identity.profileId });
        this.lifecycle.blocked = true;
        const failure = startupFailureFrom(error, "start");
        const status = this.processes?.statusOf(identity.profileId);
        const retained = failure.instanceRetained || status === "starting" || status === "running";
        this.lifecycle.addReason(failure.primaryReason);
        if (failure.cleanupReason) this.lifecycle.addReason(`Cleanup: ${failure.cleanupReason}`);
        this.lifecycle.addReason("The stable entry is still available.");
        this.startup.fail(error, "start", { instanceRetained: retained });
      }
    } else {
      const reason = this.lifecycle.reasons[0] ?? "The start failed.";
      this.startup.fail(reason, this.cli ? "prepare" : "cli", { reasons: this.lifecycle.reasons });
    }
  }

  /** One start for each ordinary space that chose to start with Desktop. */
  private async startDesktopSpaces(): Promise<void> {
    let spaces: WorkbenchSpace[];
    try {
      spaces = this.spaceInventory.listSpaces();
    } catch (error) {
      this.diagnosticLog.error("desktop-start.inventory-failed", "Desktop space startup could not read the space inventory.", error);
      return;
    }
    for (const space of spaces) {
      if (!space.startWithDesktop || space.isHost || !space.managed) continue;
      const status = this.spaceInventory.publicStatus(space.id);
      if (status !== "stopped" && status !== "crashed") continue;
      try {
        const jobs = this.jobs!;
        const job = await jobs.submit({ kind: "space.start", spaceId: space.id }, `desktop-start-${randomBytes(12).toString("hex")}`, async (ctx) => {
          this.lifecycle.assertWritable();
          const current = this.spaceInventory.publicStatus(space.id);
          if (current !== "stopped" && current !== "crashed") return;
          return this.spaceLifecycle.startSpace(space.id, ctx);
        });
        await jobs.whenIdle();
        if (jobs.job(job.id).status === "failed") {
          this.diagnosticLog.error("desktop-start.space-failed", "A space selected to start with Desktop did not start.", undefined, { space: space.id });
        }
      } catch (error) {
        this.diagnosticLog.error("desktop-start.space-failed", "A space selected to start with Desktop did not start.", error, { space: space.id });
      }
    }
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
    const epoch = this.stateModel.currentServiceEpoch();
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
    const initialize = async () => this.observeChildWork(() => diagnosticStep(this.diagnosticLog, "manager.bootstrap", { space: profileId }, async (): Promise<string | undefined> => {
      this.assertManagerBootstrapNotInterrupted();
      const existing = inspectManagerInstall(this.home, profileId);
      if (existing === "ordinary" || existing === "damaged") {
        throw new WorkbenchPublicError(
          "workbench/protected",
          "The reserved manager name already belongs to an ordinary profile. It was not overwritten.",
        );
      }
      if (existing === "manager") return undefined;
      const marker = join(this.controlDir, "manager-bootstrap.json");
      atomicWrite(marker, `${JSON.stringify({ version: 1, profileId })}\n`);
      // Clone the shipped preset directly into the dedicated manager. Reading
      // the shipped web profile through the CLI would materialize user defaults.
      if (existing === "missing") {
        const created = await this.toolchain.runBoundCli([
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
      const dump = await this.toolchain.readDump(profileId);
      if (dump) extractRoot(dump, SESSION_ROW_ID);
      if (this.toolchain.hasComponent("plugin")) {
        await this.toolchain.installComponent(profileId, "plugin");
      }
      if (this.toolchain.hasComponent("view-bridge")) {
        await this.toolchain.installComponent(profileId, "view-bridge");
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
    }));
    if (lockHeld) return await initialize();
    return await this.lock.run("bootstrap-manager", initialize);
  }

  private assertManagerBootstrapNotInterrupted(): void {
    const marker = join(this.controlDir, "manager-bootstrap.json");
    try {
      lstatSync(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    }
    const reason = "Manager initialization was interrupted. Its evidence was retained and the installation was not replayed.";
    this.lifecycle.managerBootstrapFailure = reason;
    this.lifecycle.addReason(reason);
    throw new WorkbenchPublicError("workbench/unavailable", reason);
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
            currentEpoch: this.stateModel.currentServiceEpoch(),
          }),
        };
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
          this.llmOps.attachChild(profile, child, this.runs.generation(profile), this.stateModel.currentServiceEpoch());
          this.spaceAttention.attachChild(profile, child, this.runs.generation(profile), this.stateModel.currentServiceEpoch());
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
              this.runs.spawned.delete(profile);
              this.instances.removeInstanceRecord(profile);
            }
          });
        } else child.once("error", () => {
          this.instances.removeInstanceRecord(profile);
        });
        return child;
      },
      ensureCli: injected.ensureCli ?? (async (profile) => this.toolchain.resolveCliBin(profile) ?? this.options.bin),
      // Managed profiles are already prepared independently. Even dump-config
      // can materialize files in the user's default web profile.
      prepareHome: injected.prepareHome ?? (async () => undefined),
      fetch: injected.fetch ?? this.fetchImpl,
      base: name => profileBase(this.home, name),
      kill: async (pid: number, kind: KillKind) => {
        if (kind === "kill") throw new Error(STOP_NOT_FORCED);
        if (injected.kill) return injected.kill(pid, "term");
        await children.stop(pid);
      },
      gracefulWaitMs: injected.gracefulWaitMs ?? COOPERATIVE_STOP_WAIT_MS,
      forceWaitMs: injected.forceWaitMs ?? 50,
    };
    const manager = new ProcessManager(
      this.home,
      this.patchWriter,
      this.options.portStart ?? 3100,
      this.options.portEnd ?? 3199,
      runtime,
      this.diagnosticLog,
    );
    // A space leaving "running" invalidates its UI automation session and
    // the open-time authorization together — the manager releases the page.
    manager.onStatus((name, status) => this.uiAutomation.spaceStatusChanged(name, status));
    manager.onStatus((name, status, extra) => {
      const input = { space: name, ...(extra?.port !== undefined ? { port: extra.port } : {}) };
      if (status === "crashed") this.diagnosticLog.error("space.status", "Space entered a failed state.", extra?.error, input);
      else this.diagnosticLog.info("space.status", "Space process status changed.", { ...input, status });
    });
    return manager;
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
      this.diagnosticLog.error("request.failed", "A workbench request failed.", error, { event, ...(code ? { code } : {}), ...currentOperationDetails() });
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

  private async runCommand(command: WorkbenchCommand, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void> {
    if (this.lifecycle.sealing) {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor is releasing run rights.");
    }
    switch (command.kind) {
      case "space.create":
        return this.spaceCommands.createSpace({...command.input,...command.input.modelSource===undefined&&!command.input.browser&&command.input.base!=='browser'?{modelSource:'main' as const}:{}}, ctx);
      case "space.update":
        return this.spaceCommands.updateSpace(command, ctx);
      case "space.reorder":
        return this.spaceCommands.reorderSpaces(command.spaceIds, ctx);
      case "space.start":
        return this.spaceLifecycle.startSpace(command.spaceId, ctx);
      case "plan.execute":
        return this.supervisorPlans.executePlan(command.planId, ctx);
      default:
        if (isWorkbenchProductCommand(command)) return this.runProductCommand(command, ctx);
        throw new WorkbenchPublicError("workbench/unsupported");
    }
  }

  private observeChildWork<T>(action: () => T): T {
    return withChildObservation(
      () => observeMaintenanceChild(this.home, () => {
        this.lifecycle.maintenanceBlocked = true;
      }),
      action,
    );
  }

  /**
   * The unary Remote client for one owned running child. Bound to the
   * (spaceId, generation, serviceEpoch) snapshot the caller authorized:
   * every call re-checks that binding and re-exchanges the session cookie.
   * Returns undefined when the child surface cannot be constructed — the
   * caller fails closed rather than guessing a transport.
   */
  private childRemoteClient(spaceId: string, generation?: number, serviceEpoch?: string): ChildRemoteClient | undefined {
    if (this.runs.unmanaged.has(spaceId)) return undefined;
    const gen = generation ?? this.runs.generation(spaceId);
    const epoch = serviceEpoch ?? this.stateModel.currentServiceEpoch();
    return new ChildRemoteClient(
      {
        statusOf: (id) => this.spaceInventory.statusOf(id),
        generationOf: (id) => this.runs.generation(id),
        spawned: (id) => this.runs.spawned.has(id),
        urlOf: (id) => this.processes?.urlOf(id),
        portOf: (id) => this.processes?.portOf(id),
        currentServiceEpoch: () => this.stateModel.currentServiceEpoch(),
        fetch: this.fetchImpl,
      },
      spaceId,
      gen,
      epoch,
    );
  }

  private dropWritable(): void {
    this.lifecycle.handle?.release(() => this.removeEndpointFile());
    this.lifecycle.handle = undefined;
    this.creator.retireRegistration();
    this.control.retireRegistration();
    this.jobs = undefined;
    this.processes = undefined;
    this.spaces = undefined;
    this.maintenance = null;
    this.products = null;
  }

  private async reinitializeManager(): Promise<void> {
    if (!this.cli) {
      this.cli = bindSelectedCli(this.options.bin);
    }
    if (this.cli) {
      const bindingPath = join(this.controlDir, "toolchain.json");
      const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
      atomicWrite(bindingPath, `${JSON.stringify({ ...binding, bin: this.cli.bin,
        dshVersion: this.cli.version, boundAt: this.now().toISOString() }, null, 2)}\n`);
    }
    setSelectedDshResolver((profile) => this.toolchain.resolveCliBin(profile));
    let managerDump: string | undefined;
    if (this.managerId) {
      this.managerInstall = inspectManagerInstall(this.home, this.managerId);
      if (this.managerInstall === "missing") {
        managerDump = await this.bootstrapManager(this.managerId, true);
        this.managerInstall = inspectManagerInstall(this.home, this.managerId);
      }
      if (this.managerInstall !== "manager") throw new WorkbenchPublicError("workbench/unavailable");
    }
    const loader = this.managerId ? await this.toolchain.syncLoader(this.managerId, managerDump) : undefined;
    this.spaces = this.toolchain.createSpacesServiceWithLoader(loader);
    if (this.managerId && this.managerInstall === "manager" && !this.runs.unmanaged.has(this.managerId)) {
      const runningWorkspaces = this.spaceInventory.ownedSpaceIds().filter(
        (id) => id !== this.managerId && this.spaceInventory.statusOf(id) === "running",
      );
      for (const id of runningWorkspaces) {
        await this.spaceLifecycle.stopOwned(id);
      }
      if (this.spaceInventory.statusOf(this.managerId) === "running") await this.spaceLifecycle.stopOwned(this.managerId);
      await this.spaceLifecycle.startSpace(this.managerId, silentJobContext());
    }
  }

  private bindProductService(): void {
    this.homeSettings = this.stateModel.readHomeSettings();
    this.products = new WorkbenchProductService({
      baseVersions: base => this.bases.versions(base),
      home: this.home,
      observation: () => this.stateModel.productObservation(),
      managerId: () => this.managerId,
      listSpaces: () => this.spaceInventory.listSpaces(),
      createSpace: (input, ctx) => this.spaceCommands.createSpace(input, ctx),
      installPlugin: async (spaceId, spec) => {
        const add = this.options.pluginAdd ?? pluginAdd;
        await add(this.home, spaceId, spec);
      },
      dshVersion: () => this.cli?.version ?? null,
      spacesVersion: () => {
        const version = this.selectedPayload?.manifest.version;
        return typeof version === "string" && version.length > 0 ? version : null;
      },
      runtimeBin: (spaceId) => (spaceId ? this.toolchain.resolveCliBin(spaceId) : (this.cli?.bin ?? this.options.bin)),
      inspectRuntime: (options) => inspectBlueprintRuntime(options),
      composeRuntime: (options, input) => composeBlueprintRuntime(options, input),
      resolveModule: (options, input) => resolveBlueprintModule(options, input),
      diagnostics: (spaceId) => this.maintenanceGate.productDiagnostics(spaceId),
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

  private async runProductCommand(
    command: WorkbenchProductCommand,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchJob["result"]> {
    if (!this.products) throw new WorkbenchPublicError("workbench/unavailable");
    if (command.kind === "plugin.download") setPackageSource(this.stateModel.readHomeSettings().packageSource);
    const outcome = await this.products.execute(command, ctx);
    const result = { product: outcome };
    ctx.result(result);
    return result;
  }

  private heldReasons(inspection: ReturnType<HomeLease["inspect"]>): string[] {
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

  private removeEndpointFile(): void {
    try {
      unlinkSync(join(this.controlDir, ENDPOINT_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
