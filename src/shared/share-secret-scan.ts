import { LLM_ERROR, LlmConfigError } from "./llm-connections";

export type SecretScanFinding = {
  path: string;
  reason: string;
};

const FORBIDDEN_SHARE_ENTRY = [
  /(^|\/)\.credentials\.yaml$/i,
  /(^|\/)credentials\.yaml$/i,
  /(^|\/)\.dsh-spaces-control\/llm(\/|$)/i,
  /(^|\/)llm-policy\.json$/i,
  /(^|\/)operations\.json$/i,
  /(^|\/)catalog\.json$/i,
  /(^|\/)snapshot\.json$/i,
  /(^|\/)[^/]*snapshot[^/]*\.json$/i,
];

const SECRET_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /SPACES_LLM_[0-9A-F]{32}_R[1-9][0-9]*_API_KEY/g, reason: "managed credential reference" },
  { re: /spaces-llm\/conn-[0-9a-f]{32}-rev-[1-9][0-9]*/g, reason: "credential record id" },
  { re: /["']?apiKey["']?\s*[:=]\s*["']?[^"'\s]+["']?/gi, reason: "apiKey field" },
  { re: /Authorization:\s*Bearer\s+\S+/gi, reason: "authorization header" },
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, reason: "key-like token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, reason: "private key block" },
  { re: /(?:^|[\s"'=])(?:\/(?:home|Users|root|opt|var)\/|[A-Za-z]:\\)/g, reason: "absolute path" },
];

export function forbiddenShareEntryReason(name: string): string | undefined {
  const normalized = name.replaceAll("\\", "/");
  if (FORBIDDEN_SHARE_ENTRY.some((re) => re.test(normalized))) {
    return "share entry is a secret, catalog, or Home-local LLM file";
  }
  return undefined;
}

export function scanShareText(path: string, text: string): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  const nameReason = forbiddenShareEntryReason(path);
  if (nameReason) findings.push({ path, reason: nameReason });
  for (const { re, reason } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) findings.push({ path, reason });
  }
  return findings;
}

export function scanShareEntries(entries: ReadonlyArray<{ name: string; data: Buffer | string }>): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  for (const entry of entries) {
    const text = typeof entry.data === "string" ? entry.data : entry.data.toString("utf8");
    findings.push(...scanShareText(entry.name, text));
  }
  return findings;
}

export function assertShareSecretFree(entries: ReadonlyArray<{ name: string; data: Buffer | string }>): void {
  const findings = scanShareEntries(entries);
  if (findings.length === 0) return;
  throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "share package contains a secret or Home-local credential reference", {
    path: findings[0].path,
    reason: findings[0].reason,
  });
}
