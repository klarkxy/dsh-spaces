import { redactPublicReason } from "../../../../shared/public-reason";

export const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return [...value];
}


export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}


function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}


export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}


export function sanitizeJobText(text: string): string {
  if (!text) return "";
  // DSH appends an install suggestion to this diagnostic. Keep the failure,
  // without presenting the upstream suggestion as a Spaces recovery workflow.
  if (/^dsh: cannot resolve profile bundle\b/.test(text)) {
    text = text.replace(/\s*;?\s+run ['"]dsh plugin --profile [^'"\r\n]+ install['"] if its dependency is not installed\.?\s*$/i, "");
  }
  return redactPublicReason(text, 2000)
    .replace(/\b(authorization|cookie|set-cookie|token)\s*[:=]\s*[^\s;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/file:\/+[^\s"'\\]+/gi, "[path]")
    .replace(/\b[A-Za-z]:\\[^\s"'`]+/g, "[path]")
    .replace(/\\\\[^\s"'`]+/g, "[path]")
    .replace(/(?:^|[\s"'`(])(\/(?:[\w.+-]+\/)+[\w.+-]+)/g, (full, path: string) =>
      full.replace(path, "[path]"),
    );
}

