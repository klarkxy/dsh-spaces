import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import type { ProfileStatus } from "../shared/types";
import { dshBin, spawnNode } from "./dsh-cli";
import { PatchWriter, PatchVerifyError } from "./patch-writer";

export type StatusListener = (
  name: string,
  status: ProfileStatus,
  extra?: { port?: number; error?: string },
) => void;

interface RunningInstance {
  name: string;
  port: number;
  child: ChildProcess;
  status: ProfileStatus;
}

const DEFAULT_PORT_START = 3100;
const DEFAULT_PORT_END = 3199;
const READY_TIMEOUT_MS = 60_000;

function portClosed(port: number): Promise<boolean> {
  return new Promise((resolveClosed) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolveClosed(false);
    });
    socket.on("error", () => resolveClosed(true));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await portClosed(port))) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`port ${port} not ready within ${timeoutMs}ms`);
}

async function sessionList(port: number): Promise<void> {
  const origin = `http://127.0.0.1:${port}`;
  const res = await fetch(`${origin}/api/session.list`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method: "session.list",
      payload: {},
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`session.list HTTP ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { result?: { ok?: boolean } };
  if (!body.result?.ok) throw new Error(`session.list RPC failed: ${text.slice(0, 200)}`);
}

async function waitForApi(port: number, timeoutMs: number): Promise<void> {
  await waitForPort(port, timeoutMs);
  const start = Date.now();
  let last = "no attempt";
  while (Date.now() - start < timeoutMs) {
    try {
      await sessionList(port);
      return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error(`api on port ${port} not ready within ${timeoutMs}ms (${last})`);
}

async function pickFreePort(from: number, to: number, used: Set<number>): Promise<number> {
  const tryPort = (port: number): Promise<number | null> =>
    new Promise((resolveTry) => {
      const server = createServer();
      server.unref();
      server.once("error", () => resolveTry(null));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolveTry(port));
      });
    });

  for (let port = from; port <= to; port++) {
    if (used.has(port)) continue;
    const found = await tryPort(port);
    if (found !== null) return found;
  }
  throw new Error(`no free port in ${from}-${to}`);
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("exit", () => resolveKill());
      killer.on("error", () => resolveKill());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

export class ProcessManager {
  private readonly instances = new Map<string, RunningInstance>();
  private readonly listeners = new Set<StatusListener>();
  private readonly stopping = new Set<string>();
  private readonly errors = new Map<string, string>();
  private portStart: number;
  private portEnd: number;

  constructor(
    private readonly dshHome: string,
    private readonly patchWriter: PatchWriter,
    portStart = DEFAULT_PORT_START,
    portEnd = DEFAULT_PORT_END,
  ) {
    this.portStart = portStart;
    this.portEnd = portEnd;
  }

  setPortRange(start: number, end: number): void {
    this.portStart = start;
    this.portEnd = end;
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  statusOf(name: string): ProfileStatus {
    return this.instances.get(name)?.status ?? (this.errors.has(name) ? "crashed" : "stopped");
  }

  portOf(name: string): number | undefined {
    return this.instances.get(name)?.port;
  }

  lastError(name: string): string | undefined {
    return this.errors.get(name);
  }

  async start(name: string): Promise<{ port: number }> {
    const existing = this.instances.get(name);
    if (existing && (existing.status === "running" || existing.status === "starting")) {
      return { port: existing.port };
    }

    this.errors.delete(name);

    if (name !== "web") {
      try {
        await this.patchWriter.verify(name);
      } catch (err) {
        const message =
          err instanceof PatchVerifyError
            ? `Refusing to start ${name}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        this.errors.set(name, message);
        this.emit(name, "crashed", { error: message });
        throw err instanceof PatchVerifyError ? err : new PatchVerifyError(message);
      }
    }

    const used = new Set([...this.instances.values()].map((item) => item.port));
    const port = await pickFreePort(this.portStart, this.portEnd, used);
    this.emit(name, "starting", { port });

    const child = spawnNode(
      [dshBin(), "--profile", name, "--no-open", "--host", "127.0.0.1", "--port", String(port)],
      {
        env: { ...process.env, DSH_HOME: this.dshHome },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const instance: RunningInstance = { name, port, child, status: "starting" };
    this.instances.set(name, instance);

    child.on("exit", () => {
      const current = this.instances.get(name);
      if (!current || current.child !== child) return;
      this.instances.delete(name);
      if (this.stopping.has(name)) {
        this.stopping.delete(name);
        this.emit(name, "stopped");
        return;
      }
      const error = current.status === "starting" ? "process exited before ready" : "process exited unexpectedly";
      this.errors.set(name, error);
      this.emit(name, "crashed", { error });
    });

    try {
      await waitForApi(port, READY_TIMEOUT_MS);
      if (!this.instances.has(name)) {
        throw new Error(`${name} exited before the API opened`);
      }
      instance.status = "running";
      this.emit(name, "running", { port });
      return { port };
    } catch (err) {
      this.stopping.add(name);
      const pid = child.pid;
      if (pid) await killTree(pid);
      this.instances.delete(name);
      this.stopping.delete(name);
      const error = err instanceof Error ? err.message : String(err);
      this.errors.set(name, error);
      this.emit(name, "crashed", { error });
      throw err;
    }
  }

  async stop(name: string): Promise<void> {
    const instance = this.instances.get(name);
    this.stopping.add(name);
    const pid = instance?.child.pid;
    if (pid) await killTree(pid);
    this.instances.delete(name);
    this.stopping.delete(name);
    this.errors.delete(name);
    this.emit(name, "stopped");
  }

  async restart(name: string): Promise<{ port: number }> {
    await this.stop(name);
    return this.start(name);
  }

  async stopAll(): Promise<void> {
    const names = [...this.instances.keys()];
    for (const name of names) {
      await this.stop(name);
    }
  }

  private emit(name: string, status: ProfileStatus, extra?: { port?: number; error?: string }): void {
    for (const listener of this.listeners) listener(name, status, extra);
  }
}
