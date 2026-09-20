#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runComponentLauncher } from "../../../src/adapters/node/component-handoff.ts";

export {
  acceptHandoffFromIpc,
  beginAcceptHandoffChild,
  runComponentLauncher,
  spawnComponentLauncher,
} from "../../../src/adapters/node/component-handoff.ts";

/**
 * One-shot component launcher. Secrets arrive only over inherited Node IPC.
 * Primary wires `--accept-handoff` on the Supervisor CLI after B2 releases
 * those paths. `acceptHandoffFromIpc` reports IPC `accepted` only after its
 * `startup` callback. This entry does not create backends or open management HTTP.
 */
export async function main(): Promise<number> {
  return runComponentLauncher();
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().then(
    (code) => process.exit(code),
    () => {
      try {
        process.stderr.write("invalid-commit\n");
      } catch {
        /* ignore */
      }
      process.exit(1);
    },
  );
}
