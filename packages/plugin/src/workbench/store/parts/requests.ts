/**
 * The API calls of the workbench client.
 *
 * This part owns the request side: the preview of a plan, the submit of a
 * command, the polling loop and the busy accounting around them. The code
 * moves unchanged from `workbench/store.ts`.
 */

import type { WorkbenchCommand, WorkbenchJob, WorkbenchPlanRequest } from "../../../../../../src/shared/workbench";
import type { WorkbenchMutationContext } from "../../../../../../src/shared/workbench";
import type { WorkbenchProductObservation } from "../../../../../../src/shared/workbench-product";
import { localizeError } from "../../i18n";
import { ACTIVE_JOB, AUTO_CONFIRM_KINDS } from "../constants";
import { errorCode, intentKey } from "../errors";
import { workbenchRequestOrigin } from "../origin";
import { pollDelayMs } from "../polling";
import type { SubmitOptions } from "../types";
import { CommandPart } from "./commands";

export abstract class RequestPart extends CommandPart {
  preview = (request: WorkbenchPlanRequest): void => {
    if (!this.canMutate()) {
      this.rejectReadonly();
      return;
    }
    if (request.kind === "space.delete" && this.isManagerId(request.spaceId)) {
      this.patch({ planError: this.msg("app.managerProtected"), pendingPlan: null });
      return;
    }
    if (
      (request.kind === "plugin.install" || request.kind === "plugin.toggle") &&
      this.touchesManagerPlugins(request)
    ) {
      this.patch({ planError: this.msg("app.managerProtected"), pendingPlan: null });
      return;
    }
    void this.runPreview(request);
  };

  confirmPlan = (): void => {
    const pending = this.ui.pendingPlan;
    if (!pending) {
      this.patch({ planError: this.msg("app.noPlan"), requestOrigin: null });
      return;
    }
    // The plan takes the stage, so the failure of its execution is global.
    this.patch({ pendingPlan: null, overlay: null, requestOrigin: null });
    if (pending.request.kind === "service.shutdown") {
      void this.submitShutdown(pending.plan.id);
      return;
    }
    void this.submit({ kind: "plan.execute", planId: pending.plan.id }, { origin: null });
  };

  cancelJob = (id: string): void => {
    const job = this.ui.state?.jobs.find((item) => item.id === id);
    if (!job?.canCancel) return;
    const cycle = this.cycle;
    void this.wrap(async () => {
      const next = await this.api.cancel(id);
      if (!this.stillOpen(cycle)) return;
      this.mergeJob(next);
    });
  };

  poll = async (): Promise<void> => {
    if (this.shutdownRequested || this.stateReadFailed) return;
    const cycle = this.cycle;
    const generation = ++this.stateGeneration;
    try {
      const state = await this.api.state();
      if (this.stateReadFailed || this.shutdownRequested || !this.stillOpen(cycle) || generation !== this.stateGeneration) return;
      this.applyState(state);
      if (this.running && !this.stateReadFailed) this.schedulePoll();
    } catch (error) {
      if (!this.stillOpen(cycle) || generation !== this.stateGeneration) return;
      this.stateReadFailed = true;
      if (this.pollTimer !== null) this.env.clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.patch({
        boot: this.ui.state || this.ui.frames.length > 0 ? "ready" : "error",
        error: localizeError(this.ui.locale, errorCode(error)),
      });
    }
  };

  private async runPreview(request: WorkbenchPlanRequest): Promise<void> {
    const context = this.mutationContext();
    const origin = workbenchRequestOrigin(this.ui, request);
    if (!context) {
      this.patch({
        pendingPlan: null,
        planError: localizeError(this.ui.locale, "workbench/unsupported"),
        commandPending: this.wrapDepth > 0,
        requestOrigin: origin,
      });
      return;
    }
    const cycle = this.cycle;
    // A preview holds a busy slot in the same accounting as wrap(): a read
    // that finishes while the preview is still in flight must not clear it.
    this.wrapDepth += 1;
    this.patch({ planError: null, pendingPlan: null, commandPending: true, requestOrigin: origin });
    try {
      const plan = await this.api.preview(request, context);
      if (!this.stillOpen(cycle)) return;
      // D1: a non-destructive stop or restart runs from its preview. Every
      // other kind, and every destructive plan, still asks for a confirmation.
      if (AUTO_CONFIRM_KINDS.has(request.kind) && !plan.destructive && plan.taskActivity === "idle") {
        // The plan takes the stage, so the failure of its execution is global.
        this.patch({ pendingPlan: null, planError: null, commandPending: this.wrapDepth - 1 > 0, overlay: null, requestOrigin: null });
        void this.submit({ kind: "plan.execute", planId: plan.id }, { origin: null });
        return;
      }
      this.patch({ pendingPlan: { request, plan }, planError: null, commandPending: this.wrapDepth - 1 > 0, overlay: null, requestOrigin: null });
    } catch (error) {
      if (!this.stillOpen(cycle)) return;
      // The surface that started the preview stays open, so the reason of the
      // failed preview stays next to the control that caused it.
      this.patch({
        pendingPlan: null,
        planError: localizeError(this.ui.locale, errorCode(error)),
        commandPending: this.wrapDepth - 1 > 0,
      });
    } finally {
      this.wrapDepth = Math.max(0, this.wrapDepth - 1);
    }
  }

  /** The surface that owns the failure of a rename or an icon change. */
  protected updateOrigin(spaceId: string): string | null {
    if (this.ui.overlay?.type === "rename") return "rename";
    if (this.ui.overlay?.type === "icon") return "icon";
    return workbenchRequestOrigin(this.ui, { kind: "space.update", spaceId });
  }

  protected async submitBlueprintApply(
    planId: string,
    observation: WorkbenchProductObservation,
  ): Promise<void> {
    if (!this.canMutate()) {
      this.rejectReadonly();
      throw Object.assign(new Error("workbench/read-only"), { code: "workbench/read-only" });
    }
    const command: WorkbenchCommand = { kind: "blueprint.apply", planId };
    const key = intentKey(command);
    if (this.intentInflight.has(key)) return;
    const requestId = this.intentRequestIds.get(key) ?? this.env.uuid();
    this.intentRequestIds.set(key, requestId);
    this.intentInflight.add(key);
    this.blueprint.trackApplyRequest(planId, requestId);
    const cycle = this.cycle;
    const requestSurface = this.requestSurface;
    try {
      const job = await this.api.submit(command, requestId, observation);
      if (!this.stillOpen(cycle)) return;
      this.mergeJob(job);
      this.noteCreated(job);
      this.onProductJob(job);
      if (!ACTIVE_JOB.has(job.status)) this.intentRequestIds.delete(key);
      await this.poll();
    } catch (error) {
      if (!this.stillOpen(cycle)) return;
      if (requestSurface === this.requestSurface) {
        this.patch({ commandError: localizeError(this.ui.locale, errorCode(error)) });
      }
      throw error;
    } finally {
      this.intentInflight.delete(key);
    }
  }

  protected async submit(command: WorkbenchCommand, options: SubmitOptions = {}): Promise<void> {
    if (!this.canMutate()) {
      this.rejectReadonly();
      return;
    }
    const context = options.context ?? this.mutationContext();
    const origin = options.origin === undefined ? workbenchRequestOrigin(this.ui, command) : options.origin;
    if (!context) {
      this.patch({ commandError: localizeError(this.ui.locale, "workbench/unsupported"), requestOrigin: origin });
      return;
    }
    const key = intentKey(command);
    if (this.intentInflight.has(key)) return;
    const requestId = this.intentRequestIds.get(key) ?? this.env.uuid();
    this.intentRequestIds.set(key, requestId);
    this.intentInflight.add(key);
    if (command.kind === "space.create") {
      this.submittedCreates.set(requestId, {
        spaceId: command.input.name,
        intent: this.navigationIntent,
        autoEnter: options.autoEnter !== false,
      });
    }
    const cycle = this.cycle;
    this.patch({ requestOrigin: origin });
    try {
      await this.wrap(async () => {
        const job = await this.api.submit(command, requestId, context);
        if (!this.stillOpen(cycle)) return;
        this.mergeJob(job);
        this.noteCreated(job);
        this.onProductJob(job);
        if (!ACTIVE_JOB.has(job.status)) this.intentRequestIds.delete(key);
        options.onJob?.(job);
        await this.poll();
      });
    } finally {
      this.intentInflight.delete(key);
    }
  }

  private async submitShutdown(planId: string): Promise<void> {
    const context = this.mutationContext();
    if (!context || !this.canMutate()) { this.rejectReadonly(); return; }
    const requestId = this.env.uuid(), cycle = this.cycle;
    this.shutdownRequested = true;
    this.stateGeneration++;
    if (this.pollTimer !== null) this.env.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const unconfirmed = this.ui.locale === "en"
      ? "Shutdown was requested. This view may close before the result is confirmed. The request has not been resent."
      : "已请求停止服务。此页面可能在结果确认前关闭；当前结果尚未确认，没有重新发送请求。";
    this.patch({ commandPending: true, commandError: unconfirmed, error: null, requestOrigin: null });
    try {
      const job = await this.api.submit({ kind: "plan.execute", planId }, requestId, context);
      if (!this.stillOpen(cycle)) return;
      this.mergeJob(job);
      if (job.status === "failed" || job.status === "cancelled") {
        this.shutdownRequested = false;
        this.patch({ commandError: localizeError(this.ui.locale, job.error ?? { code: "workbench/failed" }) });
        this.schedulePoll();
      } else if (job.status === "succeeded") {
        this.patch({ commandError: null });
      } else {
        await this.watchShutdownJob(job.id, cycle);
      }
    } catch (error) {
      if (!this.stillOpen(cycle)) return;
      if (errorCode(error).code) {
        this.shutdownRequested = false;
        this.patch({ commandError: localizeError(this.ui.locale, errorCode(error)) });
        this.schedulePoll();
      }
    } finally {
      if (this.stillOpen(cycle)) this.patch({ commandPending: false });
    }
  }

  /**
   * A queued or running shutdown job keeps its unconfirmed notice while the
   * job is read — never resubmitted — until it settles. A read failure keeps
   * the notice too: the service may already be gone, so the generic
   * state-read error page would misreport the outcome.
   */
  private async watchShutdownJob(jobId: string, cycle: number): Promise<void> {
    while (this.stillOpen(cycle) && this.shutdownRequested) {
      await new Promise<void>((resolve) => {
        this.env.setTimeout(resolve, pollDelayMs(true, this.env.hidden()));
      });
      if (!this.stillOpen(cycle) || !this.shutdownRequested) return;
      let job: WorkbenchJob;
      try {
        job = await this.api.job(jobId);
      } catch {
        return;
      }
      if (!this.stillOpen(cycle)) return;
      this.mergeJob(job);
      if (!ACTIVE_JOB.has(job.status)) {
        if (job.status === "succeeded") {
          this.patch({ commandError: null });
        } else {
          this.shutdownRequested = false;
          this.patch({ commandError: localizeError(this.ui.locale, job.error ?? { code: "workbench/failed" }) });
          this.schedulePoll();
        }
        return;
      }
    }
  }

  private mutationContext(): WorkbenchMutationContext | null {
    const state = this.ui.state;
    if (!state || state.protocolVersion !== 2) return null;
    if (!state.serviceEpoch || !state.revision) return null;
    return { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision };
  }

  private touchesManagerPlugins(request: WorkbenchPlanRequest): boolean {
    if (request.kind === "plugin.install") {
      return request.spaceIds.some((id) => this.isManagerId(id));
    }
    if (request.kind === "plugin.toggle") return this.isManagerId(request.spaceId);
    return false;
  }

  protected schedulePoll(): void {
    if (!this.running || this.shutdownRequested || this.stateReadFailed) return;
    if (this.pollTimer !== null) this.env.clearTimeout(this.pollTimer);
    const active = (this.ui.state?.jobs ?? []).some((job) => ACTIVE_JOB.has(job.status));
    const delay = pollDelayMs(active, this.env.hidden());
    this.pollTimer = this.env.setTimeout(() => {
      void this.poll();
    }, delay);
  }
}
