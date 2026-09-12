import { spawn } from "node:child_process";
import type { KillKind } from "../../main/process-manager";

const TASKKILL_TIMEOUT_MS = 5_000;

/**
 * ProcessManager always follows SIGTERM with a force kill. Desktop hand-off
 * must not auto-F; callers flip `allowForce` only for explicit later work.
 */
export function createDesktopProcessKill(allowForce: () => boolean): (
  pid: number,
  kind: KillKind,
) => Promise<void> {
  return async (pid, kind) => {
    if (kind === "kill" && !allowForce()) {
      throw new Error("Forced stop is not allowed during desktop hand-off.");
    }
    await sendKill(pid, kind);
  };
}

function sendKill(pid: number, kind: KillKind): Promise<void> {
  if (process.platform === "win32") {
    const args = kind === "kill" ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
    return new Promise((resolveKill) => {
      const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => {
        killer.kill();
        resolveKill();
      }, TASKKILL_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        resolveKill();
      };
      killer.once("exit", done);
      killer.once("error", done);
    });
  }
  const signal = kind === "kill" ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
  return Promise.resolve();
}
