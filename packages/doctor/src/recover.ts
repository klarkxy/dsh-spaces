import type { HomeOperationLock } from "../../../src/adapters/node/home-operation-lock.ts";
import { EXIT, fail } from "./common.ts";

/** CLI already rejects these commands in index.ts. Kept as compile stubs. */
export async function runRecover(_lock: HomeOperationLock, _flags: Record<string, string>): Promise<number> {
  throw fail(EXIT.unsupported, "UNSUPPORTED", "That command is not supported.", { command: "recover" });
}

export async function runRollback(_lock: HomeOperationLock, _flags: Record<string, string>): Promise<number> {
  throw fail(EXIT.unsupported, "UNSUPPORTED", "That command is not supported.", { command: "rollback" });
}

export async function runUnlock(_lock: HomeOperationLock): Promise<number> {
  throw fail(EXIT.unsupported, "UNSUPPORTED", "That command is not supported.", { command: "unlock" });
}
