import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import { readViewHint, type ViewHandshakeConfig } from "./env";
import { parseParentPing, postViewState, type ViewHandshakeState } from "./handshake";

export const name = "dsh-spaces-view-bridge-client";
export const inject = ["slots", "connection"];

const READY_TIMEOUT_MS = 30_000;

export interface ViewBridgeSlots {
  inject(name: string, callback: () => () => void): () => void;
}

export interface ViewConnectionState {
  getSnapshot(): "connected" | "disconnected" | "connecting" | undefined;
  subscribe(listener: () => void): () => void;
}

export interface BootWatch {
  findBoot(): { parentElement: ParentNode | null } | null;
  hasAppDom(container: ParentNode): boolean;
  observe(container: ParentNode, onChange: () => void): () => void;
}

export type ViewMessageListen = (listener: (event: MessageEvent) => void) => () => void;
export type ViewDelay = (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
export type ViewCancelDelay = (id: ReturnType<typeof setTimeout>) => void;

export interface ViewBridgeOptions {
  parent?: { postMessage(message: unknown, targetOrigin: string): void } | null;
  parentSource?: unknown;
  timeoutMs?: number;
  document?: Document;
  connection?: { state: ViewConnectionState } | null;
  bootWatch?: BootWatch;
  addMessageListener?: ViewMessageListen;
  delay?: ViewDelay;
  cancelDelay?: ViewCancelDelay;
}

/**
 * Independent client half. Does not occupy `root`. Ready only after DSH boot
 * handoff removes `[data-dsh-boot]` and the connection is connected.
 */
export function apply(ctx: Context): () => void {
  const view = readViewHint();
  if (!view) return () => undefined;
  const connection = ctx.get("connection") as ConnectionHandle | undefined;
  return startViewBridge({ slots: ctx.slots as unknown as ViewBridgeSlots }, view, {
    connection: connection ? { state: connection.state } : null,
  });
}

export function startViewBridge(
  ctx: { slots: ViewBridgeSlots },
  view: ViewHandshakeConfig,
  options: ViewBridgeOptions = {},
): () => void {
  const parent = options.parent ?? (typeof window === "undefined" ? null : window.parent);
  const parentSource = options.parentSource ?? parent;
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const setTimer = options.delay ?? setTimeout;
  const clearTimer = options.cancelDelay ?? clearTimeout;
  const doc = options.document ?? (typeof document === "undefined" ? undefined : document);
  const watch = options.bootWatch ?? (doc ? createDomBootWatch(doc) : null);
  const connection = options.connection;
  let ready = false;
  let failed = false;
  let last: ViewHandshakeState | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let container: ParentNode | null = null;
  const stoppers: Array<() => void> = [];

  const report = (state: ViewHandshakeState, message?: string) => {
    if (disposed) return;
    if (state === "ready") {
      if (failed) return;
      ready = true;
    }
    if (state === "failed") {
      if (ready) return;
      failed = true;
    }
    if (state === "disconnected") ready = false;
    if (last === state && state !== "ready") return;
    last = state;
    postViewState(parent, view, state, message);
  };

  const consider = () => {
    if (disposed || failed) return;
    const conn = connection?.state.getSnapshot();
    if (connection && conn !== "connected") {
      if (conn === "disconnected" && (ready || last === "ready")) report("disconnected");
      return;
    }
    const boot = watch?.findBoot() ?? null;
    if (boot?.parentElement) container = boot.parentElement;
    const handedOff = Boolean(container && !boot && watch?.hasAppDom(container));
    if (handedOff && (!connection || conn === "connected")) report("ready");
  };

  timer = setTimer(() => {
    if (!ready && !failed) report("failed", "The DSH UI did not become ready.");
  }, timeoutMs);

  const stopInject = ctx.slots.inject("root", () => {
    const boot = watch?.findBoot();
    if (boot?.parentElement) container = boot.parentElement;
    if (container && watch) stoppers.push(watch.observe(container, consider));
    else if (doc?.body && watch) {
      container = doc.body;
      stoppers.push(watch.observe(doc.body, consider));
    }
    consider();
    return () => undefined;
  });

  if (connection?.state.subscribe) {
    stoppers.push(connection.state.subscribe(() => consider()));
  }

  const onMessage = (event: MessageEvent) => {
    if (!parseParentPing(event, view, parentSource)) return;
    if (last) postViewState(parent, view, last);
  };
  if (options.addMessageListener) {
    stoppers.push(options.addMessageListener(onMessage));
  } else if (typeof window !== "undefined") {
    window.addEventListener("message", onMessage);
    stoppers.push(() => window.removeEventListener("message", onMessage));
  }

  consider();

  return () => {
    disposed = true;
    if (timer !== undefined) clearTimer(timer);
    stopInject();
    for (const stop of stoppers) stop();
  };
}

export function createDomBootWatch(doc: Document): BootWatch {
  return {
    findBoot() {
      return doc.querySelector("[data-dsh-boot]");
    },
    hasAppDom(container) {
      const el = container as Element;
      if (el.querySelector?.("[data-dsh-boot]")) return false;
      return (el.childElementCount ?? el.childNodes.length) > 0;
    },
    observe(container, onChange) {
      if (typeof MutationObserver === "undefined") return () => undefined;
      const observer = new MutationObserver(() => onChange());
      observer.observe(container, { childList: true, subtree: true });
      return () => observer.disconnect();
    },
  };
}

export default { name, inject, apply };
