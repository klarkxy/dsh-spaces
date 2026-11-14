#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSupportedNode } from "../../../src/shared/node-version.ts";
import {
  bindSupervisorDiagnostics,
  type SupervisorDiagnosticsReporter,
} from "../../../src/adapters/node/diagnostics/supervisor-diagnostics.ts";
import { createDiagnosticLogger, installProcessDiagnosticLogging, type DiagnosticLogger } from "../../../src/adapters/node/diagnostics/rotating-log.ts";
import {
  bindSupervisorComponentPayload,
  createWorkbenchSupervisor,
  preflightSupervisorComponentPayload,
  parseSupervisorArgs,
  supervisorCliArgs,
  validateSupervisorComponentPayload,
  type SupervisorCliOptions,
  type WorkbenchSupervisorHandle,
} from "../../../src/adapters/node/workbench-supervisor.ts";
import type { ValidatedComponentPayload } from "../../../src/adapters/node/payload/component-payload.ts";
import { bindSupervisorLifetime, requireHostChannel, type HostChannel } from "./lifetime.ts";

export {
  bindSupervisorComponentPayload,
  createWorkbenchSupervisor,
  preflightSupervisorComponentPayload,
  parseSupervisorArgs,
  supervisorCliArgs,
  validateSupervisorComponentPayload,
};
export type { SupervisorCliOptions };

/**
 * Node-only launch/attach entry. Paths stay on this process; they are never
 * accepted from a browser DTO. Downstream DSH bootstrap/view-bridge should
 * spawn this CLI or call createWorkbenchSupervisor() with the same flags.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  diagnostics?: SupervisorDiagnosticsReporter,
  log?: DiagnosticLogger,
): Promise<number> {
  const options = parseSupervisorArgs(argv);
  const logger = log ?? createDiagnosticLogger(options.home, "supervisor", { allowRealHome: options.allowRealHome });
  logger.info("supervisor.starting", "Supervisor launch began.");
  try {
  assertSupportedNode();
  let hostChannel: HostChannel | undefined;
  if (options.exitWithHost) {
    hostChannel = requireHostChannel(process.send ? process : undefined);
  }
  // Validate the selected component payload once per launch and thread the
  // conclusion through bind/preflight/runtime construction. Every non-hash
  // check still runs in each stage; only the manifest read and file hashing
  // are computed a single time. Evaluating lazily keeps the failure at the
  // same stage ordering as before (first payload use fails the launch).
  let cachedPayload: ValidatedComponentPayload | undefined;
  const selectedPayload = (): ValidatedComponentPayload | undefined => {
    if (!cachedPayload && options.componentPayloadRoot !== undefined) {
      cachedPayload = validateSupervisorComponentPayload(options.componentPayloadRoot);
    }
    return cachedPayload;
  };
  bindSupervisorComponentPayload(options, selectedPayload());
  if (!options.snapshotWorkerFile) {
    const packed = join(dirname(fileURLToPath(import.meta.url)), "../lib/snapshot-worker.mjs");
    if (existsSync(packed)) options.snapshotWorkerFile = packed;
  }
  const handlePromise: Promise<WorkbenchSupervisorHandle> = createWorkbenchSupervisor({
    ...options,
    onNormalExit: () => {
      recordQuietly(diagnostics, (reporter) => reporter.recordNormalStop({ exit: 0 }));
      process.exit(0);
    },
  }, selectedPayload());
  const lifetime = bindSupervisorLifetime({
    handle: handlePromise,
    hostChannel,
    deps: {
      exit: (code) => process.exit(code),
      diagnostics,
      writeStderr: (text) => {
        try {
          process.stderr.write(text);
        } catch {
          /* ignore */
        }
      },
    },
  });
  const handle = await handlePromise;
  logger.info("supervisor.ready", "Supervisor accepted its management endpoint.", { port: new URL(handle.origin).port });
  process.stdout.write(`origin=${handle.origin}\n`);
  process.stdout.write(`bootstrap=${handle.bootstrapUrl}\n`);
  recordQuietly(diagnostics, (reporter) => reporter.recordReady());
  process.on("SIGINT", () => lifetime.onSignal("SIGINT"));
  process.on("SIGTERM", () => lifetime.onSignal("SIGTERM"));
  await new Promise(() => undefined);
  return 0;
  } catch (error) {
    logger.fault("supervisor.launch-failed", "Supervisor launch failed.", error);
    throw error;
  }
}

function recordQuietly(
  diagnostics: SupervisorDiagnosticsReporter | undefined,
  write: (reporter: SupervisorDiagnosticsReporter) => void,
): void {
  if (!diagnostics) return;
  try {
    write(diagnostics);
  } catch {
    /* reporting must not recurse into another fatal exception */
  }
}

function runInvokedSupervisor(): void {
  const diagnostics = bindSupervisorDiagnostics();
  recordQuietly(diagnostics, (reporter) => reporter.recordStarting());
  let logger: DiagnosticLogger | undefined;
  try {
    const parsed = parseSupervisorArgs(process.argv.slice(2));
    logger = createDiagnosticLogger(parsed.home, "supervisor", { allowRealHome: parsed.allowRealHome });
    installProcessDiagnosticLogging(logger);
  } catch {
    // Argument failures still reach main and its existing launch-failure report.
  }
  main(process.argv.slice(2), diagnostics, logger).then(
    (code) => {
      logger?.info("supervisor.normal-exit", "Supervisor completed its requested stop.", { exitCode: code });
      recordQuietly(diagnostics, (reporter) => reporter.recordNormalStop({ exit: code }));
      process.exit(code);
    },
    (error) => {
      recordQuietly(diagnostics, (reporter) => reporter.recordFailure(error, { exit: 1 }));
      const message = error instanceof Error ? error.message : "supervisor failed";
      try {
        process.stderr.write(`${message}\n`);
      } catch {
        /* ignore */
      }
      process.exit(1);
    },
  );
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  runInvokedSupervisor();
}
