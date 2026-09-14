import type { ViewHandshakeConfig } from "./env";

export type ViewHandshakeState = "ready" | "failed" | "disconnected";

export interface ViewHandshakeMessage {
  source: "dsh-spaces-view";
  spaceId: string;
  generation: number;
  channel: string;
  state: ViewHandshakeState;
  message?: string;
}

export interface ViewPostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export function viewMessage(config: ViewHandshakeConfig, state: ViewHandshakeState, message?: string): ViewHandshakeMessage {
  const payload: ViewHandshakeMessage = {
    source: "dsh-spaces-view",
    spaceId: config.spaceId,
    generation: config.generation,
    channel: config.channel,
    state,
  };
  if (typeof message === "string" && message) payload.message = message;
  return payload;
}

/**
 * postMessage only to the exact parent origin. Errors never claim ready.
 * After disconnect, a later ready is allowed.
 */
export function postViewState(
  target: ViewPostTarget | null | undefined,
  config: ViewHandshakeConfig,
  state: ViewHandshakeState,
  message?: string,
): boolean {
  if (!target || typeof target.postMessage !== "function") return false;
  try {
    target.postMessage(viewMessage(config, state, message), config.parentOrigin);
    return true;
  } catch {
    return false;
  }
}

export const PARENT_PING_SOURCE = "dsh-spaces-view-parent";

export function parseParentPing(
  event: { origin: string; source: unknown; data: unknown },
  config: ViewHandshakeConfig,
  expectedSource: unknown,
): boolean {
  if (event.source !== expectedSource) return false;
  if (event.origin !== config.parentOrigin) return false;
  const data = event.data;
  if (!data || typeof data !== "object") return false;
  const row = data as Record<string, unknown>;
  if (row.source !== PARENT_PING_SOURCE) return false;
  if (row.type !== "ping") return false;
  if (row.spaceId !== config.spaceId) return false;
  if (row.generation !== config.generation) return false;
  if (row.channel !== config.channel) return false;
  return true;
}

export function acceptParentMessage(
  event: { origin: string; source: unknown; data: unknown },
  config: ViewHandshakeConfig,
  expectedSource: unknown,
): ViewHandshakeMessage | null {
  if (event.source !== expectedSource) return null;
  if (event.origin !== config.parentOrigin) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (row.source !== "dsh-spaces-view") return null;
  if (row.spaceId !== config.spaceId) return null;
  if (row.generation !== config.generation) return null;
  if (row.channel !== config.channel) return null;
  if (row.state !== "ready" && row.state !== "failed" && row.state !== "disconnected") return null;
  const parsed: ViewHandshakeMessage = {
    source: "dsh-spaces-view",
    spaceId: config.spaceId,
    generation: config.generation,
    channel: config.channel,
    state: row.state,
  };
  if (typeof row.message === "string") parsed.message = row.message;
  return parsed;
}
