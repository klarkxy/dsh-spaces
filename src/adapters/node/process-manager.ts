import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { t } from "../../shared/i18n";
import { formatWorkbenchFailure } from "../../shared/workbench";
import type { ProfileStatus } from "../../shared/types";
import { ensureDshCli, runDsh, spawnNode } from "./dsh-cli";
import { PatchWriter, PatchVerifyError } from "./patch-writer";
import { dshSessionCookie, dshSessionList, waitForDshEndpoint } from "./dsh-endpoint";

export type StatusListener = (
  name: string,
  status: ProfileStatus,
  extra?: { port?: number; error?: string },
) => void;

export type ProcessLogListener = (name: string, stream: "stdout" | "stderr", text: string) => void;

export type KillKind = "term" | "kill";

export interface ProcessRuntime {
  spawn: (args: string[], options: SpawnOptions) => ChildProcess;
  ensureCli: () => Promise<string>;
  prepareHome: (home: string) => Promise<void>;
  fetch: typeof fetch;
  extraEnv?: (name: string) => NodeJS.ProcessEnv;
  kill: (pid: number, kind: KillKind) => Promise<void>;
  readyTimeoutMs: number;
  fetchTimeoutMs: number;
  pollMs: number;
  gracefulWaitMs: number;
  forceWaitMs: number;
}

export class StartCancelledError extends Error {
  constructor() {
    super(t("errors.startCancelled"));
    this.name = "StartCancelledError";
  }
}

export function isStartCancelled(err: unknown): boolean {
  return err instanceof StartCancelledError || (err instanceof Error && err.name === "StartCancelledError");
}

export const LOG_LINE_OMITTED = "[omitted]\n";
const MAX_LOG_LINE = 8 * 1024;
const PORT_CONNECT_TIMEOUT_MS = 1_000;
const TASKKILL_TIMEOUT_MS = 5_000;

interface RunningInstance {
  name: string;
  port: number;
  child: ChildProcess;
  status: ProfileStatus;
  gen: number;
  url?: string;
}

const DEFAULT_PORT_START = 3100;
const DEFAULT_PORT_END = 3199;

const DEFAULT_RUNTIME: ProcessRuntime = {
  spawn: spawnNode,
  ensureCli: ensureDshCli,
  prepareHome: async (home) => {
    const result = await runDsh(home, ["--profile", "web", "--dump-config"], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`DSH shared dependencies could not be initialized (exit ${result.code}).`);
  },
  fetch: globalThis.fetch.bind(globalThis),
  kill: defaultKill,
  readyTimeoutMs: 60_000,
  fetchTimeoutMs: 3_000,
  pollMs: 400,
  gracefulWaitMs: 5_000,
  forceWaitMs: 3_000,
};

function defaultKill(pid: number, kind: KillKind): Promise<void> {
  if (process.platform === "win32") {
    const args = kind === "kill" ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
    return new Promise((resolveKill) => {
      const killer = spawn("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
      });
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

function portClosed(port: number): Promise<boolean> {
  return new Promise((resolveClosed) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: PORT_CONNECT_TIMEOUT_MS });
    const finish = (closed: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveClosed(closed);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.once("timeout", () => finish(true));
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

function cancelledError(): StartCancelledError {
  return new StartCancelledError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (isStartCancelled(reason)) throw cancelledError();
  if (reason instanceof Error) throw reason;
  throw cancelledError();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) {
      try {
        throwIfAborted(signal);
      } catch (err) {
        reject(err);
      }
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      try {
        throwIfAborted(signal);
      } catch (err) {
        reject(err);
      }
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function fetchSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return AbortSignal.any([parent, timeout]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class LineAssembler {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private dropping = false;

  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.take(text);
  }

  end(): string[] {
    const lines = this.take(this.decoder.end());
    if (this.dropping) {
      this.buffer = "";
      this.dropping = false;
      return lines;
    }
    if (this.buffer.length > 0) {
      lines.push(this.buffer);
      this.buffer = "";
    }
    return lines;
  }

  private take(text: string): string[] {
    const lines: string[] = [];
    this.buffer += text;
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) {
        if (this.buffer.length > MAX_LOG_LINE) {
          this.buffer = "";
          if (!this.dropping) {
            this.dropping = true;
            lines.push(LOG_LINE_OMITTED);
          }
        }
        return lines;
      }
      if (this.dropping) {
        this.buffer = this.buffer.slice(nl + 1);
        this.dropping = false;
        continue;
      }
      const line = this.buffer.slice(0, nl + 1);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > MAX_LOG_LINE) lines.push(LOG_LINE_OMITTED);
      else lines.push(line);
    }
  }
}

export class ProcessManager {
  private readonly instances = new Map<string, RunningInstance>();
  private readonly inFlightStarts = new Map<string, { gen: number; promise: Promise<{ port: number }> }>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly generations = new Map<string, number>();
  private readonly reservedPorts = new Set<number>();
  private readonly listeners = new Set<StatusListener>();
  private readonly logListeners = new Set<ProcessLogListener>();
  private readonly stopping = new Set<string>();
  private readonly errors = new Map<string, string>();
  private homePreparation: Promise<void> | undefined;
  private readonly runtime: ProcessRuntime;
  private portStart: number;
  private portEnd: number;

  constructor(
    private readonly dshHome: string,
    private readonly patchWriter: PatchWriter,
    portStart = DEFAULT_PORT_START,
    portEnd = DEFAULT_PORT_END,
    runtime: Partial<ProcessRuntime> = {},
  ) {
    this.portStart = portStart;
    this.portEnd = portEnd;
    this.runtime = { ...DEFAULT_RUNTIME, ...runtime };
  }

  setPortRange(start: number, end: number): void {
    this.portStart = start;
    this.portEnd = end;
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onLog(listener: ProcessLogListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  statusOf(name: string): ProfileStatus {
    return this.instances.get(name)?.status ?? (this.errors.has(name) ? "crashed" : "stopped");
  }

  portOf(name: string): number | undefined {
    return this.instances.get(name)?.port;
  }

  /** Main-process-only launch URL; never include it in profile status IPC or logs. */
  urlOf(name: string): string | undefined {
    return this.instances.get(name)?.url;
  }

  lastError(name: string): string | undefined {
    return this.errors.get(name);
  }

  start(name: string): Promise<{ port: number }> {
    const gen = this.generationOf(name);
    const shared = this.inFlightStarts.get(name);
    if (shared && shared.gen === gen) return shared.promise;

    const promise = this.enqueue(name, () => this.startOnce(name, gen));
    this.inFlightStarts.set(name, { gen, promise });
    const clear = () => {
      const current = this.inFlightStarts.get(name);
      if (current?.promise === promise) this.inFlightStarts.delete(name);
    };
    promise.then(clear, clear);
    return promise;
  }

  async stop(name: string): Promise<void> {
    this.invalidate(name);
    return this.enqueue(name, () => this.stopOnce(name));
  }

  async restart(name: string): Promise<{ port: number }> {
    this.invalidate(name);
    const gen = this.generationOf(name);
    return this.enqueue(name, async () => {
      await this.stopOnce(name);
      return this.startOnce(name, gen);
    });
  }

  async stopAll(): Promise<void> {
    const names = new Set([...this.instances.keys(), ...this.inFlightStarts.keys(), ...this.tails.keys()]);
    for (const name of names) this.invalidate(name);
    const results = await Promise.allSettled(
      [...names].map((name) => this.enqueue(name, () => this.stopOnce(name))),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length === 0) {
      // Maintenance can replace the runtime and remove its generated links.
      this.homePreparation = undefined;
      return;
    }
    const detail = failures.map((result) => errorMessage(result.reason)).join("; ");
    throw new Error(t("errors.stopFailed", { detail }));
  }

  private generationOf(name: string): number {
    return this.generations.get(name) ?? 0;
  }

  private invalidate(name: string): void {
    this.generations.set(name, this.generationOf(name) + 1);
    this.abortControllers.get(name)?.abort(cancelledError());
  }

  private enqueue<T>(name: string, op: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(name);
    const current = prev
      ? prev.then(
          () => op(),
          () => op(),
        )
      : op();
    this.tails.set(
      name,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  private async startOnce(name: string, gen: number): Promise<{ port: number }> {
    if (this.generationOf(name) !== gen) throw cancelledError();

    const existing = this.instances.get(name);
    if (existing && existing.gen === gen && (existing.status === "running" || existing.status === "starting")) {
      return { port: existing.port };
    }
    if (existing) {
      await this.terminate(existing);
      if (this.instances.get(name) === existing) {
        throw new Error(t("errors.processStillRunning", { name }));
      }
    }

    const abort = new AbortController();
    this.abortControllers.set(name, abort);

    this.errors.delete(name);
    let port: number | undefined;

    const ensureGen = () => {
      if (this.generationOf(name) !== gen) throw cancelledError();
      throwIfAborted(abort.signal);
    };

    try {
      ensureGen();

      // DSH builds profiles/node_modules non-atomically. Initialize it once
      // before parallel dump-config checks or long-running space processes.
      if (!this.homePreparation) {
        this.homePreparation = this.runtime.prepareHome(this.dshHome).catch(error => {
          this.homePreparation = undefined;
          throw error;
        });
      }
      await this.homePreparation;
      ensureGen();

      if (name !== "web") {
        try {
          await this.patchWriter.verify(name);
        } catch (err) {
          ensureGen();
          const message =
            err instanceof PatchVerifyError
              ? t("errors.refuseStart", { name, reason: err.message })
              : errorMessage(err);
          this.fail(name, message);
          throw err instanceof PatchVerifyError ? err : new PatchVerifyError(message);
        }
      }

      ensureGen();
      const bin = await this.runtime.ensureCli();
      ensureGen();

      port = await this.reservePort();
      ensureGen();
      this.emit(name, "starting", { port });

      const child = this.runtime.spawn(
        [bin, "--profile", name, "--no-open", "--host", "127.0.0.1", "--port", String(port)],
        {
          env: { DSH_HOME: this.dshHome, ...this.runtime.extraEnv?.(name) },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        },
      );

      const instance: RunningInstance = { name, port, child, status: "starting", gen };
      this.instances.set(name, instance);
      this.attachLogs(name, child);
      this.watchChild(instance, abort);
      if (child.exitCode !== null || child.signalCode !== null) {
        abort.abort(new Error(t("errors.exitedBeforeReady")));
      }

      child.once("error", (err) => {
        abort.abort(err);
      });

      const readyAt = Date.now();
      instance.url = await waitForDshEndpoint(child, port, abort.signal, this.runtime.readyTimeoutMs);
      const cookie = await dshSessionCookie(instance.url, this.runtime.fetch, fetchSignal(abort.signal, this.runtime.fetchTimeoutMs));
      await this.waitForApi(port, abort.signal, Math.max(1, this.runtime.readyTimeoutMs - (Date.now() - readyAt)), cookie);
      ensureGen();

      const current = this.instances.get(name);
      if (!current || current.child !== child) {
        throw new Error(t("errors.exitedBeforeApi", { name }));
      }
      current.status = "running";
      this.emit(name, "running", { port });
      return { port };
    } catch (err) {
      const cancelled =
        isStartCancelled(err) ||
        isStartCancelled(abort.signal.reason) ||
        this.generationOf(name) !== gen;
      await this.abandonStart(name, gen, port);
      if (this.instances.get(name)?.gen === gen) {
        throw err instanceof Error ? err : new Error(errorMessage(err));
      }
      if (cancelled) throw cancelledError();
      if (err instanceof PatchVerifyError) throw err;
      const message = errorMessage(err);
      if (!this.stopping.has(name) && this.generationOf(name) === gen) {
        this.fail(name, message);
      }
      throw err instanceof Error ? err : new Error(message);
    } finally {
      if (this.abortControllers.get(name) === abort) this.abortControllers.delete(name);
    }
  }

  private async stopOnce(name: string): Promise<void> {
    this.stopping.add(name);
    try {
      const instance = this.instances.get(name);
      if (instance) {
        await this.terminate(instance);
        if (this.instances.get(name) === instance) {
          this.forgetInstance(instance);
        }
      }
      this.errors.delete(name);
      this.emit(name, "stopped");
    } finally {
      this.stopping.delete(name);
    }
  }

  private watchChild(instance: RunningInstance, abort: AbortController): void {
    instance.child.once("exit", () => {
      const current = this.instances.get(instance.name);
      if (!current || current.child !== instance.child) return;
      this.forgetInstance(current);
      if (this.stopping.has(instance.name) || isStartCancelled(abort.signal.reason)) return;
      if (current.status === "starting") {
        abort.abort(new Error(t("errors.exitedBeforeReady")));
        return;
      }
      const code = instance.child.exitCode;
      const signal = instance.child.signalCode;
      this.fail(
        instance.name,
        formatWorkbenchFailure({
          spaceId: instance.name,
          stage: "run",
          pluginAttribution: "unknown",
          reason: t("errors.exitedUnexpectedly"),
          exitCode: code,
          signal,
        }),
      );
    });
  }

  private attachLogs(name: string, child: ChildProcess): void {
    const drain = (stream: "stdout" | "stderr") => {
      const readable = child[stream];
      if (!readable) return;
      const assembler = new LineAssembler();
      const emit = (lines: string[]) => {
        for (const line of lines) {
          for (const listener of this.logListeners) listener(name, stream, line.replace(/([?&]token=)[^\s&#]+/gi, "$1[redacted]"));
        }
      };
      readable.on("data", (chunk: Buffer | string) => emit(assembler.push(chunk)));
      readable.on("end", () => emit(assembler.end()));
    };
    drain("stdout");
    drain("stderr");
  }

  private async abandonStart(name: string, gen: number, port: number | undefined): Promise<void> {
    const instance = this.instances.get(name);
    if (instance && instance.gen === gen) {
      try {
        await this.terminate(instance);
      } catch (err) {
        this.errors.set(name, errorMessage(err));
        throw err instanceof Error ? err : new Error(errorMessage(err));
      }
      if (this.instances.get(name) === instance) this.forgetInstance(instance);
      return;
    }
    if (
      port !== undefined &&
      !this.instances.has(name) &&
      ![...this.instances.values()].some((item) => item.port === port)
    ) {
      this.reservedPorts.delete(port);
    }
  }

  private async terminate(instance: RunningInstance): Promise<void> {
    const child = instance.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    if (!pid) return;
    await this.runtime.kill(pid, "term");
    if (await waitForExit(child, this.runtime.gracefulWaitMs)) return;
    await this.runtime.kill(pid, "kill");
    if (await waitForExit(child, this.runtime.forceWaitMs)) return;
    const message = t("errors.processStillRunning", { name: instance.name });
    this.errors.set(instance.name, message);
    throw new Error(message);
  }

  private forgetInstance(instance: RunningInstance): void {
    const current = this.instances.get(instance.name);
    if (current === instance) this.instances.delete(instance.name);
    this.reservedPorts.delete(instance.port);
  }

  private fail(name: string, message: string): void {
    this.errors.set(name, message);
    this.emit(name, "crashed", { error: message });
  }

  private async reservePort(): Promise<number> {
    const from = this.portStart;
    const to = this.portEnd;
    for (let port = from; port <= to; port++) {
      if (this.reservedPorts.has(port)) continue;
      const taken = await this.tryReserve(port);
      if (taken) return port;
    }
    throw new Error(t("errors.noFreePort", { from, to }));
  }

  private tryReserve(port: number): Promise<boolean> {
    return new Promise((resolveTry) => {
      if (this.reservedPorts.has(port)) {
        resolveTry(false);
        return;
      }
      const server = createServer();
      server.unref();
      server.once("error", () => resolveTry(false));
      server.listen(port, "127.0.0.1", () => {
        this.reservedPorts.add(port);
        server.close(() => resolveTry(true));
      });
    });
  }

  private async waitForPort(port: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      throwIfAborted(signal);
      if (!(await portClosed(port))) return;
      await sleep(this.runtime.pollMs, signal);
    }
    throw new Error(t("errors.portNotReady"));
  }

  private async waitForApi(port: number, signal: AbortSignal, timeoutMs = this.runtime.readyTimeoutMs, cookie?: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.waitForPort(port, Math.max(1, deadline - Date.now()), signal);
    let last = "no attempt";
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await dshSessionList(port, this.runtime.fetch, fetchSignal(signal, Math.min(this.runtime.fetchTimeoutMs, remaining)), cookie);
        return;
      } catch (err) {
        throwIfAborted(signal);
        if (isStartCancelled(err)) throw err;
        last = errorMessage(err);
        const pause = Math.min(this.runtime.pollMs, deadline - Date.now());
        if (pause <= 0) break;
        await sleep(pause, signal);
      }
    }
    throw new Error(t("errors.apiNotReady", { port, timeout: timeoutMs, last }));
  }

  private emit(name: string, status: ProfileStatus, extra?: { port?: number; error?: string }): void {
    for (const listener of this.listeners) listener(name, status, extra);
  }
}
