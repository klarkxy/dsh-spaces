/** Bounded public failure text. Drops credentials, chat payloads, and local paths. */

const SECRET_ASSIGN =
  /\b(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|cookie|authorization|bearer)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

export function redactPublicReason(text: string, limit = 500): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/"role"\s*:/.test(trimmed) && /"content"\s*:/.test(trimmed)) return "";
  let out = trimmed
    .replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, "Authorization: Bearer [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(SECRET_ASSIGN, (full) => {
      const cut = full.search(/[:=]/);
      return `${full.slice(0, cut).trimEnd()}=[redacted]`;
    })
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'`<>]+/g, "[path]")
    .replace(/(?:\/(?:home|Users|tmp|var|root|private|opt)\/|~\/)[^\s"'`<>]+/g, "[path]");
  if (out.length > limit) out = `${out.slice(0, limit - 1)}…`;
  return out;
}

/** Keep a reported sentence when it adds a reason. A bare error code stays on the fallback. */
export function reportedOrFallback(reported: unknown, fallback: string): string {
  if (typeof reported !== "string") return fallback;
  const trimmed = reported.trim();
  if (!trimmed || trimmed === fallback) return fallback;
  if (/^(?:workbench|spaces)\/[a-z0-9-]+$/.test(trimmed) || /^LLM_[A-Z0-9_]+$/.test(trimmed)) return fallback;
  return redactPublicReason(trimmed) || fallback;
}
