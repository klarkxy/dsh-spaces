import { existsSync } from "node:fs";
import { execSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import type { PluginQueueSnapshot } from "../shared/types";

let cachedBin: string | undefined;

export function dshBin(): string {
  if (cachedBin) return cachedBin;
  const candidates: string[] = [];
  if (process.platform === "win32" && process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  }
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    candidates.push(join(root, "@deepseek-ai", "dsh", "lib", "bin.js"));
  } catch {
    /* ignore */
  }
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error("dsh CLI not found. Install @deepseek-ai/dsh globally and retry.");
  }
  cachedBin = found;
  return cachedBin;
}

/** Electron's process.execPath is the app binary; force Node mode so dsh actually runs. */
export function spawnNode(args: string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(process.execPath, args, {
    ...options,
    env: {
      ...process.env,
      ...options.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
}

export function runDsh(
  dshHome: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  return new Promise((resolvePromise, reject) => {
    const child = spawnNode([dshBin(), ...args], {
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        npm_config_ignore_workspace_root_check: "true",
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`dsh ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code: code ?? 1 });
    });
  });
}

let pending = 0;
let current: string | undefined;
const queueListeners = new Set<(snap: PluginQueueSnapshot) => void>();

function emitQueue(): void {
  const snap = { pending, current };
  for (const listener of queueListeners) listener(snap);
}

export function onPluginQueue(listener: (snap: PluginQueueSnapshot) => void): () => void {
  queueListeners.add(listener);
  return () => queueListeners.delete(listener);
}

export function pluginQueueSnapshot(): PluginQueueSnapshot {
  return { pending, current };
}

let pluginTail: Promise<void> = Promise.resolve();

export function enqueuePlugin<T>(label: string, work: () => Promise<T>): Promise<T> {
  pending += 1;
  emitQueue();
  const run = pluginTail.then(
    async () => {
      current = label;
      emitQueue();
      try {
        return await work();
      } finally {
        pending -= 1;
        current = undefined;
        emitQueue();
      }
    },
    async () => {
      current = label;
      emitQueue();
      try {
        return await work();
      } finally {
        pending -= 1;
        current = undefined;
        emitQueue();
      }
    },
  );
  pluginTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function dshVersion(dshHome: string): Promise<string> {
  const { stdout, stderr, code } = await runDsh(dshHome, ["--version"], { timeoutMs: 20_000 });
  const text = `${stdout}\n${stderr}`;
  const match = text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  if (!match) {
    throw new Error(`could not parse dsh version (exit ${code}): ${text.slice(0, 200)}`);
  }
  return match[1];
}

export async function addWebApp(dshHome: string, name: string): Promise<void> {
  await enqueuePlugin(`plugin add ${name}`, async () => {
    const version = await dshVersion(dshHome);
    const spec = `@deepseek-ai/dsh-web-app@${version}`;
    const { stdout, stderr, code } = await runDsh(dshHome, ["plugin", "--profile", name, "add", spec]);
    if (code !== 0) {
      throw new Error(`plugin add ${spec} failed (${code}): ${(stderr || stdout).slice(0, 800)}`);
    }
  });
}
