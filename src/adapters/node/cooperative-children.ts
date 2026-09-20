import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";
import { PROFILE_NAME_RE } from "../../shared/types";
import { spawnNode } from "./dsh-cli";
import { withoutChildObservation } from "./owned-process-record";

// Node cannot deliver a catchable SIGTERM to a Windows console-less process.
// The inherited IPC descriptor is private to its parent; it asks DSH's own
// registered signal handler to dispose its Cordis application normally.
const STOP_IMPORT = `data:text/javascript,${encodeURIComponent(
  "import process from 'node:process';let pending=false,stopping=false;const stop=()=>{pending=true;if(!stopping&&process.listenerCount('SIGTERM')>0){stopping=true;process.emit('SIGTERM');}};process.on('message',m=>{if(m?.type==='dsh-spaces:stop')stop();});process.on('newListener',name=>{if(name==='SIGTERM'&&pending)queueMicrotask(stop);});process.channel?.unref();",
)}`;

export class CooperativeChildren {
  private readonly children = new Map<number, ChildProcess>();
  private readonly records = new Map<string, { pid: number; port: number; generation: number; startedAt: string }>();
  private generation = 0;

  constructor(private readonly options: { journalHome?: string; onJournalFailure?: () => void } = {}) {}

  ownsRecord(value: Record<string, unknown>): boolean {
    const record = typeof value.spaceId === "string" ? this.records.get(value.spaceId) : undefined;
    const child = record && this.children.get(record.pid);
    return Boolean(record && child && child.exitCode === null && child.signalCode === null && value.version === 1 &&
      value.origin === `http://127.0.0.1:${record.port}` &&
      ["pid", "port", "generation", "startedAt"].every(key => value[key] === record[key as keyof typeof record]));
  }

  spawn = (args: string[], options: SpawnOptions): ChildProcess => {
    const profile = args[args.indexOf("--profile") + 1];
    const port = Number(args[args.indexOf("--port") + 1]);
    let recordPath: string | undefined;
    const generation = ++this.generation;
    if (this.options.journalHome) {
      assertNotRealHome(this.options.journalHome);
      if (!PROFILE_NAME_RE.test(profile ?? "") || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("The child identity cannot be recorded.");
      }
      const directory = join(this.options.journalHome, ".dsh-spaces-control", "instances");
      mkdirSync(directory, { recursive: true });
      recordPath = join(directory, `${profile}.json`);
      atomicWrite(recordPath, JSON.stringify({ version: 1, spaceId: profile, phase: "spawning",
        port, generation, origin: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString() }));
    }
    const remove = () => {
      if (!recordPath) return;
      try { unlinkSync(recordPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.onJournalFailure?.(); }
    };
    let child: ChildProcess;
    try {
      child = withoutChildObservation(() => spawnNode(["--import", STOP_IMPORT, ...args], {
        ...options, stdio: ["ignore", "pipe", "pipe", "ipc"],
      }));
    } catch (error) { remove(); throw error; }
    if (child.pid) {
      const pid = child.pid;
      this.children.set(pid, child);
      if (recordPath) {
        const actual = { pid, port, generation, startedAt: new Date().toISOString() };
        try {
          atomicWrite(recordPath, JSON.stringify({ version: 1, spaceId: profile, ...actual,
            origin: `http://127.0.0.1:${port}` }));
          this.records.set(profile, actual);
        } catch { this.options.onJournalFailure?.(); }
      }
      child.once("exit", () => {
        this.children.delete(pid);
        if (this.records.get(profile)?.pid === pid) { this.records.delete(profile); remove(); }
      });
    } else child.once("error", remove);
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
