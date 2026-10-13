/** Sanitize an internal reason for the guide: redact bearer tokens and absolute paths. */
export function publicGuideDetail(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]{16,}/g, "Bearer [redacted]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'`<>]+/g, "[path]");
}
