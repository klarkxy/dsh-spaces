export type DiagnosticLogLevel = "debug" | "info" | "error" | "fault";

export const DIAGNOSTIC_LOG_LEVELS: readonly DiagnosticLogLevel[] = ["debug", "info", "error", "fault"];

// Replaced by esbuild in npm/package builds. Source and tests retain debug.
declare const __DSH_SPACES_LOG_LEVEL__: DiagnosticLogLevel | undefined;

export const DEFAULT_DIAGNOSTIC_LOG_LEVEL: DiagnosticLogLevel =
  typeof __DSH_SPACES_LOG_LEVEL__ === "string" ? __DSH_SPACES_LOG_LEVEL__ : "debug";

export interface DiagnosticLogInput {
  level: DiagnosticLogLevel;
  event: string;
  message: string;
  context?: Record<string, string | number | boolean | null>;
  error?: unknown;
}

export interface DiagnosticLogEntry {
  version: 1;
  at: string;
  level: DiagnosticLogLevel;
  source: string;
  event: string;
  message: string;
  pid: number;
  context?: Record<string, string | number | boolean | null>;
  error?: { name: string; message: string; stack?: string; code?: string };
}

export function diagnosticLevelEnabled(level: DiagnosticLogLevel, minimum: DiagnosticLogLevel): boolean {
  return DIAGNOSTIC_LOG_LEVELS.indexOf(level) >= DIAGNOSTIC_LOG_LEVELS.indexOf(minimum);
}
