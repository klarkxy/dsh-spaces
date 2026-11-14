import { resolve } from "node:path";
import { createDiagnosticLogger, type DiagnosticLogger } from "./rotating-log";

const hostProcessLoggers = new Map<string, DiagnosticLogger>();

export function hostProcessDiagnosticLogger(
  home: string,
  options: { allowRealHome?: boolean } = {},
): DiagnosticLogger {
  const allowRealHome = options.allowRealHome === true;
  const normalized = resolve(home);
  const key = `${process.platform === "win32" ? normalized.toLowerCase() : normalized}\0${allowRealHome ? "1" : "0"}`;
  let logger = hostProcessLoggers.get(key);
  if (!logger) {
    logger = createDiagnosticLogger(normalized, "host", { allowRealHome });
    hostProcessLoggers.set(key, logger);
  }
  return logger;
}

interface CordisLogMessage {
  type?: unknown;
  name?: unknown;
  args?: unknown;
}

interface CordisLogService {
  exporter(exporter: {
    levels?: Record<string, number>;
    export(message: CordisLogMessage): void;
  }): () => void;
}

export function attachHostDiagnosticLogger(ctx: unknown, logger: DiagnosticLogger): () => void {
  const service = (ctx as { logger?: CordisLogService }).logger;
  if (!service || typeof service.exporter !== "function") throw new Error("The host logging service is unavailable.");
  return service.exporter({
    levels: { default: 3 },
    export(message) {
      const type = message.type === "debug" || message.type === "info" || message.type === "error" ? message.type : undefined;
      if (!type) return;
      const source = typeof message.name === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(message.name) ? message.name : "unknown";
      logger.write({ level: type, event: "host.log", message: formatMessage(message.args), context: { logger: source } });
    },
  });
}

function formatMessage(args: unknown): string {
  if (!Array.isArray(args)) return "The host emitted a diagnostic record without arguments.";
  const first = args[0];
  if (first instanceof Error) return first.stack ?? first.message;
  return args.map(value => typeof value === "string" ? value : safeJson(value)).join(" ") || "[empty host log]";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable host value]";
  }
}
