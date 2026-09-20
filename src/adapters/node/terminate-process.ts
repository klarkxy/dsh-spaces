import { execFile, type ChildProcess } from "node:child_process";

export class ProcessTerminationError extends Error {}

/** Wait for the owned process tree to stop before callers roll back its files. */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000 }, error => {
        if (error && child.exitCode === null && child.signalCode === null) reject(new ProcessTerminationError(`Could not stop subprocess ${pid}: ${error.message}`));
        else resolve();
      });
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch {} }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      child.off("exit", finish);
      reject(new ProcessTerminationError(`Subprocess ${pid} did not exit after termination.`));
    }, 3000);
    child.once("exit", finish);
  });
}
