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
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
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
  const stop = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await new Promise(() => undefined);
  return 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const message = error instanceof Error ? error.message : "supervisor failed";
      process.stderr.write(`${message}\n`);
      process.exit(1);
    },
  );
}
