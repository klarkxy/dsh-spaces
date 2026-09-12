import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawnNode } from "../../main/dsh-cli";

// Node cannot deliver a catchable SIGTERM to a Windows console-less process.
// The inherited IPC descriptor is private to its parent; it asks DSH's own
// registered signal handler to dispose its Cordis application normally.
const STOP_IMPORT = `data:text/javascript,${encodeURIComponent(
  "import process from 'node:process';process.on('message',m=>{if(m?.type==='dsh-spaces:stop'&&process.listenerCount('SIGTERM')>0)process.emit('SIGTERM');});process.channel?.unref();",
)}`;

export class CooperativeChildren {
  private readonly children = new Map<number, ChildProcess>();

  spawn = (args: string[], options: SpawnOptions): ChildProcess => {
    const child = spawnNode(["--import", STOP_IMPORT, ...args], {
      ...options, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    if (child.pid) {
      const pid = child.pid;
      this.children.set(pid, child);
      child.once("exit", () => this.children.delete(pid));
    }
    return child;
  };

  async stop(pid: number): Promise<void> {
    const child = this.children.get(pid);
    if (!child || !child.connected) throw new Error("The owned child has no cooperative stop channel.");
    await new Promise<void>((resolve, reject) => {
      child.send({ type: "dsh-spaces:stop" }, error => error ? reject(error) : resolve());
    });
  }
}
