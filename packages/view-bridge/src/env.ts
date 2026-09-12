/** Parse supervisor-injected view handshake env. Invalid values have no effect. */

export const VIEW_ENV = {
  parentOrigin: "DSH_SPACES_VIEW_PARENT_ORIGIN",
  spaceId: "DSH_SPACES_VIEW_ID",
  generation: "DSH_SPACES_VIEW_GENERATION",
  channel: "DSH_SPACES_VIEW_CHANNEL",
} as const;

export const VIEW_HINT_GLOBAL = "__DSH_SPACES_VIEW__";

export interface ViewHandshakeConfig {
  parentOrigin: string;
  spaceId: string;
  generation: number;
  channel: string;
}

export function parseLoopbackOrigin(raw: string): string | null {
  if (typeof raw !== "string" || raw !== raw.trim() || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname !== "127.0.0.1") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  return url.origin;
}

export function parseExactInteger(raw: string): number | null {
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

export function parseViewChannel(raw: string): string | null {
  if (typeof raw !== "string" || raw !== raw.trim() || !raw) return null;
  if (raw.length > 128) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) return null;
  return raw;
}

export function parseViewSpaceId(raw: string): string | null {
  if (typeof raw !== "string" || raw !== raw.trim() || !raw) return null;
  if (raw === "web") return raw;
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(raw)) return null;
  return raw;
}

export function parseViewEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ViewHandshakeConfig | null {
  const parentOrigin = parseLoopbackOrigin(String(env[VIEW_ENV.parentOrigin] ?? ""));
  const spaceId = parseViewSpaceId(String(env[VIEW_ENV.spaceId] ?? ""));
  const generation = parseExactInteger(String(env[VIEW_ENV.generation] ?? ""));
  const channel = parseViewChannel(String(env[VIEW_ENV.channel] ?? ""));
  if (!parentOrigin || !spaceId || generation === null || !channel) return null;
  return { parentOrigin, spaceId, generation, channel };
}

export function parseViewHint(value: unknown): ViewHandshakeConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.parentOrigin !== "string" || typeof row.spaceId !== "string") return null;
  if (typeof row.generation !== "number" || typeof row.channel !== "string") return null;
  const parentOrigin = parseLoopbackOrigin(row.parentOrigin);
  const spaceId = parseViewSpaceId(row.spaceId);
  const channel = parseViewChannel(row.channel);
  if (!parentOrigin || !spaceId || !Number.isSafeInteger(row.generation) || !channel) return null;
  return { parentOrigin, spaceId, generation: row.generation, channel };
}

export function readViewHint(
  globalObject: Record<string, unknown> | undefined = globalThis as unknown as Record<string, unknown>,
): ViewHandshakeConfig | null {
  return parseViewHint(globalObject?.[VIEW_HINT_GLOBAL]);
}

export function injectViewHintScript(html: string, view: ViewHandshakeConfig): string {
  const payload = JSON.stringify(view);
  if (!html || payload.includes("<") || payload.includes("&") || payload.includes("</")) return html;
  if (html.includes(VIEW_HINT_GLOBAL)) return html;
  const tag = `<script>globalThis.${VIEW_HINT_GLOBAL}=${payload};</script>`;
  return html.replace(/<head([^>]*)>/i, (open) => `${open}${tag}`);
}
