/**
 * The job tracking of the workbench client.
 *
 * This part owns what happens to a job: how it joins the state, which product
 * outcome it carries and when a created space is entered automatically. The
 * code moves unchanged from `workbench/store.ts`.
 */

import type { WorkbenchJob, WorkbenchState } from "../../../../../../src/shared/workbench";
import { projectSpaceCreations, type PortalCreation } from "../../../../../../src/shared/space-host";
import { ACTIVE_JOB, CREATE_JOB } from "../constants";
import { importSpaceId } from "../errors";
import { RequestPart } from "./requests";

export abstract class JobPart extends RequestPart {
  protected mergeJob(job: WorkbenchJob): void {
    const state = this.ui.state;
    if (!state) return;
    const jobs = state.jobs.filter((item) => item.id !== job.id);
    jobs.unshift(job);
    if (ACTIVE_JOB.has(job.status) && CREATE_JOB.has(job.kind)) this.watchedCreates.add(job.id);
    this.patch({ state: { ...state, jobs } });
    this.noteCreated(job);
    this.onProductJob(job);
  }

  protected onProductJob(job: WorkbenchJob): void {
    if (job.kind === "blueprint.apply") this.blueprint.onApplyJob(job);
    if (ACTIVE_JOB.has(job.status)) return;
    for (const [key, requestId] of [...this.intentRequestIds.entries()]) {
      if (requestId === job.requestId) this.intentRequestIds.delete(key);
    }
    if (this.handledProductJobs.has(job.id)) return;
    this.handledProductJobs.add(job.id);
    const product = job.result?.product;
    const resultSpaceId = job.result?.spaceId;
    if (job.status === "succeeded" && (job.kind === "plan.execute" || job.kind === "control.execute") &&
        this.ui.detailSpaceId && (this.ui.detailSpaceId === resultSpaceId || job.affectedSpaceIds.includes(this.ui.detailSpaceId))) {
      // Offline plugin plans can finish without a result payload. Their target
      // inventory still needs to refresh, just like a completed live change.
      void this.loadDetail(this.ui.detailSpaceId);
      if (!job.result?.pluginApplication) void this.searchPlugins(this.ui.pluginQuery);
    }
    if (job.status === "succeeded" && job.result?.pluginApplication) {
      const application = job.result.pluginApplication;
      const rawTargets = application === "restart-required"
        ? (job.result.restartRequiredSpaceIds?.length
            ? job.result.restartRequiredSpaceIds
            : job.result.spaceId ? [job.result.spaceId] : job.affectedSpaceIds)
        : (job.result.spaceId ? [job.result.spaceId] : job.affectedSpaceIds);
      const spaceIds = [...new Set(rawTargets.filter(Boolean))];
      if (spaceIds.length > 0) {
        this.patch({ pluginOutcomeNotice: { jobId: job.id, application, spaceIds } });
      }
      if (this.ui.detailSpaceId) {
        void this.searchPlugins(this.ui.pluginQuery);
        if (!resultSpaceId && (spaceIds.includes(this.ui.detailSpaceId) || job.affectedSpaceIds.includes(this.ui.detailSpaceId))) {
          void this.loadDetail(this.ui.detailSpaceId);
        }
      }
    }
    if (product) this.patch({ lastProductOutcome: product });
    if (job.status === "succeeded" && product?.kind === "settings.update") {
      const draft = this.ui.settingsDraft;
      const submitted = this.submittedSettingsJson;
      this.submittedSettingsJson = null;
      const newerEdit = Boolean(draft && submitted && JSON.stringify(draft.settings) !== submitted);
      if (draft && !newerEdit) {
        this.patch({
          settingsDraft: {
            settings: product.settings,
            saved: product.settings,
            observation: draft.observation,
            dirty: false,
          },
          settingsStatus: "idle",
        });
        void this.loadSettings();
      }
    } else if (job.status === "succeeded") {
      if (job.kind === "catalog.refresh" || product?.kind === "catalog.refresh") {
        this.patch({ catalogStatus: "idle" });
        if (this.ui.homeTab === "plugins" || this.ui.detailSpaceId) void this.loadCatalog(this.ui.pluginQuery);
      }
      if (
        job.kind === "plugin.download" ||
        job.kind === "plugin.library.remove" ||
        product?.kind === "plugin.download" ||
        product?.kind === "plugin.library.remove"
      ) {
        this.patch({ libraryStatus: "idle" });
        if (this.ui.homeTab === "plugins") void this.loadLibrary();
      }
      if (
        job.kind === "template.save" ||
        job.kind === "template.delete" ||
        job.kind === "template.create" ||
        job.kind === "space.import" ||
        product?.kind === "template.save" ||
        product?.kind === "template.delete" ||
        product?.kind === "template.create" ||
        product?.kind === "space.import"
      ) {
        this.patch({ templatesStatus: "idle" });
        if (this.ui.homeTab === "templates" || this.ui.overlay?.type === "create") void this.loadTemplates();
      }
    }
  }

  protected noteCreated(job: WorkbenchJob, historical = false): void {
    const spaceId = job.result?.spaceId ?? importSpaceId(job.result?.product);
    if (!CREATE_JOB.has(job.kind) || job.status !== "succeeded" || !spaceId || historical) return;
    if (this.notedCreates.has(job.id)) return;
    this.notedCreates.add(job.id);
    this.patch({ createdNotice: { spaceId } });
    this.armAutoEnter(job, spaceId);
  }

  /**
   * Plan section 4: a space created from this client is entered directly.
   *
   * The request id decides whether this client sent the create at all, and the
   * navigation intent decides whether the user has moved somewhere else since.
   * A create from another client, or a user who navigated away in the
   * meantime, keeps the notice and the explicit "enter" action.
   */
  private armAutoEnter(job: WorkbenchJob, spaceId: string): void {
    if (job.kind !== "space.create") return;
    const submitted = this.submittedCreates.get(job.requestId);
    if (!submitted) return;
    this.submittedCreates.delete(job.requestId);
    if (!submitted.autoEnter) return;
    this.pendingAutoEnter = { spaceId: spaceId || submitted.spaceId, intent: submitted.intent };
  }

  /** Enter the created space once it exists in the current state. */
  protected flushAutoEnter(state: WorkbenchState): void {
    const pending = this.pendingAutoEnter;
    if (!pending) return;
    if (!state.spaces.some((space) => space.id === pending.spaceId)) return;
    this.pendingAutoEnter = null;
    if (this.navigationIntent !== pending.intent) return;
    if (this.ui.selected === pending.spaceId) return;
    // The settings surface must not cover the space that is entered.
    this.patch({ overlay: null });
    this.selectSpace(pending.spaceId);
  }

  hasActiveJobs(): boolean {
    return (this.ui.state?.jobs ?? []).some((job) => ACTIVE_JOB.has(job.status));
  }

  /** Creation placeholders for the rail: all active, plus failed ones seen while active and not dismissed. */
  visibleCreations(): PortalCreation[] {
    return projectSpaceCreations(this.ui.state?.jobs ?? []).filter((creation) =>
      creation.status !== "failed" || (this.watchedCreates.has(creation.jobId) && !this.dismissedCreations.has(creation.jobId)));
  }

  dismissCreation(jobId: string): void {
    this.dismissedCreations.add(jobId);
    this.patch(this.ui.overlay?.type === "creation-failed" && this.ui.overlay.jobId === jobId ? { overlay: null } : {});
  }

  openCreation(creation: PortalCreation): void {
    if (creation.status === "failed") {
      this.patch({ overlay: { type: "creation-failed", jobId: creation.jobId } });
      return;
    }
    this.selectHome();
    this.setHomeTab("overview");
  }

  dismissPluginOutcome = (spaceId?: string): void => {
    const current = this.ui.pluginOutcomeNotice;
    if (!current) return;
    if (!spaceId) {
      this.patch({ pluginOutcomeNotice: null });
      return;
    }
    const spaceIds = current.spaceIds.filter((id) => id !== spaceId);
    this.patch({ pluginOutcomeNotice: spaceIds.length > 0 ? { ...current, spaceIds } : null });
  };

  restartFromPluginOutcome = (spaceId: string): void => {
    this.dismissPluginOutcome(spaceId);
    this.preview({ kind: "space.restart", spaceId });
  };
}
