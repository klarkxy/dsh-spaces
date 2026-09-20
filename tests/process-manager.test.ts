import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { applyAppLocale } from "../src/shared/i18n/index.ts";
import type { PatchWriter } from "../src/adapters/node/patch-writer.ts";
import {
  isStartCancelled,
  LOG_LINE_OMITTED,
  ProcessManager,
  type ProcessRuntime,
} from "../src/adapters/node/process-manager.ts";
import {
  appIconPng,
  buildTrayMenuItems,
  concealWindowToTray,
  createAppTray,
  revealWindowFromTray,
  trayIconPng,
  type TrayElectron,
} from "../src/main/tray.ts";

applyAppLocale("en");

const FIXTURE = `
const http = require("node:http");
const port = Number(process.env.DSH_TEST_PORT);
const mode = process.env.DSH_TEST_MODE || "ok";
if (mode === "exit") process.exit(2);
if (mode === "hang") {
  setInterval(() => {}, 1e9);
} else {
  if (mode === "flood") {
    setInterval(() => {
      process.stdout.write("x".repeat(64) + "\\n");
      process.stderr.write("y".repeat(32) + "\\n");
    }, 10);
  }
  const server = http.createServer((req, res) => {
    if (mode === "slow-api") return;
    if (mode === "auth" && req.url === '/?token=fixture-launch-secret') {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-fixture=session-cookie; HttpOnly; Path=/' });
      return res.end();
    }
    if (mode === "auth" && req.headers.cookie !== 'dsh-auth-fixture=session-cookie') {
      res.writeHead(401); return res.end('authentication required');
    }
    if (mode === "auth" && req.url === '/api/session.list') {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: { ok: true } }));
  });
  server.listen(port, "127.0.0.1", () => console.log('dsh web: http://127.0.0.1:' + port + (mode === "auth" ? '/?token=fixture-launch-secret' : '')));
}
`;

const patchWriter = {
  verify: async () => undefined,
} as Pick<PatchWriter, "verify"> as PatchWriter;

const liveChildren = new Set<ChildProcess>();

function track(child: ChildProcess): ChildProcess {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  return child;
}

function spawnMode(mode: string) {
  return (args: string[], options: SpawnOptions = {}): ChildProcess => {
    const port = args[args.indexOf("--port") + 1];
    return track(
      spawn(process.execPath, ["-e", FIXTURE], {
        ...options,
        env: {
          ...process.env,
          ...(options.env as Record<string, string | undefined> | undefined),
          DSH_TEST_PORT: String(port),
          DSH_TEST_MODE: mode,
        },
      }),
    );
  };
}

async function killPid(pid: number): Promise<void> {
  await new Promise<void>((resolveKill) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("exit", () => resolveKill());
    killer.on("error", () => resolveKill());
  });
}

afterEach(async () => {
  await Promise.all(
    [...liveChildren].map(async (child) => {
      if (child.pid) await killPid(child.pid);
    }),
  );
});

function runtime(mode = "ok", extra: Partial<ProcessRuntime> = {}): Partial<ProcessRuntime> {
  return {
    ensureCli: async () => "bin.js",
    prepareHome: async () => undefined,
    spawn: spawnMode(mode),
    readyTimeoutMs: 5_000,
    fetchTimeoutMs: 400,
    pollMs: 30,
    gracefulWaitMs: 1_000,
    forceWaitMs: 1_000,
    ...extra,
  };
}

async function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no address"));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function withManager<T>(
  run: (processes: ProcessManager) => Promise<T>,
  options: { mode?: string; from?: number; to?: number; runtime?: Partial<ProcessRuntime> } = {},
): Promise<T> {
  const from = options.from ?? (await ephemeralPort());
  const to = options.to ?? from + 12;
  const processes = new ProcessManager(
    "unused-in-this-test",
    patchWriter,
    from,
    to,
    options.runtime ?? runtime(options.mode),
  );
  try {
    return await run(processes);
  } finally {
    await processes.stopAll().catch(() => undefined);
  }
}

test("authenticated runtime exchanges its launch token and keeps it out of status and logs", async () => {
  await withManager(async processes => {
    const logs: string[] = [];
    const statuses: unknown[] = [];
    processes.onLog((_name, _stream, text) => logs.push(text));
    processes.onStatus((...args) => statuses.push(args));
    const result = await processes.start("web");
    assert.equal(processes.statusOf("web"), "running");
    assert.equal(processes.urlOf("web"), `http://127.0.0.1:${result.port}/?token=fixture-launch-secret`);
    assert.deepEqual(Object.keys(result), ["port"]);
    assert.ok(logs.some(line => line.includes("token=[redacted]")));
    assert.ok(!JSON.stringify({ logs, statuses }).includes("fixture-launch-secret"));
    await processes.stop("web");
    assert.equal(processes.urlOf("web"), undefined);
  }, { mode: "auth" });
});

test("parallel spaces share dependency preparation and maintenance invalidates it", async () => {
  let preparations=0;
  await withManager(async processes=>{
    await Promise.all(['web','coding','writing'].map(name=>processes.start(name)));
    assert.equal(preparations,1);
    await processes.stopAll();
    await Promise.all(['web','coding'].map(name=>processes.start(name)));
    assert.equal(preparations,2);
  },{runtime:runtime('ok',{prepareHome:async()=>{preparations++; await delay(30);}})});
});

test("failed dependency preparation does not start a space and can be retried", async()=>{
  let preparations=0;
  await withManager(async processes=>{
    await assert.rejects(processes.start('web'),/prepare failed/);
    assert.equal(processes.portOf('web'),undefined);
    await processes.start('web');
    assert.equal(preparations,2);
  },{runtime:runtime('ok',{prepareHome:async()=>{if(++preparations===1) throw new Error('prepare failed');}})});
});

test("start shares one in-flight attempt for the same profile", async () => {
  let verifies = 0;
  const rejectVerify: Array<(reason: Error) => void> = [];
  const hangingWriter = {
    verify: () => {
      verifies += 1;
      return new Promise<void>((_resolve, reject) => rejectVerify.push(reject));
    },
  } as Pick<PatchWriter, "verify"> as PatchWriter;
  const processes = new ProcessManager("unused-in-this-test", hangingWriter, 3100, 3199, runtime("ok"));

  const first = processes.start("notes");
  const second = processes.start("notes");
  void first.catch(() => undefined);
  void second.catch(() => undefined);

  assert.equal(second, first);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(verifies, 1);

  rejectVerify[0](new Error("verification failed"));
  await assert.rejects(first, /verification failed/);
  await assert.rejects(second, /verification failed/);

  const retry = processes.start("notes");
  void retry.catch(() => undefined);
  assert.notEqual(retry, first);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(verifies, 2);
  rejectVerify[1](new Error("retry failed"));
  await assert.rejects(retry, /retry failed/);
});

async function waitStatus(processes: ProcessManager, name: string, status: string, timeoutMs = 3_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (processes.statusOf(name) === status) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${name} ${status}`));
    }, timeoutMs);
    const off = processes.onStatus((changed, next) => {
      if (changed === name && next === status) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
    if (processes.statusOf(name) === status) {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

test("start-stop-start does not reuse a cancelled start", async () => {
  let spawns = 0;
  let mode = "hang";
  await withManager(
    async (processes) => {
      const first = processes.start("web");
      void first.catch(() => undefined);
      await waitStatus(processes, "web", "starting");
      assert.equal(spawns, 1);
      const stopped = processes.stop("web");
      mode = "ok";
      const second = processes.start("web");
      assert.notEqual(second, first);
      await stopped;
      await assert.rejects(first, (err: unknown) => isStartCancelled(err));
      const result = await second;
      assert.equal(typeof result.port, "number");
      assert.equal(spawns, 2);
      assert.equal(processes.statusOf("web"), "running");
    },
    {
      runtime: runtime("hang", {
        spawn: (args, options) => {
          spawns += 1;
          return spawnMode(mode)(args, options);
        },
      }),
    },
  );
});

test("stop during starting cancels and does not resurrect", async () => {
  await withManager(async (processes) => {
    const seen: string[] = [];
    processes.onStatus((_name, status) => seen.push(status));
    const started = processes.start("web");
    void started.catch(() => undefined);
    await waitStatus(processes, "web", "starting");
    await processes.stop("web");
    await assert.rejects(started, (err: unknown) => isStartCancelled(err));
    assert.equal(processes.statusOf("web"), "stopped");
    assert.equal(processes.lastError("web"), undefined);
    assert.ok(!seen.includes("running"));
    assert.equal(seen.at(-1), "stopped");
  }, { mode: "hang" });
});

test("stopAll cancels pending starts", async () => {
  await withManager(async (processes) => {
    const first = processes.start("web");
    const second = processes.start("notes");
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    await waitStatus(processes, "web", "starting");
    await waitStatus(processes, "notes", "starting");
    await processes.stopAll();
    await assert.rejects(first, (err: unknown) => isStartCancelled(err));
    await assert.rejects(second, (err: unknown) => isStartCancelled(err));
    assert.equal(processes.statusOf("web"), "stopped");
    assert.equal(processes.statusOf("notes"), "stopped");
  }, { mode: "hang" });
});

test("different spaces start in parallel with distinct reserved ports", async () => {
  await withManager(async (processes) => {
    const [web, notes] = await Promise.all([processes.start("web"), processes.start("notes")]);
    assert.notEqual(web.port, notes.port);
    assert.equal(processes.statusOf("web"), "running");
    assert.equal(processes.statusOf("notes"), "running");
  });
});

test("port is released after stop and can be reused", async () => {
  const from = await ephemeralPort();
  await withManager(
    async (processes) => {
      const first = await processes.start("web");
      await processes.stop("web");
      const second = await processes.start("web");
      assert.equal(second.port, first.port);
    },
    { from, to: from },
  );
});

test("spawn error fails fast", async () => {
  const startedAt = Date.now();
  await withManager(
    async (processes) => {
      await assert.rejects(processes.start("web"), /spawn exploded/);
      assert.equal(processes.statusOf("web"), "crashed");
      assert.match(processes.lastError("web") ?? "", /spawn exploded/);
      assert.ok(Date.now() - startedAt < 2_000);
    },
    {
      runtime: runtime("ok", {
        spawn: () => {
          throw new Error("spawn exploded");
        },
      }),
    },
  );
});

test("early exit fails fast without waiting for the ready timeout", async () => {
  const startedAt = Date.now();
  await withManager(
    async (processes) => {
      await assert.rejects(processes.start("web"), /closed before it finished starting/);
      assert.equal(processes.statusOf("web"), "crashed");
      assert.ok(Date.now() - startedAt < 2_000);
    },
    { mode: "exit", runtime: runtime("exit", { readyTimeoutMs: 8_000 }) },
  );
});

test("API poll uses per-fetch timeout and a bounded overall wait", async () => {
  const startedAt = Date.now();
  await withManager(
    async (processes) => {
      await assert.rejects(processes.start("web"), /not ready|didn't open|未就绪/i);
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= 300, `too fast: ${elapsed}`);
      assert.ok(elapsed < 4_000, `unbounded wait: ${elapsed}`);
    },
    { runtime: runtime("slow-api", { readyTimeoutMs: 800, fetchTimeoutMs: 80, pollMs: 20 }) },
  );
});

test("stdout and stderr are consumed and forwarded to onLog", async () => {
  await withManager(async (processes) => {
    const chunks: Array<{ stream: string; text: string }> = [];
    processes.onLog((_name, stream, text) => chunks.push({ stream, text }));
    await processes.start("web");
    await delay(40);
    assert.ok(chunks.some((chunk) => chunk.stream === "stdout" && chunk.text.includes("x")));
    assert.ok(chunks.some((chunk) => chunk.stream === "stderr" && chunk.text.includes("y")));
  }, { mode: "flood" });
});

test("stop reports stopped only after the owned process exits", async () => {
  let child: ChildProcess | undefined;
  await withManager(
    async (processes) => {
      await processes.start("web");
      assert.ok(child?.pid);
      let exitAt = 0;
      let stoppedAt = 0;
      child.once("exit", () => {
        exitAt = Date.now();
      });
      processes.onStatus((_name, status) => {
        if (status === "stopped") stoppedAt = Date.now();
      });
      await processes.stop("web");
      assert.ok(exitAt > 0);
      assert.ok(stoppedAt >= exitAt);
      assert.equal(processes.statusOf("web"), "stopped");
    },
    {
      runtime: runtime("ok", {
        spawn: (args, options) => {
          child = spawnMode("ok")(args, options);
          return child;
        },
      }),
    },
  );
});

test("cleanup failure keeps the error and does not report stopped", async () => {
  let child: ChildProcess | undefined;
  await withManager(
    async (processes) => {
      await processes.start("web");
      await assert.rejects(processes.stop("web"), /still running/);
      assert.notEqual(processes.statusOf("web"), "stopped");
      assert.match(processes.lastError("web") ?? "", /still running/);
    },
    {
      runtime: runtime("ok", {
        spawn: (args, options) => {
          child = spawnMode("ok")(args, options);
          return child;
        },
        kill: async () => undefined,
        gracefulWaitMs: 60,
        forceWaitMs: 60,
      }),
    },
  );
  if (child?.pid) await killPid(child.pid);
});

test("stop tries a graceful terminate before a forced kill", async () => {
  const kinds: string[] = [];
  await withManager(
    async (processes) => {
      await processes.start("web");
      await processes.stop("web");
      assert.deepEqual(kinds, ["term", "kill"]);
      assert.equal(processes.statusOf("web"), "stopped");
    },
    {
      runtime: runtime("ok", {
        kill: async (pid, kind) => {
          kinds.push(kind);
          if (kind === "kill") {
            await new Promise<void>((resolveKill) => {
              const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
              });
              killer.on("exit", () => resolveKill());
              killer.on("error", () => resolveKill());
            });
          }
        },
        gracefulWaitMs: 80,
        forceWaitMs: 1_000,
      }),
    },
  );
});

test("stop does not kill an unrelated process", async () => {
  const extra = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    assert.ok(extra.pid);
    await withManager(async (processes) => {
      await processes.start("web");
      await processes.stop("web");
      process.kill(extra.pid as number, 0);
    });
    process.kill(extra.pid as number, 0);
  } finally {
    extra.kill();
  }
});

test("same-space start and stop run in order", async () => {
  let mode = "hang";
  const events: string[] = [];
  await withManager(
    async (processes) => {
      processes.onStatus((_name, status) => events.push(status));
      const started = processes.start("web");
      void started.catch(() => undefined);
      await waitStatus(processes, "web", "starting");
      const stopped = processes.stop("web");
      await stopped;
      await assert.rejects(started, (err: unknown) => isStartCancelled(err));
      mode = "ok";
      await processes.start("web");
      assert.equal(processes.statusOf("web"), "running");
      const startIndex = events.indexOf("starting");
      const stopIndex = events.lastIndexOf("stopped");
      const runningIndex = events.lastIndexOf("running");
      assert.ok(startIndex >= 0);
      assert.ok(stopIndex > startIndex);
      assert.ok(runningIndex > stopIndex);
    },
    {
      runtime: runtime("hang", {
        spawn: (args, options) => spawnMode(mode)(args, options),
      }),
    },
  );
});

test("spawn error on the child object fails fast", async () => {
  await withManager(
    async (processes) => {
      const startedAt = Date.now();
      await assert.rejects(processes.start("web"), /broken pipe/);
      assert.ok(Date.now() - startedAt < 2_000);
      assert.equal(processes.statusOf("web"), "crashed");
    },
    {
      runtime: runtime("ok", {
        spawn: () => {
          const child = new EventEmitter() as unknown as ChildProcess;
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.pid = undefined;
          child.exitCode = null;
          child.signalCode = null;
          queueMicrotask(() => child.emit("error", new Error("broken pipe")));
          return child;
        },
        kill: async () => undefined,
      }),
    },
  );
});

test("a child that shifts ports cannot make an unrelated API appear ready", async () => {
  const from = await ephemeralPort();
  let alternate = await ephemeralPort();
  while (alternate === from) alternate = await ephemeralPort();
  const unrelated = createServer(socket => socket.end());
  let probes = 0;
  try {
    await withManager(async manager => {
      await assert.rejects(manager.start("web"), /instead of the reserved/);
      assert.equal(probes, 0);
      assert.ok(unrelated.listening, "the unrelated listener must remain alive");
    }, { from, to: from, runtime: runtime("ok", {
      spawn: (args, options) => {
        unrelated.listen(from, "127.0.0.1");
        const shifted = args.slice(); shifted[shifted.indexOf("--port") + 1] = String(alternate);
        return spawnMode("ok")(shifted, options);
      },
      fetch: async () => { probes++; return new Response(JSON.stringify({ result: { ok: true } })); },
    }) });
  } finally { if (unrelated.listening) await new Promise<void>(resolve => unrelated.close(() => resolve())); }
});

test("tray icon is a local PNG buffer", () => {
  const png = trayIconPng();
  assert.equal(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
  assert.ok(png.length > 500);
  const app = appIconPng();
  assert.equal(app.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
  assert.equal(app.readUInt32BE(16), 256);
  assert.equal(app.readUInt32BE(20), 256);
});

test("tray menu shows the window, space status, stop all, and quit", () => {
  const items = buildTrayMenuItems([
    { name: "web", displayName: "Home", status: "running" },
    { name: "notes", displayName: "Notes", status: "stopped" },
  ]);
  const ids = items.map((item) => ("id" in item ? item.id : item.type));
  assert.deepEqual(ids.slice(0, 2), ["show", "separator"]);
  assert.ok(ids.includes("stop-all"));
  assert.ok(ids.includes("quit"));
  const running = items.find((item) => "id" in item && item.id === "space:web");
  const stopped = items.find((item) => "id" in item && item.id === "space:notes");
  assert.ok(running && "label" in running && running.label.includes("Home"));
  assert.ok(running && "enabled" in running && running.enabled === false);
  assert.ok(stopped && "label" in stopped && stopped.label.includes("Notes"));
});

test("createAppTray is unavailable when the host has no tray", () => {
  const handle = createAppTray(
    {
      Tray: class {
        static isSupported() {
          return false;
        }
        constructor() {
          throw new Error("should not construct");
        }
      },
      Menu: { buildFromTemplate: () => ({}) },
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
    } as unknown as TrayElectron,
    { getSpaces: () => [], onShow() {}, onStopAll() {}, onQuit() {} },
  );
  assert.equal(handle.available, false);
});

test("createAppTray wires show, stop all, and quit", () => {
  const clicks: string[] = [];
  let constructed: {
    click?: () => void;
    menu?: Array<{ id?: string; click?: () => void }>;
    destroyed?: boolean;
  } = {};
  class FakeTray {
    static isSupported() {
      return true;
    }
    constructor(_image: { isEmpty?: () => boolean }) {
      constructed = this;
    }
    setToolTip(_text: string) {}
    setContextMenu(menu: Array<{ id?: string; click?: () => void }>) {
      constructed.menu = menu;
    }
    on(event: "click", listener: () => void) {
      if (event === "click") constructed.click = listener;
    }
    destroy() {
      constructed.destroyed = true;
    }
  }
  const handle = createAppTray(
    {
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => template },
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
    } as unknown as TrayElectron,
    {
      getSpaces: () => [{ name: "web", displayName: "Home", status: "running" }],
      onShow: () => clicks.push("show"),
      onStopAll: () => clicks.push("stop-all"),
      onQuit: () => clicks.push("quit"),
    },
  );
  assert.equal(handle.available, true);
  constructed.click?.();
  const byId = Object.fromEntries((constructed.menu ?? []).filter((item) => item.id).map((item) => [item.id, item]));
  byId["stop-all"]?.click?.();
  byId.quit?.click?.();
  assert.deepEqual(clicks, ["show", "stop-all", "quit"]);
  handle.destroy();
  assert.equal(constructed.destroyed, true);
});

test("close conceals the window to the tray instead of minimizing", () => {
  const calls: string[] = [];
  const win = {
    setSkipTaskbar: (skip: boolean) => {
      calls.push(`skip:${skip}`);
    },
    hide: () => {
      calls.push("hide");
    },
    show: () => {
      calls.push("show");
    },
    focus: () => {
      calls.push("focus");
    },
    restore: () => {
      calls.push("restore");
    },
    isMinimized: () => false,
    isDestroyed: () => false,
  };
  concealWindowToTray(win);
  assert.deepEqual(calls, ["skip:true", "hide"]);
  revealWindowFromTray(win);
  assert.deepEqual(calls, ["skip:true", "hide", "skip:false", "show", "focus"]);
});

test("revealing a minimized hidden window restores it onto the taskbar", () => {
  const calls: string[] = [];
  const win = {
    setSkipTaskbar: (skip: boolean) => {
      calls.push(`skip:${skip}`);
    },
    hide: () => {
      calls.push("hide");
    },
    show: () => {
      calls.push("show");
    },
    focus: () => {
      calls.push("focus");
    },
    restore: () => {
      calls.push("restore");
    },
    isMinimized: () => true,
    isDestroyed: () => false,
  };
  concealWindowToTray(win);
  revealWindowFromTray(win);
  assert.deepEqual(calls, ["skip:true", "hide", "skip:false", "restore", "show", "focus"]);
});

test("handled rejected start does not create unhandledRejection", async () => {
  const unhandled: string[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(String(err));
  process.on("unhandledRejection", onUnhandled);
  try {
    const processes = new ProcessManager("unused-in-this-test", {
      verify: async () => {
        throw new Error("expected verification failure");
      },
    } as Pick<PatchWriter, "verify"> as PatchWriter, 3100, 3199, runtime());
    await processes.start("coding").catch(() => undefined);
    await delay(30);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("queued restart after stopAll does not call ensureCli", async () => {
  let release: (() => void) | undefined;
  let ensureCalls = 0;
  const processes = new ProcessManager(
    "unused-in-this-test",
    {
      verify: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    } as Pick<PatchWriter, "verify"> as PatchWriter,
    51001,
    51001,
    {
      prepareHome: async () => undefined,
      ensureCli: async () => {
        ensureCalls += 1;
        throw new Error("should never try to start cancelled queued work");
      },
    },
  );
  const first = processes.start("coding").catch(() => undefined);
  const restart = processes.restart("coding").catch(() => undefined);
  const stop = processes.stopAll();
  release?.();
  await Promise.allSettled([first, restart, stop]);
  await delay(20);
  assert.equal(ensureCalls, 0);
});

test("kill failure keeps port reservation and process ownership", async () => {
  const from = await ephemeralPort();
  await withManager(
    async (processes) => {
      await processes.start("web");
      const port = processes.portOf("web");
      assert.equal(typeof port, "number");
      await assert.rejects(processes.stop("web"), /still running/);
      assert.equal(processes.portOf("web"), port);
      assert.notEqual(processes.statusOf("web"), "stopped");
      await assert.rejects(processes.start("notes"), /No free port|没有空闲端口|noFreePort/i);
      assert.equal(processes.portOf("web"), port);
    },
    {
      from,
      to: from,
      runtime: runtime("ok", {
        kill: async () => undefined,
        gracefulWaitMs: 60,
        forceWaitMs: 60,
      }),
    },
  );
});

test("fragmented UTF-8 password log is one complete line", async () => {
  const line = "user 密码=hunter2\n";
  const encoded = Buffer.from(line, "utf8");
  await withManager(
    async (processes) => {
      const entries: string[] = [];
      processes.onLog((_name, stream, text) => {
        if (stream === "stdout") entries.push(text);
      });
      await processes.start("web");
      await delay(40);
      const joined = entries.join("");
      assert.equal(entries.filter((item) => item.includes("hunter2")).length, 1);
      assert.ok(joined.includes("密码=hunter2"));
      assert.ok(!entries.some((item) => item.includes("密") && !item.includes("码")));
    },
    {
      runtime: runtime("ok", {
        spawn: (args, options) => {
          const port = args[args.indexOf("--port") + 1];
          const script = `
const http = require("node:http");
const line = Buffer.from(${JSON.stringify(line)});
process.stdout.write(line.subarray(0, 6));
process.stdout.write(line.subarray(6));
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ result: { ok: true } }));
}).listen(${Number(port)}, "127.0.0.1", () => console.log('dsh web: http://127.0.0.1:${Number(port)}'));
`;
          return track(spawn(process.execPath, ["-e", script], options));
        },
      }),
    },
  );
});

test("overlong log without newline is omitted instead of leaked", async () => {
  await withManager(
    async (processes) => {
      const entries: string[] = [];
      processes.onLog((_name, stream, text) => {
        if (stream === "stdout") entries.push(text);
      });
      await processes.start("web");
      await delay(40);
      assert.ok(entries.includes(LOG_LINE_OMITTED));
      assert.ok(!entries.some((item) => item.includes("hunter2")));
    },
    {
      runtime: runtime("ok", {
        spawn: (args, options) => {
          const port = args[args.indexOf("--port") + 1];
          const script = `
const http = require("node:http");
process.stdout.write("password=hunter2" + "x".repeat(9000));
process.stdout.write("\\n");
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ result: { ok: true } }));
}).listen(${Number(port)}, "127.0.0.1", () => console.log('dsh web: http://127.0.0.1:${Number(port)}'));
`;
          return track(spawn(process.execPath, ["-e", script], options));
        },
      }),
    },
  );
});

test("createAppTray returns unavailable instead of throwing", () => {
  const handle = createAppTray(
    {
      Tray: class {
        static isSupported() {
          return true;
        }
        constructor() {
          throw new Error("tray host failed");
        }
      },
      Menu: { buildFromTemplate: () => ({}) },
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
    } as unknown as TrayElectron,
    { getSpaces: () => [], onShow() {}, onStopAll() {}, onQuit() {} },
  );
  assert.equal(handle.available, false);
});
