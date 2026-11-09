/**
 * Shared native-request admission for the private loopback channels
 * (/internal/creator/v1/, /internal/control/v1/): POST only, the request Host
 * is exactly the supervisor origin's host, and no Origin, Cookie or
 * sec-fetch-site header is present. Exactly one Host and one Authorization
 * header are allowed; the Authorization value must be a Bearer token, which
 * the caller checks against the credential that gates the operation.
 *
 * Keeping this as one function prevents the Creator and Control channels
 * from drifting into two different admission policies.
 */
import type { IncomingMessage } from "node:http";

export interface NativeRequestAdmission {
  ok: boolean;
  status: 200 | 401 | 403 | 405;
  code: "workbench/forbidden" | "workbench/unauthorized" | "workbench/invalid-input";
  message: string;
  /** The Bearer token, present only when ok. */
  token?: string;
}

export function admitNativeRequest(req: IncomingMessage, origin: string, channelLabel: string): NativeRequestAdmission {
  if (req.method !== "POST") {
    return {
      ok: false, status: 405, code: "workbench/invalid-input",
      message: `${channelLabel} operations are POST JSON.`,
    };
  }
  if (req.headers.host !== new URL(origin).host ||
      req.headers.origin !== undefined || req.headers.cookie !== undefined ||
      req.headers["sec-fetch-site"] !== undefined) {
    return {
      ok: false, status: 403, code: "workbench/forbidden",
      message: `The ${channelLabel} channel requires a native request.`,
    };
  }
  const authorization = req.headers.authorization;
  if (req.rawHeaders.filter((_, i) => i % 2 === 0)
        .filter((name) => name.toLowerCase() === "host" || name.toLowerCase() === "authorization").length !== 2 ||
      typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return {
      ok: false, status: 401, code: "workbench/unauthorized",
      message: "Authentication is required.",
    };
  }
  return { ok: true, status: 200, code: "workbench/forbidden", message: "", token: authorization.slice("Bearer ".length) };
}

/** Body failures the channel maps to a public error, not a transport denial. */
export class ChannelBodyRejection extends Error {
  readonly name = "ChannelBodyRejection";
}

export const CHANNEL_BODY_LIMIT = 64 * 1024;
const CHANNEL_BODY_TIMEOUT_MS = 5_000;

/**
 * Bounded JSON request body for the private channels. A bad content type or
 * an oversized body throws ChannelBodyRejection; malformed JSON throws a
 * SyntaxError (the callers deny 400). The scope token is never echoed.
 */
export async function readChannelJsonBody(
  req: IncomingMessage,
  label: string,
  limit = CHANNEL_BODY_LIMIT,
  timeoutMs = CHANNEL_BODY_TIMEOUT_MS,
): Promise<unknown> {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.toLowerCase().startsWith("application/json") || req.headers["content-encoding"]) {
    throw new ChannelBodyRejection(`${label} operations require a JSON body.`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(() => req.destroy(new Error("BODY_TIMEOUT")), timeoutMs);
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > limit) throw new ChannelBodyRejection("The request body is too large.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    clearTimeout(timer);
  }
}
