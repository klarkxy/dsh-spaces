import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  CONTROL_CHANNEL_PREFIX,
  CONTROL_ERROR,
  CONTROL_FAILED_JOB_LIMIT,
  CONTROL_INSPECT_DEFAULT_SECTIONS,
  CONTROL_INSPECT_JOB_LIMIT,
  CONTROL_LIVE_PLAN_OPS,
  CONTROL_LOG_TAIL_DEFAULT,
  CONTROL_LOG_TAIL_MAX,
  CONTROL_OPS,
  CONTROL_OVERVIEW_BYTES,
  CONTROL_PLAN_LIMIT,
  CONTROL_PLAN_TTL_MS,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_READ_BYTES,
  CONTROL_TEMPLATE_LIMIT,
  CONTROL_TEMPLATE_PLUGIN_LIMIT,
  CONTROL_IMPORT_PREVIEW_BODY_LIMIT,
  ControlPublicError,
  parseControlExecuteInput,
  parseControlImportPreviewInput,
  parseControlJobInput,
  parseControlPlanInput,
  parseControlReadInput,
  parseControlUiActInput,
  parseControlUiCloseInput,
  parseControlUiEvalInput,
  parseControlUiOpenInput,
  parseControlUiSnapshotInput,
  parseControlUnregisterInput,
  type ControlContext,
  type ControlInspectResult,
  type ControlInspectDiagnostics,
  type ControlInspectModel,
  type ControlInspectRuntime,
  type ControlJobSummary,
  type ControlLogsResult,
  type ControlExecuteInput,
  type ControlOperation,
  type ControlOverviewResult,
  type ControlOverviewSpace,
  type ControlReadInput,
  type ControlReadResult,
  type ControlInspectSection,
  type ControlPlanInput,
  type ControlPlanResult,
  type ControlSectionResult,
  type ControlSpaceActivity,
  type ControlTemplateSummary,
  type ControlTemplatesResult,
  type ControlImportPreviewResult,
} from "../../../shared/control";
import {
  readLivePluginView,
  type ChildRemoteClient,
} from "./child-remote";
import {
  assertMutableRecipeSpaceName,
  canonicalNpmInstallSpec,
  recipeFromTemplate,
} from "../../../core/application/space-recipe";
import type { SpaceSharePlugin, SpaceSharePreview, SpaceTemplate } from "../../../shared/space-share";
import {
  CreatorPublicError,
  parseCreatorIssueInput,
  type CreatorIssueInput,
  type CreatorIssueResult,
  type CreatorUnregisterInput,
} from "../../../shared/creator";
import { PluginSourceError, parsePluginSource, pluginSourceSpecOf } from "../../../shared/plugin-source";
import type { WorkbenchDiagnostics } from "../../../shared/workbench-product";
import type {
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchSpace,
} from "../../../shared/workbench";
import type { WorkbenchProductCommand } from "../../../shared/workbench-product";
import type { DiagnosticLogEntry } from "../../../shared/diagnostics";
import { WorkbenchPublicError } from "./errors";
import { redactPublicReason } from "../../../shared/public-reason";
import { sanitizeLogText } from "../diagnostics/diagnostics";
import { projectSpaceCreations } from "../../../shared/space-host";
import { admitNativeRequest, ChannelBodyRejection, readChannelJsonBody } from "./native-request";
import type { MainChannelRegistration, SupervisorCreator } from "./creator";
import type { WorkbenchJobContext, WorkbenchJobStore } from "../maintenance/workbench-jobs";
import type { WorkbenchMaintenance } from "./types";
import type { UiAutomationManager } from "./ui-automation";

const ISSUE_OPS = new Set<ControlOperation>(["issue", "unregister"]);
const UNIMPLEMENTED_OPS = new Set<ControlOperation>(["session"]);

export interface SupervisorControlPorts {
  /** The registration owner: issue/unregister delegate to it; the control
   *  scope check and the registration view come from the same record. */
  creator: SupervisorCreator;
  origin(): string;
  now(): Date;
  /** The existing Host bearer (endpoint.json) — the issuer credential only. */
  hostBearerEquals(value: string): boolean;
  currentServiceEpoch(): string;
  stateRevision(): string;
  writable(): boolean;
  maintenance(): boolean;
  dshVersion(): string | null;
  jobs(): WorkbenchJobStore | undefined;
  /** Maintenance service for runtime catalog reads; absent when unavailable. */
  maintenanceService(): WorkbenchMaintenance | null;
  managerId(): string | null;
  /** All registered spaces including specials (filtered to ordinary inside). */
  listSpaces(): WorkbenchSpace[];
  /** requireSpace + managed-check resolution for one id. */
  requireSpace(spaceId: string): string;
  unmanaged(id: string): boolean;
  /** Space detail for the plugins section; may throw. */
  detail(spaceId: string): Promise<{ plugins: Array<{ name: string; version: string | null }> }>;
  /** Diagnostics projection for one space (logs included, trimmed inside). */
  diagnostics(spaceId: string): WorkbenchDiagnostics;
  /** Last observed task activity; must never throw for a stopped space. */
  observeTaskActivity(spaceId: string): Promise<ControlSpaceActivity>;
  /** Same admission the workbench submit path uses (writable + releasing checks). */
  admitSubmission(): void;
  /** Writable assertion run inside the serialized job handler. */
  assertWritable(): void;
  /** Epoch/revision CAS, same as assertLiveContext on the submit path. */
  assertLiveContext(context: WorkbenchMutationContext): void;
  /**
   * The supervisor preview body (parse + protect + freeze), shared with the
   * workbench `preview` dispatch; it must not re-assert a mutation context.
   */
  previewPlan(request: WorkbenchPlanRequest): Promise<WorkbenchPlan>;
  /**
   * Freeze a supervisor-local plan (space.models.sync, plugin.live.*): the
   * channel builds the request itself after its own strict parsing.
   */
  previewLocalPlan(request: WorkbenchPlanRequest): WorkbenchPlan;
  /** Execute a frozen supervisor lifecycle plan inside a running job. */
  executePlan(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void>;
  /** The owned space start the `space.start` command runs inside a job. */
  startSpace(spaceId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"]>;
  /** The template library for the `templates` read view and plan-time lookup. */
  templates(): SpaceTemplate[];
  /** Non-consuming read of one staged import (peek, not take). */
  stagedImport(importId: string): { expiresAt: string; preview: SpaceSharePreview };
  /** Stage one share archive; returns the one-shot importId and preview. */
  sharePreview(archiveBase64: string): Promise<{ importId: string; expiresAt: string; preview: SpaceSharePreview }>;
  /** Run a product command (template.create / space.import) inside a job. */
  runProductCommand(
    command: WorkbenchProductCommand,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchJob["result"]>;
  /**
   * A remote client bound to the space's frozen (spaceId, generation,
   * epoch): the child must still be the same owned running process or the
   * call refuses control/not-running. Absent when the child surface cannot
   * be constructed (plugin.live.* ops then fail closed).
   */
  childRemote(spaceId: string, generation: number, serviceEpoch: string): ChildRemoteClient | undefined;
  observeChildWork<T>(action: () => T): T;
  setActiveJob(id: string | undefined): void;
  /** Schedule the afterPlanJobSettled hook the submit path schedules for plan jobs. */
  afterPlanJobSettled(jobId: string): void;
  /** UI automation manager; absent when it could not be composed (engine ops then fail closed). */
  uiAutomation(): UiAutomationManager | undefined;
}

/** One frozen control plan, owned by the live main registration. */
interface StoredControlPlan {
  result: ControlPlanResult;
  registrationId: string;
  input: ControlPlanInput;
  /** The space the job acts on — derived from params.name for creation ops. */
  targetSpaceId: string;
  serviceEpoch: string;
  stateRevision: string;
  status: WorkbenchSpace["status"] | "missing";
  generation: number;
  activity: ControlSpaceActivity;
  /** Supervisor lifecycle plan id frozen for stop/restart/delete; "" for start/creation. */
  workbenchPlanId: string;
  /**
   * Creation ops only: digest of the frozen source (template recipe or
   * staged share plugin list). Recomputed at execute; drift consumes the
   * plan without submitting, like any other fingerprint change.
   */
  sourceDigest?: string;
  consumed: boolean;
  /** Why consumption failed after the plan was marked used. */
  submissionFailed?: string;
}

/**
 * The Control channel (/internal/control/v1/): a scoped channel for the
 * trusted main-space identity, sharing the Creator registration but gated by
 * its own scope. Read ops (context/read) and the two-stage mutation ops
 * (plan/execute/job) are implemented — lifecycle, plugin.install/
 * remove/toggle, runtime.set and the stopped-only models.sync;
 * `session` is a declared op that answers control/unsupported until its
 * phase lands.
 * Scope strings never appear in responses, job records or logs.
 */
export class SupervisorControl {
  /** Request ids of control jobs this registration submitted. */
  private readonly submissions = new Set<string>();
  /** Frozen single-use control plans held by this registration. */
  private readonly plans = new Map<string, StoredControlPlan>();
  private closed = false;

  constructor(private readonly ports: SupervisorControlPorts) {}

  private requireRegistration(): MainChannelRegistration {
    const registration = this.ports.creator.registrationView();
    if (!registration || this.closed) {
      throw new ControlPublicError("control/unavailable", "The control registration is not active.");
    }
    return registration;
  }

  async context(): Promise<ControlContext> {
    const registration = this.requireRegistration();
    const allJobs = this.ports.jobs()?.list() ?? [];
    return {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      serviceEpoch: registration.serviceEpoch,
      revision: this.ports.stateRevision(),
      writable: this.ports.writable(),
      maintenance: this.ports.maintenance(),
      busy: this.jobBusy(allJobs),
      dshVersion: this.ports.dshVersion(),
      spaces: await this.activitySnapshot(),
    };
  }

  private jobBusy(jobs: WorkbenchJob[] = this.ports.jobs()?.list() ?? []): boolean {
    return jobs.some((job) => job.status === "queued" || job.status === "running");
  }

  /** Registered ordinary spaces only: never the manager, web/desktop or unmanaged leftovers. */
  private ordinarySpaces(): WorkbenchSpace[] {
    const managerId = this.ports.managerId();
    return this.ports.listSpaces().filter((space) =>
      space.id !== "web" && space.id !== "desktop" && space.id !== managerId && !space.isHost &&
      !this.ports.unmanaged(space.id),
    );
  }

  /**
   * Resolve a target ordinary space or throw the public refusal. Reserved
   * profile ids (web/desktop/manager) are refused before registry lookup so
   * the answer never depends on whether such an entry happens to exist.
   */
  private requireTargetSpace(spaceId: string): string {
    if (spaceId === "web" || spaceId === "desktop" || spaceId === this.ports.managerId()) {
      throw new ControlPublicError("control/protected");
    }
    let id: string;
    try {
      id = this.ports.requireSpace(spaceId);
    } catch (error) {
      throw controlError(error);
    }
    if (this.ports.unmanaged(id)) {
      throw new ControlPublicError("control/not-found");
    }
    return id;
  }

  private async activitySnapshot(): Promise<Array<{ id: string; activity: ControlSpaceActivity }>> {
    const spaces = this.ordinarySpaces();
    const out: Array<{ id: string; activity: ControlSpaceActivity }> = [];
    for (const space of spaces) {
      out.push({ id: space.id, activity: await this.activityOf(space) });
    }
    return out;
  }

  private async activityOf(space: WorkbenchSpace): Promise<ControlSpaceActivity> {
    if (["stopped", "crashed"].includes(space.status)) return "idle";
    try {
      return await this.ports.observeTaskActivity(space.id);
    } catch {
      return "unknown"; // No telemetry is never evidence of idleness.
    }
  }

  async read(input: ControlReadInput): Promise<ControlReadResult> {
    this.requireRegistration();
    if (input.view === "overview") return { view: "overview", ...await this.overview() };
    if (input.view === "templates") return { view: "templates", ...this.templates() };
    const id = this.requireTargetSpace(input.spaceId!);
    if (input.view === "logs") return { view: "logs", ...this.logs(id, input.tail) };
    return { view: "inspect", ...await this.inspect(id, input.sections ?? [...CONTROL_INSPECT_DEFAULT_SECTIONS]) };
  }

  /**
   * The template library as a bounded public projection: id, name,
   * recipe source metadata and a per-template plugin summary. Rows and
   * plugin entries are dropped, never guessed, when the bound is hit.
   */
  private templates(): ControlTemplatesResult {
    const templates: ControlTemplateSummary[] = [];
    let truncated = false;
    const rows = this.ports.templates();
    if (rows.length > CONTROL_TEMPLATE_LIMIT) {
      truncated = true;
      rows.length = CONTROL_TEMPLATE_LIMIT;
    }
    for (const row of rows) {
      const plugins = row.recipe?.plugins ?? row.plugins;
      const overflow = plugins.length > CONTROL_TEMPLATE_PLUGIN_LIMIT;
      if (overflow) truncated = true;
      templates.push({
        id: row.id,
        name: row.name,
        displayName: row.displayName,
        createdAt: row.createdAt,
        ...(row.recipe?.source ? { source: { ...row.recipe.source } } : {}),
        plugins: plugins.slice(0, CONTROL_TEMPLATE_PLUGIN_LIMIT).map((plugin) => ({
          packageName: plugin.packageName,
          source: plugin.source,
          resolvedVersion: plugin.resolvedVersion,
          ...(plugin.installSpec !== undefined ? { installSpec: plugin.installSpec } : {}),
        })),
        hasConfig: Boolean(row.recipe?.patch),
      });
    }
    return { templates, truncated };
  }

  /**
   * `import.preview`: stage one base64 share archive in the product import
   * table. Content-only input — the channel never accepts a local path, so
   * there is nothing to normalize or confine. The staged id is one-shot and
   * epoch-bound exactly like the workbench surface.
   */
  async importPreview(input: { archiveBase64: string }): Promise<ControlImportPreviewResult> {
    this.requireRegistration();
    try {
      const staged = await this.ports.sharePreview(input.archiveBase64);
      return { importId: staged.importId, expiresAt: staged.expiresAt, preview: staged.preview };
    } catch (error) {
      throw controlError(error);
    }
  }

  private async overview(): Promise<ControlOverviewResult> {
    const registration = this.requireRegistration();
    const spaces: ControlOverviewSpace[] = [];
    for (const space of this.ordinarySpaces()) {
      spaces.push({
        id: space.id,
        displayName: space.displayName,
        status: space.status,
        generation: space.generation,
        dshVersion: space.dshVersion,
        activity: await this.activityOf(space),
      });
    }
    const allJobs = this.ports.jobs()?.list() ?? [];
    const failedJobs = allJobs
      .filter((job) => job.status === "failed")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, CONTROL_FAILED_JOB_LIMIT)
      .map((job) => publicJobSummary(job));
    let result: ControlOverviewResult = {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      serviceEpoch: registration.serviceEpoch,
      revision: this.ports.stateRevision(),
      writable: this.ports.writable(),
      maintenance: this.ports.maintenance(),
      busy: this.jobBusy(),
      dshVersion: this.ports.dshVersion(),
      spaces,
      creating: projectSpaceCreations(allJobs).map((row) => ({
        jobId: row.jobId,
        spaceId: row.spaceId,
        displayName: redactPublicReason(sanitizeLogText(row.displayName), 200),
        status: row.status,
        phase: redactPublicReason(sanitizeLogText(row.phase), 200),
        message: redactPublicReason(sanitizeLogText(row.message)),
        ...(row.error !== undefined ? { error: redactPublicReason(sanitizeLogText(row.error)) } : {}),
      })),
      failedJobs,
      truncated: false,
    };
    // Bound the response: drop the largest space rows until the projection
    // fits; a dropped tail is reported, never silently omitted.
    while (result.spaces.length && Buffer.byteLength(JSON.stringify(result), "utf8") > CONTROL_OVERVIEW_BYTES) {
      result.spaces = result.spaces.slice(0, -1);
      result.truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > CONTROL_OVERVIEW_BYTES) {
      result = { ...result, failedJobs: result.failedJobs.slice(0, 1), truncated: true };
    }
    return result;
  }

  private async inspect(spaceId: string, sections: readonly ControlInspectSection[]): Promise<ControlInspectResult> {
    const result: ControlInspectResult = { spaceId };
    const attempt = async <T>(action: () => Promise<T> | T): Promise<ControlSectionResult<T>> => {
      try {
        return { ok: true, value: await action() };
      } catch (error) {
        const mapped = error instanceof ControlPublicError ? error : controlError(error);
        return { ok: false, code: mapped.code, message: mapped.message };
      }
    };
    for (const section of sections) {
      if (section === "plugins") {
        result.plugins = await attempt(async () => (await this.ports.detail(spaceId)).plugins);
      } else if (section === "plugins.live") {
        result.pluginsLive = await attempt(async () => {
          const row = this.ordinarySpaces().find((space) => space.id === spaceId);
          if (!row || row.status !== "running") {
            throw new ControlPublicError("control/not-running");
          }
          const client = this.ports.childRemote(spaceId, row.generation, this.ports.currentServiceEpoch());
          if (!client) throw new ControlPublicError("control/unavailable", "The child remote surface is unavailable.");
          return await readLivePluginView(client);
        });
      } else if (section === "model") {
        result.model = await attempt((): ControlInspectModel => ({
          catalog: null,
          // The child model catalog is only readable inside the child
          // profile; the supervisor exposes it once the UI-automation or
          // in-space plugin surface can read it. Nothing is guessed here.
          catalogReason:
            "The child model catalog is only readable inside the child profile; " +
            "it stays unavailable until a UI-automation or in-space plugin surface can read it.",
        }));
      } else if (section === "runtime") {
        result.runtime = await attempt(async (): Promise<ControlInspectRuntime> => {
          const maintenance = this.ports.maintenanceService();
          const row = this.ordinarySpaces().find((space) => space.id === spaceId);
          return {
            dshVersion: row?.dshVersion ?? null,
            runtimes: maintenance ? await maintenance.runtimes() : null,
          };
        });
      } else if (section === "diagnostics") {
        result.diagnostics = await attempt((): ControlInspectDiagnostics => {
          const diagnostics = this.ports.diagnostics(spaceId);
          return {
            status: diagnostics.status,
            ...(diagnostics.lastError !== undefined ? { lastError: redactPublicReason(sanitizeLogText(diagnostics.lastError)) } : {}),
            ...(diagnostics.logError !== undefined ? { logError: redactPublicReason(sanitizeLogText(diagnostics.logError)) } : {}),
            backups: diagnostics.backups,
          };
        });
      } else if (section === "jobs") {
        result.jobs = await attempt((): ControlJobSummary[] => {
          const jobs = this.ports.jobs();
          if (!jobs) throw new ControlPublicError("control/read-only");
          return jobs.list()
            .filter((job) => job.affectedSpaceIds.includes(spaceId))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, CONTROL_INSPECT_JOB_LIMIT)
            .map((job) => publicJobSummary(job));
        });
      }
    }
    return result;
  }

  private logs(spaceId: string, tail?: number): Omit<ControlLogsResult, "view"> {
    const diagnostics = this.ports.diagnostics(spaceId);
    const limit = Math.min(tail ?? CONTROL_LOG_TAIL_DEFAULT, CONTROL_LOG_TAIL_MAX);
    const source = diagnostics.logs.slice(-limit);
    let entries: DiagnosticLogEntry[] = source.map((entry) => ({
      at: entry.at,
      channel: entry.channel,
      text: redactPublicReason(sanitizeLogText(entry.text)),
    }));
    let truncated = source.length < diagnostics.logs.length || entries.length !== source.length;
    // Keep the newest rows inside the byte cap; a single oversized entry is
    // cut by redactPublicReason already, so only row dropping is needed here.
    while (entries.length && Buffer.byteLength(JSON.stringify(entries), "utf8") > CONTROL_READ_BYTES) {
      entries = entries.slice(1);
      truncated = true;
    }
    if (entries.length !== source.length) truncated = true;
    return {
      spaceId,
      status: diagnostics.status,
      ...(diagnostics.logError !== undefined ? { logError: redactPublicReason(sanitizeLogText(diagnostics.logError)) } : {}),
      entries,
      truncated,
    };
  }

  /** Read only control jobs this registration submitted. */
  async job(jobId: string): Promise<WorkbenchJob> {
    this.requireRegistration();
    const jobs = this.ports.jobs();
    if (!jobs) throw new ControlPublicError("control/read-only");
    if (!this.submissions.has(jobId)) {
      throw new ControlPublicError("control/not-found");
    }
    return jobs.job(jobId);
  }

  /**
   * Validate and freeze a single-use plan bound to this registration.
   * Lifecycle ops (stop/restart/delete) freeze the same supervisor preview
   * the workbench two-stage flow produces; plugin.* and runtime.set freeze
   * the matching maintenance plan; models.sync is a supervisor-local
   * stopped-space-only plan; start is a direct command so the control plan
   * itself is the freeze, keeping the two-stage contract uniform.
   * Planning performs no mutation.
   */
  async plan(input: ControlPlanInput): Promise<ControlPlanResult> {
    const registration = this.requireRegistration();
    try {
      this.ports.admitSubmission();
    } catch (error) {
      throw controlError(error);
    }
    let spaceId: string;
    let status: WorkbenchSpace["status"] | "missing";
    let generation: number;
    let activity: ControlSpaceActivity;
    let affectedSpaceIds: string[];
    let changes: string[];
    let taskActivity: ControlSpaceActivity | undefined;
    let params: ControlPlanResult["params"];
    let workbenchPlanId = "";
    let sourceDigest: string | undefined;
    let displayName: string;
    if (input.op === "space.from-template" || input.op === "space.import") {
      // Creation ops: the target does not exist yet. The frozen observed
      // state is "missing" — a space that appears before execute is drift.
      const prepared = this.planCreation(input);
      spaceId = prepared.spaceId;
      displayName = prepared.displayName;
      affectedSpaceIds = [spaceId];
      changes = prepared.changes;
      params = prepared.params;
      sourceDigest = prepared.sourceDigest;
      status = "missing";
      generation = -1;
      activity = "unknown";
    } else {
      spaceId = this.requireTargetSpace(input.spaceId);
      const row = this.ordinarySpaces().find((space) => space.id === spaceId);
      if (!row) throw new ControlPublicError("control/not-found");
      activity = await this.activityOf(row);
      status = row.status;
      generation = row.generation;
      displayName = row.displayName;
      if (input.op === "start") {
        // A start affects only its target; the job runs startSpace directly and
        // the control plan itself is the freeze, keeping two-stage uniform.
        affectedSpaceIds = [spaceId];
        changes = ["space.start"];
      } else if (input.op === "models.sync") {
        // Stopped-only write: refuse here before freezing anything — the
        // channel never stops or restarts the space itself.
        if (row.status !== "stopped" && row.status !== "crashed") {
          throw new ControlPublicError(
            "control/conflict",
            `The space ${spaceId} is ${row.status}; plan a stop first, then sync its models.`,
          );
        }
        let preview: WorkbenchPlan;
        try {
          preview = this.ports.previewLocalPlan({ kind: "space.models.sync", spaceId });
        } catch (error) {
          throw controlError(error);
        }
        affectedSpaceIds = preview.affectedSpaceIds;
        changes = preview.changes;
        workbenchPlanId = preview.id;
      } else if (this.isLivePlanInput(input)) {
        // Running-space ops (path B): the child's own pluginManager writes its
        // profile. The space must be running now and stay the same generation
        // until the job runs; a stopped space must use the stopped-writer ops
        // (plugin.install/plugin.remove/plugin.toggle) instead.
        if (row.status !== "running") {
          throw new ControlPublicError(
            "control/conflict",
            `The space ${spaceId} is ${row.status}; ${input.op} requires a running space. ` +
            `Use plugin.install, plugin.remove or plugin.toggle for a stopped space.`,
          );
        }
        let preview: WorkbenchPlan;
        try {
          preview = this.ports.previewLocalPlan(this.livePlanRequest(input, spaceId));
        } catch (error) {
          throw controlError(error);
        }
        affectedSpaceIds = preview.affectedSpaceIds;
        changes = preview.changes;
        taskActivity = preview.taskActivity ?? activity;
        params = this.resultParams(input);
        workbenchPlanId = preview.id;
      } else if (input.op === "plugin.install" || input.op === "plugin.remove" ||
          input.op === "plugin.toggle" || input.op === "runtime.set") {
        const request = this.maintenanceRequest(input, spaceId);
        let preview: WorkbenchPlan;
        try {
          preview = await this.ports.previewPlan(request);
        } catch (error) {
          throw controlError(error);
        }
        affectedSpaceIds = preview.affectedSpaceIds;
        changes = preview.changes;
        taskActivity = preview.taskActivity ?? activity;
        params = this.resultParams(input);
        workbenchPlanId = preview.id;
      } else {
        const request: WorkbenchPlanRequest =
          input.op === "stop" ? { kind: "space.stop", spaceId } :
          input.op === "restart" ? { kind: "space.restart", spaceId } :
          { kind: "space.delete", spaceId, removeData: false };
        let preview: WorkbenchPlan;
        try {
          preview = await this.ports.previewPlan(request);
        } catch (error) {
          throw controlError(error);
        }
        affectedSpaceIds = preview.affectedSpaceIds;
        changes = preview.changes;
        taskActivity = preview.taskActivity;
        workbenchPlanId = preview.id;
      }
    }
    const serviceEpoch = registration.serviceEpoch;
    const stateRevision = this.ports.stateRevision();
    const fingerprint = JSON.stringify({
      input, serviceEpoch, stateRevision, sourceDigest,
      status, generation, activity, workbenchPlanId,
    });
    const result: ControlPlanResult = {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      controlPlanId: `${registration.registrationId}-${randomUUID()}`,
      fingerprint,
      op: input.op,
      spaceId,
      displayName,
      affectedSpaceIds,
      changes,
      ...(params !== undefined ? { params } : {}),
      ...(taskActivity !== undefined ? { taskActivity } : {}),
      expiresAt: new Date(this.ports.now().getTime() + CONTROL_PLAN_TTL_MS).toISOString(),
    };
    this.evictExpiredPlans();
    if (this.plans.size >= CONTROL_PLAN_LIMIT) {
      throw new ControlPublicError("control/unavailable", "Too many open plans; execute or wait for expiry.");
    }
    this.plans.set(result.controlPlanId, {
      result,
      registrationId: registration.registrationId,
      input,
      targetSpaceId: spaceId,
      serviceEpoch,
      stateRevision,
      status,
      generation,
      activity,
      workbenchPlanId,
      ...(sourceDigest !== undefined ? { sourceDigest } : {}),
      consumed: false,
    });
    return result;
  }

  /**
   * Submit a frozen plan as one serialized control job. requestId idempotency
   * is checked against the job store first: an identical replay returns the
   * original job even after the plan was consumed or expired; the same
   * requestId with a different plan conflicts. Epoch, revision and the
   * target's observed state are re-checked; a target that moved consumes the
   * plan without submitting, mirroring the creator consume semantics.
   */
  async execute(input: ControlExecuteInput): Promise<WorkbenchJob> {
    const registration = this.requireRegistration();
    const jobs = this.ports.jobs();
    if (!jobs) throw new ControlPublicError("control/read-only");
    try {
      this.ports.admitSubmission();
    } catch (error) {
      throw controlError(error);
    }
    const existing = jobs.commandOf(input.requestId);
    if (existing) {
      if (existing.kind === "control.execute" &&
          existing.controlPlanId === input.planId &&
          this.ownsPlanId(registration, existing.controlPlanId)) {
        return jobs.job(input.requestId);
      }
      throw new ControlPublicError("control/request-conflict");
    }
    const stored = this.plans.get(input.planId);
    if (!stored || !this.ownsPlanId(registration, input.planId) ||
        stored.registrationId !== registration.registrationId) {
      throw new ControlPublicError("control/not-found", "That plan was not found.");
    }
    if (stored.consumed) {
      throw stored.submissionFailed
        ? new ControlPublicError("control/plan-consumed", stored.submissionFailed)
        : new ControlPublicError("control/plan-consumed");
    }
    if (Date.parse(stored.result.expiresAt) <= this.ports.now().getTime()) {
      // A submitted plan reads back as consumed, not merely expired.
      stored.consumed = true;
      throw new ControlPublicError("control/plan-expired");
    }
    if (stored.serviceEpoch !== this.ports.currentServiceEpoch() ||
        stored.stateRevision !== this.ports.stateRevision()) {
      throw new ControlPublicError("control/request-conflict", "The plan target changed. Request a new plan.");
    }
    const observed = await this.observeTarget(stored.targetSpaceId);
    if (observed.status !== stored.status || observed.generation !== stored.generation ||
        observed.activity !== stored.activity) {
      // The target's observed state moved: the plan is consumed so a stale
      // approval can never be replayed, but nothing is submitted.
      stored.consumed = true;
      throw new ControlPublicError(
        "control/request-conflict",
        `The space's observed state changed since the plan was frozen (${stored.activity} → ${observed.activity}). Request a new plan.`,
      );
    }
    if (stored.sourceDigest !== undefined && stored.sourceDigest !== this.creationDigest(stored.input)) {
      // The frozen source (template recipe or staged share) moved or became
      // unavailable: consume the plan so the stale approval cannot run.
      stored.consumed = true;
      throw new ControlPublicError(
        "control/request-conflict",
        "The import source changed or expired since the plan was frozen. Request a new plan.",
      );
    }
    const expected = JSON.stringify({
      input: stored.input, serviceEpoch: stored.serviceEpoch, stateRevision: stored.stateRevision,
      sourceDigest: stored.sourceDigest,
      status: stored.status, generation: stored.generation, activity: stored.activity,
      workbenchPlanId: stored.workbenchPlanId,
    });
    if (expected !== stored.result.fingerprint) {
      throw new ControlPublicError("control/request-conflict", "The plan target changed. Request a new plan.");
    }
    // Consume then submit synchronously: accept() is synchronous, so no job
    // can interleave between the two. A submit failure is recorded on the
    // plan so a later execute reports the real reason — nothing is replayed.
    stored.consumed = true;
    const command: WorkbenchCommand = {
      kind: "control.execute",
      controlPlanId: input.planId,
      spaceId: stored.targetSpaceId,
    };
    let job: WorkbenchJob;
    try {
      job = await jobs.submit(command, input.requestId, (ctx) => {
        this.ports.setActiveJob(input.requestId);
        return this.ports.observeChildWork(async () => {
          try {
            this.ports.assertWritable();
            this.ports.assertLiveContext({
              serviceEpoch: this.ports.currentServiceEpoch(),
              expectedRevision: this.ports.stateRevision(),
            });
            if (stored.serviceEpoch !== this.ports.currentServiceEpoch() ||
                stored.stateRevision !== this.ports.stateRevision()) {
              throw new ControlPublicError("control/request-conflict", "The plan target changed. Request a new plan.");
            }
            return await this.runJob(stored, ctx);
          } finally {
            this.ports.setActiveJob(undefined);
          }
        });
      });
    } catch (error) {
      stored.submissionFailed = `The plan was consumed but its job could not be submitted: ${publicReasonOf(error)}`;
      throw controlError(error);
    }
    this.submissions.add(input.requestId);
    if (stored.workbenchPlanId) this.ports.afterPlanJobSettled(job.id);
    return job;
  }

  /**
   * The workbench plan request behind one plugin/runtime op. plugin.install
   * uses the exact-source variant (D4): the source is re-normalized so the
   * plan can never carry a raw spec.
   */
  private maintenanceRequest(
    input: Extract<ControlPlanInput, { op: 'plugin.install' | 'plugin.remove' | 'plugin.toggle' | 'runtime.set' }>,
    spaceId: string,
  ): WorkbenchPlanRequest {
    switch (input.op) {
      case 'plugin.install': {
        try {
          const plugin = parsePluginSource(input.params.source);
          return { kind: 'plugin.install.spec', spaceId, source: pluginSourceSpecOf(plugin) };
        } catch (error) {
          if (error instanceof PluginSourceError) {
            throw new ControlPublicError('control/invalid-input', error.message);
          }
          throw error;
        }
      }
      case 'plugin.remove':
        return { kind: 'plugin.remove', spaceId, packageName: input.params.packageName };
      case 'plugin.toggle':
        return { kind: 'plugin.toggle', spaceId, pluginId: input.params.packageName, enabled: input.params.enabled };
      case 'runtime.set':
        return { kind: 'space.runtime.set', spaceId, version: input.params.version };
    }
  }

  /** Type guard for the four running-space ops. */
  private isLivePlanInput(
    input: ControlPlanInput,
  ): input is Extract<ControlPlanInput, { op: 'plugin.live.install' | 'plugin.live.update' | 'plugin.live.entry' | 'plugin.live.remove' }> {
    return CONTROL_LIVE_PLAN_OPS.has(input.op);
  }

  /** The supervisor-local plan request behind one `plugin.live.*` op. */
  private livePlanRequest(
    input: Extract<ControlPlanInput, { op: 'plugin.live.install' | 'plugin.live.update' | 'plugin.live.entry' | 'plugin.live.remove' }>,
    spaceId: string,
  ): WorkbenchPlanRequest {
    switch (input.op) {
      case 'plugin.live.install': {
        try {
          const plugin = parsePluginSource(input.params.source);
          return { kind: 'plugin.live.install', spaceId, source: pluginSourceSpecOf(plugin) };
        } catch (error) {
          if (error instanceof PluginSourceError) {
            throw new ControlPublicError('control/invalid-input', error.message);
          }
          throw error;
        }
      }
      case 'plugin.live.update':
        return { kind: 'plugin.live.update', spaceId, packageName: input.params.packageName, version: input.params.version };
      case 'plugin.live.entry':
        return { kind: 'plugin.live.entry', spaceId, entryId: input.params.entryId, enabled: input.params.enabled };
      case 'plugin.live.remove':
        return { kind: 'plugin.live.remove', spaceId, packageName: input.params.packageName };
    }
  }

  /** The normalized params echoed back on the frozen plan (approval facts). */
  private resultParams(
    input: Extract<ControlPlanInput, { op: 'plugin.install' | 'plugin.remove' | 'plugin.toggle' | 'runtime.set' |
      'plugin.live.install' | 'plugin.live.update' | 'plugin.live.entry' | 'plugin.live.remove' }>,
  ): ControlPlanResult['params'] {
    switch (input.op) {
      case 'plugin.install':
      case 'plugin.live.install':
        return { source: parsePluginSource(input.params.source) };
      case 'plugin.remove':
      case 'plugin.live.remove':
        return { packageName: input.params.packageName };
      case 'plugin.toggle':
        return { packageName: input.params.packageName, enabled: input.params.enabled };
      case 'plugin.live.update':
        return { packageName: input.params.packageName, version: input.params.version };
      case 'plugin.live.entry':
        return { entryId: input.params.entryId, enabled: input.params.enabled };
      case 'runtime.set':
        return { version: input.params.version };
    }
  }

  /** The frozen plan's observed target state, re-read at execute time. */
  private async observeTarget(spaceId: string): Promise<{
    status: WorkbenchSpace["status"] | "missing";
    generation: number;
    activity: ControlSpaceActivity;
  }> {
    const row = this.ordinarySpaces().find((space) => space.id === spaceId);
    if (!row) return { status: "missing", generation: -1, activity: "unknown" };
    return { status: row.status, generation: row.generation, activity: await this.activityOf(row) };
  }

  /**
   * Inside the serialized job: run the command the control plan froze.
   * `plugin.live.*` kinds are supervisor-local plans like models.sync:
   * plans.executeLocal hands them to the child-remote runner bound to the
   * frozen (spaceId, generation, epoch) inside this same job lane, so a
   * child-side write can never overlap a supervisor-side write.
   */
  private async runJob(stored: StoredControlPlan, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void> {
    const input = stored.input;
    if (input.op === "start") {
      return await this.ports.startSpace(input.spaceId, ctx);
    }
    if (input.op === "space.from-template") {
      // Product command inside this serialized job: applySpaceRecipe creates
      // the definition, installs the auto-installable npm pins, and never
      // starts the space. A partial result keeps its scene; no cleanup that
      // would prove nothing is attempted.
      return await this.ports.runProductCommand(
        {
          kind: "template.create",
          templateId: input.params.templateId,
          name: input.params.name,
          ...(input.params.displayName !== undefined ? { displayName: input.params.displayName } : {}),
        },
        ctx,
      );
    }
    if (input.op === "space.import") {
      return await this.ports.runProductCommand(
        {
          kind: "space.import",
          importId: input.params.importId,
          name: input.params.name,
          ...(input.params.displayName !== undefined ? { displayName: input.params.displayName } : {}),
        },
        ctx,
      );
    }
    return await this.ports.executePlan(stored.workbenchPlanId, ctx);
  }

  /**
   * Plan-time validation and approval text for creation ops. Refuses here —
   * before any freeze — on an unknown template, an unavailable staged import,
   * a disallowed name or a name that is already taken. No mutation happens:
   * the staged import is only peeked, never consumed.
   */
  private planCreation(
    input: Extract<ControlPlanInput, { op: 'space.from-template' | 'space.import' }>,
  ): {
    spaceId: string;
    displayName: string;
    changes: string[];
    params: ControlPlanResult["params"];
    sourceDigest: string;
  } {
    // Reserved-name and syntax check shared with the product pipeline; the
    // product command re-checks it at execute time inside the job.
    try {
      assertMutableRecipeSpaceName(input.params.name);
    } catch (error) {
      throw new ControlPublicError("control/invalid-input", publicReasonOf(error));
    }
    const spaceId = `space-${input.params.name}`;
    if (spaceId === this.ports.managerId() || this.ports.unmanaged(spaceId)) {
      throw new ControlPublicError("control/protected", `The ${spaceId} space cannot be created through this channel.`);
    }
    if (this.ports.listSpaces().some((row) => row.id === spaceId)) {
      throw new ControlPublicError("control/conflict", `A space named ${spaceId} already exists.`);
    }
    let plugins: SpaceSharePlugin[];
    let displayName: string;
    let sourceDigest: string;
    if (input.op === "space.from-template") {
      const template = this.ports.templates().find((row) => row.id === input.params.templateId);
      if (!template) {
        throw new ControlPublicError("control/not-found", `The template ${input.params.templateId} was not found.`);
      }
      let recipe;
      try {
        recipe = recipeFromTemplate(template);
      } catch (error) {
        throw new ControlPublicError("control/unavailable", `The template ${input.params.templateId} could not be read: ${publicReasonOf(error)}`);
      }
      plugins = recipe.plugins;
      displayName = input.params.displayName || recipe.displayName;
      sourceDigest = stableDigest({ op: input.op, templateId: template.id, recipe });
    } else {
      let staged: { expiresAt: string; preview: SpaceSharePreview };
      try {
        staged = this.ports.stagedImport(input.params.importId);
      } catch (error) {
        throw new ControlPublicError("control/not-found", publicReasonOf(error));
      }
      plugins = staged.preview.plugins;
      displayName = input.params.displayName || staged.preview.manifest.space.displayName;
      sourceDigest = stableDigest({ op: input.op, importId: input.params.importId, preview: staged.preview });
    }
    const auto = plugins
      .map((plugin) => ({ plugin, spec: canonicalNpmInstallSpec(plugin) }))
      .filter((row): row is { plugin: typeof plugins[number]; spec: string } => row.spec !== null);
    const pending = plugins.filter((plugin) => canonicalNpmInstallSpec(plugin) === null);
    const changes = [
      `Create space ${spaceId}${displayName ? ` (${displayName})` : ""}; it is not started by this plan.`,
      ...(auto.length
        ? [`Install plugins: ${auto.map((row) => row.spec).join(", ")}.`]
        : []),
      ...(pending.length
        ? [`Pending manual (never auto-installed): ${pending.map((plugin) => plugin.packageName).join(", ")}.`]
        : []),
      // The import pipeline never writes the profile's pnpm build policy:
      // there is nothing to enumerate, so the plan states it explicitly
      // instead of refusing a build-script list that cannot be computed.
      "No build-script approvals are granted by this operation; the import pipeline never writes allowBuilds.",
    ];
    const params = input.op === "space.from-template"
      ? {
          templateId: input.params.templateId,
          name: input.params.name,
          ...(input.params.displayName !== undefined ? { displayName: input.params.displayName } : {}),
        }
      : {
          importId: input.params.importId,
          name: input.params.name,
          ...(input.params.displayName !== undefined ? { displayName: input.params.displayName } : {}),
        };
    return { spaceId, displayName, changes, params, sourceDigest };
  }

  /** Recompute the creation source digest at execute; "" means unavailable. */
  private creationDigest(input: ControlPlanInput): string {
    try {
      if (input.op === "space.from-template") {
        const template = this.ports.templates().find((row) => row.id === input.params.templateId);
        if (!template) return "";
        return stableDigest({ op: input.op, templateId: template.id, recipe: recipeFromTemplate(template) });
      }
      if (input.op === "space.import") {
        const staged = this.ports.stagedImport(input.params.importId);
        return stableDigest({ op: input.op, importId: input.params.importId, preview: staged.preview });
      }
    } catch {
      return "";
    }
    return "";
  }

  private ownsPlanId(registration: MainChannelRegistration, planId: string): boolean {
    return planId.startsWith(`${registration.registrationId}-`);
  }

  /**
   * ui.* dispatch: strict-parse first, then hand to the automation manager
   * with this registration's id so session ownership is enforced inside the
   * manager. The manager being absent fails closed — the space keeps its
   * honest "unavailable" answer rather than inventing a fallback engine.
   */
  private async ui(op: ControlOperation, input: unknown): Promise<unknown> {
    const registration = this.requireRegistration();
    const manager = this.ports.uiAutomation();
    if (!manager) throw new ControlPublicError("control/unavailable", "UI automation is not available on this supervisor.");
    switch (op) {
      case "ui.open":
        return manager.open(registration.registrationId, parseControlUiOpenInput(input).spaceId);
      case "ui.snapshot":
        return manager.snapshot(registration.registrationId, parseControlUiSnapshotInput(input));
      case "ui.act":
        return manager.act(registration.registrationId, parseControlUiActInput(input));
      case "ui.eval":
        return manager.eval(registration.registrationId, parseControlUiEvalInput(input));
      case "ui.close":
        return manager.close(registration.registrationId, parseControlUiCloseInput(input).uiSessionId);
      default:
        throw new ControlPublicError("control/unsupported");
    }
  }

  private evictExpiredPlans(): void {
    const now = this.ports.now().getTime();
    for (const [id, stored] of this.plans) {
      if (stored.consumed || Date.parse(stored.result.expiresAt) <= now) this.plans.delete(id);
    }
  }

  /** Issue/unregister delegate to the shared registration owner. */
  private async issue(input: CreatorIssueInput): Promise<CreatorIssueResult> {
    try {
      return await this.ports.creator.issue(input);
    } catch (error) {
      throw controlError(error);
    }
  }

  private unregister(input: CreatorUnregisterInput): { unregistered: true } {
    try {
      const result = this.ports.creator.unregister(input.registrationId);
      this.submissions.clear();
      this.plans.clear();
      return result;
    } catch (error) {
      throw controlError(error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.submissions.clear();
    this.plans.clear();
  }

  /** Run rights dropped: control submissions and plans die with the shared registration. */
  retireRegistration(): void {
    this.submissions.clear();
    this.plans.clear();
  }

  /**
   * HTTP boundary on the supervisor loopback listener. `issue`/`unregister`
   * require the Host bearer (same registration record as Creator); the
   * business operations require the issued control scope. Session cookies
   * and workspace origins are never accepted.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!req.url?.startsWith(CONTROL_CHANNEL_PREFIX)) return false;
    const op = req.url.slice(CONTROL_CHANNEL_PREFIX.length) as ControlOperation;
    const reply = (status: number, body: unknown): void => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(`${JSON.stringify(body)}\n`);
    };
    const deny = (status: number, code: string, message: string): void =>
      reply(status, { ok: false, error: { code, message } });
    const failOp = (error: unknown): void => {
      const mapped = error instanceof ControlPublicError ? error : controlError(error);
      deny(200, mapped.code, mapped.message);
    };
    try {
      if (!CONTROL_OPS.includes(op)) {
        deny(404, "workbench/not-found", "Unknown control operation.");
        return true;
      }
      const admission = admitNativeRequest(req, this.ports.origin(), "control");
      if (!admission.ok) {
        deny(admission.status, admission.code, admission.message);
        return true;
      }
      const token = admission.token!;
      let input: unknown;
      try {
        // import.preview carries one share archive: its body gets the share
        // bound (8 MiB base64 + envelope), every other op keeps 64 KiB.
        input = await readChannelJsonBody(
          req, "control",
          op === "import.preview" ? CONTROL_IMPORT_PREVIEW_BODY_LIMIT : undefined,
        );
      } catch (error) {
        if (error instanceof ChannelBodyRejection) {
          deny(200, "control/invalid-input", error.message);
        } else {
          deny(400, "workbench/invalid-input", "The request is not valid JSON.");
        }
        return true;
      }
      if (ISSUE_OPS.has(op)) {
        if (!this.ports.hostBearerEquals(token)) {
          deny(401, "workbench/unauthorized", "The control issuer requires the Host bearer.");
          return true;
        }
        try {
          if (op === "issue") {
            const result = await this.issue(parseCreatorIssueInput(input));
            reply(200, { ok: true, value: result });
          } else {
            const result = this.unregister(parseControlUnregisterInput(input));
            reply(200, { ok: true, value: result });
          }
        } catch (error) {
          failOp(error);
        }
        return true;
      }
      if (!this.ports.creator.controlScopeEquals(token)) {
        deny(401, "workbench/unauthorized", "The control scope is required.");
        return true;
      }
      if (UNIMPLEMENTED_OPS.has(op)) {
        deny(200, "control/unsupported", "That control operation is not implemented in this phase.");
        return true;
      }
      switch (op) {
        case "context":
          try {
            reply(200, { ok: true, value: await this.context() });
          } catch (error) {
            failOp(error);
          }
          return true;
        case "read":
          try {
            reply(200, { ok: true, value: await this.read(parseControlReadInput(input)) });
          } catch (error) {
            failOp(error);
          }
          return true;
        case "job":
          try {
            reply(200, { ok: true, value: await this.job(parseControlJobInput(input).jobId) });
          } catch (error) {
            failOp(error);
          }
          return true;
        case "import.preview":
          try {
            reply(200, { ok: true, value: await this.importPreview(parseControlImportPreviewInput(input)) });
          } catch (error) {
            failOp(error);
          }
          return true;
        case "plan":
          try {
            reply(200, { ok: true, value: await this.plan(parseControlPlanInput(input)) });
          } catch (error) {
            failOp(error);
          }
          return true;
        case "execute":
          try {
            reply(200, { ok: true, value: await this.execute(parseControlExecuteInput(input)) });
          } catch (error) {
            failOp(error);
          }
          return true;
        case "ui.open":
        case "ui.snapshot":
        case "ui.act":
        case "ui.eval":
        case "ui.close":
          try {
            reply(200, { ok: true, value: await this.ui(op, input) });
          } catch (error) {
            failOp(error);
          }
          return true;
        default:
          deny(404, "workbench/not-found", "Unknown control operation.");
          return true;
      }
    } catch {
      deny(500, "workbench/failed", "The control request failed.");
      return true;
    }
  }
}

/** Deterministic content digest for frozen creation sources (not security). */
function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** Public-safe error text: credentials and raw payloads never reach the wire. */
function publicReasonOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = redactPublicReason(sanitizeLogText(raw));
  if (!cleaned || cleaned === "[omitted credential material]" || cleaned === "[omitted chat payload]") {
    return "The control request failed.";
  }
  return cleaned;
}

/**
 * Map errors onto the closed control code set. Creator scope errors map to
 * their control twin (the ops share one registration); workbench errors map
 * by table; anything else is a sanitized control/failed.
 */
export function controlError(error: unknown): ControlPublicError {
  if (error instanceof ControlPublicError) return error;
  if (error instanceof CreatorPublicError) {
    const twin = error.code.replace(/^creator\//, "control/");
    if (twin in CONTROL_ERROR) {
      return new ControlPublicError(twin as keyof typeof CONTROL_ERROR, error.message);
    }
    return new ControlPublicError("control/unavailable", error.message);
  }
  if (error instanceof WorkbenchPublicError) {
    const map: Record<string, keyof typeof CONTROL_ERROR> = {
      "workbench/read-only": "control/read-only",
      "workbench/unavailable": "control/unavailable",
      "workbench/invalid-input": "control/invalid-input",
      "workbench/not-found": "control/not-found",
      "workbench/conflict": "control/request-conflict",
      "workbench/protected": "control/protected",
      "workbench/unsupported": "control/unsupported",
      "workbench/busy": "control/busy",
      "workbench/incompatible": "control/unavailable",
      "workbench/maintenance": "control/unavailable",
    };
    return new ControlPublicError(map[error.code] ?? "control/unavailable", publicReasonOf(error));
  }
  if (error instanceof Error) return new ControlPublicError("control/failed", publicReasonOf(error));
  return new ControlPublicError("control/failed");
}

/** Bounded, sanitized public projection of one stored job. */
function publicJobSummary(job: WorkbenchJob): ControlJobSummary {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    phase: redactPublicReason(sanitizeLogText(job.phase), 200),
    message: redactPublicReason(sanitizeLogText(job.message)),
    updatedAt: job.updatedAt,
    affectedSpaceIds: [...job.affectedSpaceIds],
    ...(job.error
      ? { error: { code: job.error.code, message: redactPublicReason(sanitizeLogText(job.error.message)) } }
      : {}),
  };
}


