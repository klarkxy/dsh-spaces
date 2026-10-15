/** Bounded public failure text. Drops credentials, chat payloads, and local paths. */

const SECRET_NAME = /^(?:api[_-]?key|access[_-]?(?:key|token)|refresh[_-]?token|token|secret|password|passwd|cookie|set-cookie|authorization|bearer)$/i;
const SECRET_ASSIGN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z][\w-]*)\s*[:=]\s*("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;{}\[\]]+)/g;
const STRUCTURED_ASSIGN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z][\w-]*)\s*[:=]\s*(?!\[redacted\])[\[{]/g;
const KEY_ASSIGN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z][\w-]*)\s*[:=]/g;

function isSecretKey(key: string): boolean {
  if (key.startsWith('"')) {
    try { return SECRET_NAME.test(JSON.parse(key)); } catch { return false; }
  }
  return SECRET_NAME.test(key.startsWith("'") ? key.slice(1, -1) : key);
}

function redactAssignments(text: string, depth = 0): string {
  if (depth > 8) return "[omitted nested diagnostic]";
  return text.replace(SECRET_ASSIGN, (full, key: string, value: string) => {
    if (isSecretKey(key)) return `${key}=[redacted]`;
    if (value.startsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(value);
        if (typeof decoded === "string") {
          const safe = redactReason(decoded, depth + 1);
          if (safe !== decoded) return full.slice(0, full.length - value.length) + JSON.stringify(safe);
        }
      } catch { /* Not a complete JSON string; the assignment matcher still handles ordinary fields. */ }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      const inner = value.slice(1, -1);
      const safe = redactReason(inner, depth + 1);
      if (safe !== inner) return full.slice(0, full.length - value.length) + JSON.stringify(safe);
    }
    return full;
  });
}

export function redactPublicReason(text: string, limit = 500): string {
  const out = redactReason(text, 0);
  return out.length > limit ? `${out.slice(0, limit - 1)}…` : out;
}

function redactReason(text: string, depth: number): string {
  if (depth > 8) return "[omitted nested diagnostic]";
  const trimmed = text.trim().replace(/"(?:\\.|[^"\\])*"/g, quoted => {
    try {
      const decoded: unknown = JSON.parse(quoted);
      if (typeof decoded === "string") {
        const safe = redactReason(decoded, depth + 1);
        if (safe !== decoded) return JSON.stringify(safe);
      }
    } catch { /* Keep malformed strings for conservative field checks below. */ }
    return quoted;
  });
  if (!trimmed) return "";
  if (/"role"\s*:/.test(trimmed) && /"content"\s*:/.test(trimmed)) return "";
  // Serialized JSON may itself be embedded in a quoted diagnostic. Avoid
  // partially displaying its credential values through another escaping layer.
  const unescapedKeys = trimmed.replace(/\\u([a-f0-9]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  if (/\\+["'](?:api[_-]?key|access[_-]?(?:key|token)|refresh[_-]?token|token|secret|password|passwd|cookie|set-cookie|authorization|bearer)\\+["']\s*[:=]/i.test(unescapedKeys)) {
    return "[omitted credential material]";
  }
  if ([...trimmed.matchAll(STRUCTURED_ASSIGN)].some(match => isSecretKey(match[1]!))) {
    return "[omitted credential material]";
  }
  // YAML block/folded scalars and multiline unquoted values do not have a
  // reliable token boundary. Do not expose the remainder of such diagnostics.
  if ([...trimmed.matchAll(KEY_ASSIGN)].some(match => {
    if (!isSecretKey(match[1]!)) return false;
    const value = trimmed.slice(match.index! + match[0].length).replace(/^[ \t]*/, "");
    // Quoted values have their own boundary. An ordinary subsequent reason on
    // a new line does not belong to this field; indented YAML continuation does.
    return !/^["']/.test(value) && /^(?:[|>][+-]?\d*[^\r\n]*\r?\n|[^\r\n]*\r?\n[ \t]+\S)/.test(value);
  })) {
    return "[omitted credential material]";
  }
  let out = trimmed
    .replace(/\b(?:Authorization|Cookie|Set-Cookie)\s*[:=][^\r\n]*/gi, (header) => header.split(/[:=]/, 1)[0] + "=[redacted]")
    .replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, "Authorization: Bearer [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]");
  out = redactAssignments(out, depth)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+/g, "[path]")
    .replace(/(?:\/(?:home|Users|tmp|var|root|private|opt)\/|~\/)[^\s"'`<>]+/g, "[path]");
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
