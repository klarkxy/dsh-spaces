#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beginAcceptHandoffChild } from "../../../src/adapters/node/component-handoff.ts";
import {
  HomeController,
  parseControlEndpoint,
  type HomeControlHandle,
} from "../../../src/adapters/node/home-controller.ts";
import {
  bindSupervisorDiagnostics,
  type SupervisorDiagnosticsReporter,
} from "../../../src/adapters/node/supervisor-diagnostics.ts";
import {
  assertHandoffTokenMatchesSelectedPayload,
  bindSupervisorComponentPayload,
  createWorkbenchSupervisor,
  preflightSupervisorComponentPayload,
  parseSupervisorArgs,
  supervisorCliArgs,
  WorkbenchPublicError,
  type SupervisorCliOptions,
  type WorkbenchSupervisorHandle,
} from "../../../src/adapters/node/workbench-supervisor.ts";

export {
  assertHandoffTokenMatchesSelectedPayload,
  bindSupervisorComponentPayload,
  createWorkbenchSupervisor,
  preflightSupervisorComponentPayload,
  parseSupervisorArgs,
  supervisorCliArgs,
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
): Promise<number> {
  const options = parseSupervisorArgs(argv);
  let acceptSession: ReturnType<typeof beginAcceptHandoffChild> | undefined;
  let acceptedHandle: HomeControlHandle | undefined;
  if (options.acceptHandoff) {
    acceptSession = beginAcceptHandoffChild();
    try {
      bindSupervisorComponentPayload(options);
      const token = await acceptSession.token;
      if (!options.componentPayloadRoot) {
        throw new WorkbenchPublicError("workbench/invalid-input", "Handoff accept requires --component-payload.");
      }
      assertHandoffTokenMatchesSelectedPayload(token, options.componentPayloadRoot, process.argv[1]);
      await preflightSupervisorComponentPayload(options);
      const endpoint = parseControlEndpoint(`http://127.0.0.1:${options.port}`);
      acceptedHandle = await new HomeController(options.home, {
        allowRealHome: options.allowRealHome,
      }).acceptHandoff({ token, kind: "web", endpoint });
    } catch (error) {
      try {
        acceptSession.reportFailed("accept-failed");
      } catch {
        /* IPC may already be gone */
      }
      throw error;
    }
  } else {
    bindSupervisorComponentPayload(options);
  }
  if (!options.snapshotWorkerFile) {
    const packed = join(dirname(fileURLToPath(import.meta.url)), "../lib/snapshot-worker.mjs");
    if (existsSync(packed)) options.snapshotWorkerFile = packed;
  }
  let handle: WorkbenchSupervisorHandle | undefined;
  try {
    handle = await createWorkbenchSupervisor({
      ...options,
      acceptedHandle,
      onNormalExit: () => {
        recordQuietly(diagnostics, (reporter) => reporter.recordNormalStop({ exit: 0 }));
        process.exit(0);
      },
    });
    acceptSession?.reportAccepted();
  } catch (error) {
    try {
      acceptSession?.reportFailed("accept-failed");
    } catch {
      /* IPC may already be gone */
    }
    throw error;
  }
  process.stdout.write(`origin=${handle.origin}\n`);
  process.stdout.write(`bootstrap=${handle.bootstrapUrl}\n`);
  recordQuietly(diagnostics, (reporter) => reporter.recordReady());
  let stopping = false;
  const stop = async (signal?: string) => {
    if (stopping) return;
    stopping = true;
    await handle.close();
    recordQuietly(diagnostics, (reporter) => reporter.recordNormalStop({ exit: 0, signal: signal ?? null }));
    process.exit(0);
  };
  const onSignal = (signal: string) => {
    void stop(signal).catch((error) => {
      recordQuietly(diagnostics, (reporter) => reporter.recordFailure(error, { exit: 1, signal }));
      const message = error instanceof Error ? error.message : "supervisor stop failed";
      try {
        process.stderr.write(`${message}\n`);
      } catch {
        /* ignore */
      }
      process.exit(1);
    });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  await new Promise(() => undefined);
  return 0;
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
  main(process.argv.slice(2), diagnostics).then(
    (code) => {
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
