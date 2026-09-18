import { mkdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { LLM_ERROR, LlmConfigError } from "../../core/domain/llm-connections";

const LOCK_WAIT_MS = 2000;

/** Exclusive directory lock for one catalog/policy commit. Waiting is lock acquire, not a failed-operation retry. */
export function withExclusiveDir<T>(lockDir: string, fn: () => T): T {
  mkdirSync(dirname(lockDir), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "llm file write lock timed out");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lockDir);
  }
}
