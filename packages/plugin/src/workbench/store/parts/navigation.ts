/**
 * The selection and navigation state of the workbench client.
 *
 * This part owns where the user is: the selected space, the pending view, the
 * frames and the navigation intent. The code moves unchanged from
 * `workbench/store.ts`.
 */

import { reportedOrFallback } from "../../../../../../src/shared/public-reason";
import type { WorkbenchSpace, WorkbenchState, WorkbenchView } from "../../../../../../src/shared/workbench";
import { acceptViewMessage, authorizedViewSrc, type ViewFrameState, type ViewMessageEvent } from "../../view-session";
import { errorCode } from "../errors";
import { workbenchRequestOrigin } from "../origin";
import { PersistencePart } from "./persistence";

export abstract class NavigationPart extends PersistencePart {
  blueprintSourceSpaces = (): WorkbenchSpace[] => {
    return this.workspaceSpaces().filter((space) => space.id !== "web");
  };

  openBlueprintGenerate = (spaceId: string): void => {
    if (this.isManagerId(spaceId) || spaceId === "web") return;
    this.selectHome();
    this.setHomeTab("blueprints");
    this.blueprint.openGenerate(spaceId);
  };

  selectHome = (): void => {
    ++this.navigationIntent;
    this.clearRequestError();
    this.clearWait();
    this.views.commitHome();
    this.patch({
      selected: "home",
      pendingId: null,
      visibleSpaceId: null,
      viewError: null,
      overlay: this.ui.overlay?.type === "menu" ? null : this.ui.overlay,
      frames: this.views.list(),
    });
    this.writePersist();
  };

  selectSpace = (spaceId: string): void => {
    const space = this.space(spaceId);
    if (!space) return;
    ++this.navigationIntent;
    this.beginSpace(space, true);
  };

  /** Presentation-only navigation: a stopped or foreign entry never becomes an implicit start. */
  selectRunningSpace = async (spaceId: string, isCurrent: () => boolean = () => true): Promise<boolean> => {
    if (this.stateReadFailed) return false;
    const cycle = this.cycle, intent = ++this.navigationIntent;
    try {
      // The outer host has its own inventory. A normal selection reads current
      // authority once instead of rejecting from this iframe's older poll.
      const state = await this.api.state();
      if (this.stateReadFailed || !this.stillOpen(cycle) || !isCurrent() || intent !== this.navigationIntent || state.serviceEpoch !== this.ui.state?.serviceEpoch) return false;
      const space = state.spaces.find(item => item.id === spaceId);
      if (!space || space.status !== "running" || !space.hasWebApp || space.isHost || state.managerId === spaceId || state.availability === "unavailable") return false;
      ++this.stateGeneration; // older in-flight polls cannot overwrite this selection's state
      this.applyState(state);
      if (!isCurrent() || intent !== this.navigationIntent) return false;
      const frame = this.views.get(spaceId);
      if (this.views.pendingSpaceId === spaceId && frame?.generation === space.generation &&
          (frame.status === "loading" || frame.status === "pending")) {
        // Adjacent clicks share the existing authorization request and handshake.
        this.continuePending(state);
      } else this.beginSpace(space, false);
      return true;
    } catch { return false; }
  };

  openBlueprintUse = (): void => {
    this.selectHome();
    this.setHomeTab("blueprints");
    this.blueprint.setMode("use");
  };

  enterCreated = (): void => {
    const spaceId = this.ui.createdNotice?.spaceId;
    if (!spaceId) return;
    this.patch({ createdNotice: null });
    this.selectSpace(spaceId);
  };

  registerIframeWindow = (spaceId: string, generation: number, win: unknown): void => {
    const key = `${spaceId}:${generation}`;
    if (win) this.iframeWindows.set(key, win);
    else this.iframeWindows.delete(key);
  };

  isRegisteredViewSource = (event: ViewMessageEvent, frame: ViewFrameState): boolean => {
    return Boolean(frame.view && event.origin === frame.view.origin &&
      event.source === this.iframeWindows.get(`${frame.spaceId}:${frame.generation}`));
  };

  handleMessage = (event: ViewMessageEvent): void => {
    for (const frame of this.views.list()) {
      const iframeWindow = this.iframeWindows.get(`${frame.spaceId}:${frame.generation}`);
      const message = acceptViewMessage(event, frame, iframeWindow);
      if (!message) continue;
      this.views.onAcceptedMessage(frame.spaceId, message);
      this.syncSelection();
      return;
    }
  };

  openIndependent = (spaceId: string): void => {
    const cycle = this.cycle;
    void this.wrap(async () => {
      const view = await this.api.view(spaceId);
      if (!this.stillOpen(cycle)) return;
      this.env.openUrl(authorizedViewSrc(view));
    });
  };

  startSpace = (spaceId: string): void => {
    this.selectSpace(spaceId);
  };

  isManagerId(spaceId: string): boolean {
    const state = this.ui.state;
    if (!state) return false;
    if (state.managerId && state.managerId === spaceId) return true;
    return this.space(spaceId)?.isHost === true;
  }

  space(spaceId: string): WorkbenchSpace | undefined {
    return this.ui.state?.spaces.find((item) => item.id === spaceId);
  }

  workspaceSpaces(): WorkbenchSpace[] {
    return (this.ui.state?.spaces ?? []).filter((space) => !this.isManagerId(space.id));
  }

  protected workspaceIds(): string[] {
    return this.workspaceSpaces().map((space) => space.id);
  }

  protected beginSpace(space: WorkbenchSpace, startIfStopped: boolean): void {
    if (space.status !== "running") {
      if (!startIfStopped) return;
      if (!space.managed) {
        this.patch({ commandError: this.msg("app.unmanaged") });
        return;
      }
      if (!this.canMutate()) {
        this.rejectReadonly();
        return;
      }
      this.clearRequestError();
      const decision = this.views.requestSpace(space);
      this.syncSelection();
      void this.submit({ kind: "space.start", spaceId: space.id }, { origin: workbenchRequestOrigin(this.ui, { kind: "space.start", spaceId: space.id }) });
      this.armWait(decision.token, this.env.startTimeoutMs, space.id, "start");
      return;
    }
    this.clearRequestError();
    const decision = this.views.requestSpace(space);
    if (decision.reuseReady) {
      this.views.commitPending(space.id, decision.token);
      this.syncSelection();
      return;
    }
    this.syncSelection();
    if (decision.load) void this.loadAuthorizedView(space.id, decision.token);
    this.armWait(decision.token, this.env.handshakeTimeoutMs, space.id, "handshake");
  }

  protected continuePending(state: WorkbenchState): void {
    const pendingId = this.views.pendingSpaceId;
    if (!pendingId) return;
    const space = state.spaces.find((item) => item.id === pendingId);
    if (!space) {
      this.views.failView(pendingId, this.views.selectToken, "view-failed");
      this.syncSelection();
      return;
    }
    const frame = this.views.get(pendingId);
    if (space.status !== "running") return;
    if (!frame || frame.generation !== space.generation) {
      this.beginSpace(space, false);
      return;
    }
    if (frame.status === "loading" && frame.view === null) {
      void this.loadAuthorizedView(pendingId, frame.selectToken);
    }
  }

  private async loadAuthorizedView(spaceId: string, token: number): Promise<void> {
    const cycle = this.cycle;
    const requestKey = `${spaceId}:${token}`;
    if (this.pendingViewRequests.has(requestKey)) return;
    this.pendingViewRequests.add(requestKey);
    if (this.views.isCurrentToken(token)) this.armWait(token, this.env.handshakeTimeoutMs, spaceId, "handshake");
    try {
      const view: WorkbenchView = await this.api.view(spaceId);
      if (!this.stillOpen(cycle)) return;
      if (!this.views.isCurrentToken(token)) {
        this.views.applyView(spaceId, token, view);
        this.syncSelection();
        return;
      }
      this.views.applyView(spaceId, token, view);
      this.syncSelection();
    } catch (error) {
      if (!this.stillOpen(cycle)) return;
      const reason = reportedOrFallback(errorCode(error).message, "");
      this.views.failView(spaceId, token, reason || "view-failed");
      this.syncSelection();
    } finally {
      this.pendingViewRequests.delete(requestKey);
    }
  }

  private syncSelection(): void {
    const selected = this.views.committedSpaceId ?? "home";
    const changed = selected !== this.ui.selected;
    this.patch({
      selected,
      pendingId: this.views.pendingSpaceId,
      frames: this.views.list(),
      visibleSpaceId: this.views.visibleSpaceId,
      viewError: this.views.viewError,
      overlay: this.ui.overlay?.type === "menu" ? null : this.ui.overlay,
    });
    if (changed) this.writePersist();
  }

  private armWait(token: number, ms: number, spaceId: string, kind: "start" | "handshake"): void {
    this.clearWait();
    this.waitTimer = this.env.setTimeout(() => {
      if (!this.views.isCurrentToken(token)) return;
      if (this.views.pendingSpaceId !== spaceId) return;
      const frame = this.views.get(spaceId);
      if (kind === "handshake" && frame?.status === "ready") return;
      if (kind === "start") {
        const space = this.space(spaceId);
        if (space?.status === "running") return;
      }
      this.views.failView(spaceId, token, "timeout");
      this.patch({ commandError: this.msg("app.handshakeTimeout") });
      this.syncSelection();
    }, ms);
  }

  protected clearWait(): void {
    if (this.waitTimer !== null) this.env.clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }
}
