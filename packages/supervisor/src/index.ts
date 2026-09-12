#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createWorkbenchSupervisor,
  parseSupervisorArgs,
  supervisorCliArgs,
  type SupervisorCliOptions,
} from "../../../src/adapters/node/workbench-supervisor.ts";

export { createWorkbenchSupervisor, parseSupervisorArgs, supervisorCliArgs };
export type { SupervisorCliOptions };

/**
 * Node-only launch/attach entry. Paths stay on this process; they are never
 * accepted from a browser DTO. Downstream DSH bootstrap/view-bridge should
 * spawn this CLI or call createWorkbenchSupervisor() with the same flags.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseSupervisorArgs(argv);
  if (!options.snapshotWorkerFile) {
    const packed = join(dirname(fileURLToPath(import.meta.url)), "../lib/snapshot-worker.mjs");
    if (existsSync(packed)) options.snapshotWorkerFile = packed;
  }
  const handle = await createWorkbenchSupervisor(options);
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
