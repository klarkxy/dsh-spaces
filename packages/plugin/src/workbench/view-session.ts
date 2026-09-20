import type { WorkbenchSpace, WorkbenchView, WorkbenchViewMessage } from "../../../../src/shared/workbench";

export type FrameStatus = "loading" | "pending" | "ready" | "reconnecting" | "failed";

export interface ViewFrameState {
  spaceId: string;
  generation: number;
  view: WorkbenchView | null;
  src: string | null;
  status: FrameStatus;
  error: string | null;
  selectToken: number;
}

export interface ViewMessageEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

const SERVICE_EPOCH_RE = /^[a-f0-9]{64}$/;

export function isServiceEpoch(value: string): boolean {
  return typeof value === "string" && SERVICE_EPOCH_RE.test(value);
}

/** Exact `http(s)://127.0.0.1[:port]` — no userinfo, path, query, or hash. */
export function isCleanLoopbackOrigin(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.hostname !== "127.0.0.1") return false;
    if (url.username !== "" || url.password !== "") return false;
    if (url.search !== "" || url.hash !== "") return false;
    if (url.pathname !== "/" && url.pathname !== "") return false;
    return value === url.origin;
  } catch {
    return false;
  }
}

export function isTrustedOrigin(origin: string): boolean {
  return isCleanLoopbackOrigin(origin);
}

export function isAuthorizedEntryPath(path: string): boolean {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\") || path.includes("//") || path.includes("?") || path.includes("#")) return false;
  try {
    const resolved = new URL(path, "http://127.0.0.1");
    if (resolved.search !== "" || resolved.hash !== "") return false;
    if (resolved.pathname.includes("//")) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * iframe src is supervisor entryOrigin + entryPath + exactly `?epoch=` of the view epoch.
 * entryPath stays path-only; the epoch query is appended here, not taken from the path.
 */
export function authorizedViewSrc(view: WorkbenchView): string {
  if (!view || typeof view.entryOrigin !== "string" || typeof view.origin !== "string") {
    throw new Error("unauthorized-view");
  }
  if (!isCleanLoopbackOrigin(view.entryOrigin) || !isCleanLoopbackOrigin(view.origin)) {
    throw new Error("unauthorized-view");
  }
  if (view.entryOrigin === view.origin) throw new Error("unauthorized-view");
  if (!isAuthorizedEntryPath(view.entryPath)) throw new Error("unauthorized-view");
  if (!isServiceEpoch(view.serviceEpoch)) throw new Error("unauthorized-view");
  const url = new URL(view.entryPath, view.entryOrigin);
  if (url.origin !== view.entryOrigin) throw new Error("unauthorized-view");
  if (url.search !== "" || url.hash !== "") throw new Error("unauthorized-view");
  return `${view.entryOrigin}${url.pathname}?epoch=${encodeURIComponent(view.serviceEpoch)}`;
}

export function parseViewMessage(data: unknown): WorkbenchViewMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.source !== "dsh-spaces-view") return null;
  if (typeof message.serviceEpoch !== "string" || !message.serviceEpoch) return null;
  if (typeof message.spaceId !== "string" || !message.spaceId) return null;
  if (typeof message.generation !== "number" || !Number.isFinite(message.generation)) return null;
  if (typeof message.channel !== "string" || !message.channel) return null;
  if (message.state !== "ready" && message.state !== "failed" && message.state !== "disconnected") {
    return null;
  }
  const parsed: WorkbenchViewMessage = {
    source: "dsh-spaces-view",
    serviceEpoch: message.serviceEpoch,
    spaceId: message.spaceId,
    generation: message.generation,
    channel: message.channel,
    state: message.state,
  };
  if (typeof message.message === "string") parsed.message = message.message;
  return parsed;
}

export function acceptViewMessage(
  event: ViewMessageEvent,
  frame: ViewFrameState,
  iframeWindow: unknown,
): WorkbenchViewMessage | null {
  if (!frame.view) return null;
  if (event.source !== iframeWindow) return null;
  if (event.origin !== frame.view.origin) return null;
  const message = parseViewMessage(event.data);
  if (!message) return null;
  if (message.serviceEpoch !== frame.view.serviceEpoch) return null;
  if (message.spaceId !== frame.view.spaceId) return null;
  if (message.generation !== frame.view.generation) return null;
  if (message.channel !== frame.view.channel) return null;
  return message;
}

export class ViewSession {
  readonly frames = new Map<string, ViewFrameState>();
  /** null means home. Only changes after a target is ready (or home, which is immediately ready). */
  committedSpaceId: string | null = null;
  pendingSpaceId: string | null = null;
  visibleSpaceId: string | null = null;
  selectToken = 0;
  viewError: { spaceId: string; message: string } | null = null;

  list(): ViewFrameState[] {
    return [...this.frames.values()];
  }

  get(spaceId: string): ViewFrameState | undefined {
    return this.frames.get(spaceId);
  }

  /** Home is a valid selection and commits immediately. Frames stay mounted. */
  commitHome(): number {
    const token = ++this.selectToken;
    this.committedSpaceId = null;
    this.pendingSpaceId = null;
    this.visibleSpaceId = null;
    this.viewError = null;
    return token;
  }

  /**
   * Last click becomes the pending target. Does not commit highlight or visibility.
   * Reuses the iframe for the same space+generation. Generation mismatch destroys that frame only.
   */
  requestSpace(space: WorkbenchSpace): { token: number; load: boolean; reuseReady: boolean } {
    this.pendingSpaceId = space.id;
    const token = ++this.selectToken;
    this.viewError = null;
    const existing = this.frames.get(space.id);
    if (existing && existing.generation !== space.generation) {
      this.frames.delete(space.id);
      if (this.visibleSpaceId === space.id) this.visibleSpaceId = null;
      if (this.committedSpaceId === space.id) this.visibleSpaceId = null;
    }
    const frame = this.frames.get(space.id);
    if (frame && frame.status === "ready" && frame.src) {
      frame.selectToken = token;
      return { token, load: false, reuseReady: true };
    }
    if (frame && frame.status === "failed") {
      this.frames.set(space.id, {
        spaceId: space.id,
        generation: space.generation,
        view: null,
        src: null,
        status: "loading",
        error: null,
        selectToken: token,
      });
      return { token, load: true, reuseReady: false };
    }
    if (frame && (frame.status === "loading" || frame.status === "pending" || frame.status === "reconnecting")) {
      frame.selectToken = token;
      return { token, load: frame.view === null, reuseReady: false };
    }
    this.frames.set(space.id, {
      spaceId: space.id,
      generation: space.generation,
      view: null,
      src: null,
      status: "loading",
      error: null,
      selectToken: token,
    });
    return { token, load: true, reuseReady: false };
  }

  commitPending(spaceId: string, token: number): boolean {
    if (token !== this.selectToken) return false;
    if (this.pendingSpaceId !== spaceId) return false;
    const frame = this.frames.get(spaceId);
    if (!frame || frame.status !== "ready" || !frame.src) return false;
    this.committedSpaceId = spaceId;
    this.visibleSpaceId = spaceId;
    this.pendingSpaceId = null;
    this.viewError = null;
    return true;
  }

  applyView(spaceId: string, token: number, view: WorkbenchView): ViewFrameState | null {
    const frame = this.frames.get(spaceId);
    if (!frame || frame.selectToken !== token || frame.status === "failed") return null;
    if (
      view.spaceId !== spaceId ||
      view.generation !== frame.generation ||
      !isServiceEpoch(view.serviceEpoch)
    ) {
      frame.status = "failed";
      frame.error = "unauthorized-view";
      this.failPending(spaceId, token);
      return frame;
    }
    let src: string;
    try {
      src = authorizedViewSrc(view);
    } catch {
      frame.status = "failed";
      frame.error = "unauthorized-view";
      this.failPending(spaceId, token);
      return frame;
    }
    frame.view = view;
    frame.src = src;
    frame.status = "pending";
    frame.error = null;
    return frame;
  }

  failView(spaceId: string, token: number, error: string): ViewFrameState | null {
    const frame = this.frames.get(spaceId);
    if (!frame || frame.selectToken !== token) return null;
    frame.status = "failed";
    frame.error = error;
    this.failPending(spaceId, token);
    return frame;
  }

  onAcceptedMessage(spaceId: string, message: WorkbenchViewMessage): boolean {
    const frame = this.frames.get(spaceId);
    if (!frame || !frame.view) return false;
    if (message.state === "ready") {
      if (frame.status === "failed") return false;
      frame.status = "ready";
      frame.error = null;
      if (this.committedSpaceId === spaceId && this.viewError?.spaceId === spaceId) this.viewError = null;
      this.commitPending(spaceId, frame.selectToken);
      return true;
    }
    if (message.state === "disconnected") {
      frame.status = "reconnecting";
      frame.error = message.message || "view-disconnected";
      this.failPending(spaceId, frame.selectToken);
      if (this.committedSpaceId === spaceId) this.viewError = { spaceId, message: frame.error };
      return false;
    }
    frame.status = "failed";
    frame.error = message.message || "view-failed";
    this.failPending(spaceId, frame.selectToken);
    return false;
  }

  retry(space: WorkbenchSpace): { token: number; load: boolean; reuseReady: boolean } {
    this.frames.delete(space.id);
    if (this.visibleSpaceId === space.id) this.visibleSpaceId = null;
    return this.requestSpace(space);
  }

  destroy(spaceId: string): void {
    this.frames.delete(spaceId);
    if (this.visibleSpaceId === spaceId) this.visibleSpaceId = null;
  }

  /** Destroy frames whose generation no longer matches (stop/restart). */
  syncGenerations(spaces: WorkbenchSpace[]): string[] {
    const live = new Map(spaces.map((item) => [item.id, item]));
    const destroyed: string[] = [];
    for (const [spaceId, frame] of [...this.frames.entries()]) {
      const space = live.get(spaceId);
      if (!space || space.generation !== frame.generation) {
        this.frames.delete(spaceId);
        if (this.visibleSpaceId === spaceId) this.visibleSpaceId = null;
        destroyed.push(spaceId);
      }
    }
    return destroyed;
  }

  /** Drop frames minted by a previous service epoch. Old-service messages cannot reuse them. */
  syncServiceEpoch(serviceEpoch: string): string[] {
    const destroyed: string[] = [];
    for (const [spaceId, frame] of [...this.frames.entries()]) {
      if (frame.view && frame.view.serviceEpoch !== serviceEpoch) {
        this.frames.delete(spaceId);
        if (this.visibleSpaceId === spaceId) this.visibleSpaceId = null;
        destroyed.push(spaceId);
      }
    }
    return destroyed;
  }

  isVisible(spaceId: string): boolean {
    const frame = this.frames.get(spaceId);
    return Boolean(
      frame &&
        this.committedSpaceId === spaceId &&
        this.visibleSpaceId === spaceId &&
        (frame.status === "ready" || frame.status === "reconnecting") &&
        frame.src,
    );
  }

  isCurrentToken(token: number): boolean {
    return token === this.selectToken;
  }

  private failPending(spaceId: string, token: number): void {
    if (token !== this.selectToken) return;
    if (this.pendingSpaceId !== spaceId) return;
    this.viewError = { spaceId, message: this.frames.get(spaceId)?.error || "view-failed" };
    this.pendingSpaceId = null;
  }
}
