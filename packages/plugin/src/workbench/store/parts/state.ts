/**
 * The state of the workbench client.
 *
 * This part owns the transition from one observed state to the next: what the
 * state does to the view session, to the selection and to the tracked jobs.
 * The code moves unchanged from `workbench/store.ts`.
 */

import type { WorkbenchSpace, WorkbenchState } from "../../../../../../src/shared/workbench";
import { localizeError } from "../../i18n";
import { ACTIVE_JOB, CREATE_JOB } from "../constants";
import { WorkbenchCore } from "../core";

export abstract class StatePart extends WorkbenchCore {
  protected applyState(state: WorkbenchState): void {
    ++this.stateObservation;
    const previousEpoch = this.ui.state?.serviceEpoch;
    const epochChanged = previousEpoch !== undefined && previousEpoch !== state.serviceEpoch;
    const epochDestroyed = this.views.syncServiceEpoch(state.serviceEpoch);
    const destroyed = this.views.syncGenerations(state.spaces);
    for (const spaceId of [...epochDestroyed, ...destroyed]) {
      for (const key of [...this.iframeWindows.keys()]) {
        if (key.startsWith(`${spaceId}:`)) this.iframeWindows.delete(key);
      }
    }
    let selected = this.ui.selected;
    const noticeId = this.ui.createdNotice?.spaceId;
    const noticeRemoved = Boolean(noticeId && this.ui.state?.spaces.some(space => space.id === noticeId) &&
      !state.spaces.some(space => space.id === noticeId));
    const selectedWasRemoved = selected !== "home" && !state.spaces.some((space) => space.id === selected);
    if (selectedWasRemoved) {
      selected = "home";
      this.views.commitHome();
    }
    const pluginSpaceId =
      this.ui.pluginSpaceId && state.spaces.some((space) => space.id === this.ui.pluginSpaceId)
        ? this.ui.pluginSpaceId
        : this.workspaceSpacesFrom(state)[0]?.id ?? "";
    const templateSpaceId =
      this.ui.templateSpaceId && state.spaces.some((space) => space.id === this.ui.templateSpaceId)
        ? this.ui.templateSpaceId
        : pluginSpaceId;
    const shareSpaceId =
      this.ui.shareSpaceId && state.spaces.some((space) => space.id === this.ui.shareSpaceId)
        ? this.ui.shareSpaceId
        : pluginSpaceId;
    const protocolError =
      state.protocolVersion !== 2 ? localizeError(this.ui.locale, "workbench/unsupported") : this.ui.error;
    this.patch({
      boot: "ready",
      error: state.protocolVersion === 2 ? null : protocolError,
      state,
      selected,
      createdNotice: epochChanged || noticeId === selected || noticeRemoved ? null : this.ui.createdNotice,
      pluginSpaceId,
      templateSpaceId,
      shareSpaceId,
      frames: this.views.list(),
      visibleSpaceId: this.views.visibleSpaceId,
      viewError: this.views.viewError,
    });
    if (selectedWasRemoved) this.writePersist();
    if (epochChanged) this.blueprint.onServiceEpoch(state.serviceEpoch);
    const priming = !this.primedProductJobs;
    if (priming) {
      this.primedProductJobs = true;
      for (const item of state.jobs) {
        if (!ACTIVE_JOB.has(item.status)) this.handledProductJobs.add(item.id);
      }
    }
    if (epochChanged) {
      for (const item of state.jobs) {
        if (!ACTIVE_JOB.has(item.status)) this.handledProductJobs.add(item.id);
        else this.handledProductJobs.delete(item.id);
      }
      this.watchedCreates.clear();
      this.dismissedCreations.clear();
    }
    for (const item of state.jobs) {
      if (ACTIVE_JOB.has(item.status) && CREATE_JOB.has(item.kind)) this.watchedCreates.add(item.id);
      this.noteCreated(item, priming || epochChanged || !this.watchedCreates.has(item.id));
      this.onProductJob(item);
    }
    const restoreId = this.restoreId;
    if (restoreId) {
      this.restoreId = null;
      const restore = state.spaces.find((item) => item.id === restoreId);
      if (restore?.status === "running") this.beginSpace(restore, false);
    }
    this.continuePending(state);
    this.flushAutoEnter(state);
  }

  canMutate(): boolean {
    if (this.shutdownRequested || this.stateReadFailed) return false;
    const state = this.ui.state;
    if (!state) return false;
    if (state.protocolVersion !== 2) return false;
    if (state.availability === "unavailable") return false;
    return state.writable === true;
  }

  isBusy(): boolean {
    return this.ui.commandPending || this.hasActiveJobs() || this.ui.state?.maintenance === true;
  }

  protected workspaceSpacesFrom(state: WorkbenchState): WorkbenchSpace[] {
    return state.spaces.filter((space) => space.id !== state.managerId && !space.isHost);
  }
}
