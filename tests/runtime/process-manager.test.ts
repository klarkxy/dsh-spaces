import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { applyAppLocale } from "../../src/shared/i18n/index.ts";
import { PatchVerifyError, type PatchWriter } from "../../src/adapters/node/profile/patch-writer.ts";
import {
  isStartCancelled,
  LOG_LINE_OMITTED,
  ProcessManager,
  type ProcessRuntime,
} from "../../src/adapters/node/runtime/process-manager.ts";
import { StartFailureError } from "../../src/adapters/node/runtime/start-failure.ts";

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
  const authed = mode === "auth" || mode === "slow-auth";
  const server = http.createServer((req, res) => {
    if (mode === "slow-api") return;
    if (authed && req.url === '/?token=fixture-launch-secret') {
      const respond = () => {
        res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-fixture=session-cookie; HttpOnly; Path=/' });
        res.end();
      };
      if (mode === "slow-auth") {
        console.log('token-request');
        return setTimeout(respond, Number(process.env.DSH_TEST_AUTH_DELAY_MS) || 0);
      }
      return respond();
    }
    if (authed && req.headers.cookie !== 'dsh-auth-fixture=session-cookie') {
      res.writeHead(401); return res.end('authentication required');
    }
    if (authed && req.url === '/api/session.list') {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: { ok: true } }));
  });
  server.listen(port, "127.0.0.1", () => console.log('dsh web: http://127.0.0.1:' + port + (authed ? '/?token=fixture-launch-secret' : '')));
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

test("launch token exchange slower than the fetch timeout completes within the readiness deadline", async () => {
  await withManager(async processes => {
    const logs: string[] = [];
    processes.onLog((_name, _stream, text) => logs.push(text));
    await processes.start("web");
    assert.equal(processes.statusOf("web"), "running");
    assert.equal(logs.filter(line => line.includes("token-request")).length, 1);
  }, {
    mode: "slow-auth",
    runtime: runtime("slow-auth", {
      fetchTimeoutMs: 400,
      readyTimeoutMs: 5_000,
      extraEnv: () => ({ DSH_TEST_AUTH_DELAY_MS: "900" }),
    }),
  });
});

test("launch token exchange is one request bounded by the remaining readiness time", async () => {
  await withManager(async processes => {
    const logs: string[] = [];
    processes.onLog((_name, _stream, text) => logs.push(text));
    await assert.rejects(processes.start("web"));
    assert.notEqual(processes.statusOf("web"), "running");
    assert.equal(logs.filter(line => line.includes("token-request")).length, 1);
  }, {
    mode: "slow-auth",
    runtime: runtime("slow-auth", {
      fetchTimeoutMs: 400,
      readyTimeoutMs: 1_500,
      extraEnv: () => ({ DSH_TEST_AUTH_DELAY_MS: "4000" }),
    }),
  });
});

test("DSH children are launched with --expose-internals before the CLI script", async () => {
  let seen: string[] = [];
  await withManager(async processes => {
    await processes.start("web");
    assert.equal(processes.statusOf("web"), "running");
  }, {
    runtime: runtime("ok", {
      spawn: (args, options) => {
        seen = args.slice();
        return spawnMode("ok")(args, options);
      },
    }),
  });
  assert.deepEqual(seen.slice(0, 2), ["--expose-internals", "bin.js"]);
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
  const fetches: string[] = [];
  const hangingFetch = ((_input: unknown, init?: RequestInit) => {
    fetches.push(String(_input));
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
  await withManager(
    async (processes) => {
      await assert.rejects(processes.start("web"), /not ready|didn't open|未就绪/i);
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= 300, `too fast: ${elapsed}`);
      // A hung fetch that is never timed out would leave start() pending forever;
      // any rejection proves per-fetch aborts fired. The poll count bounds the
      // overall wait independent of timer starvation under parallel load.
      assert.ok(fetches.length >= 1, `no fetch attempted`);
      assert.ok(fetches.length <= 60, `unbounded polling: ${fetches.length} fetches`);
      assert.ok(elapsed < 30_000, `unbounded wait: ${elapsed}`);
    },
    { runtime: runtime("slow-api", { readyTimeoutMs: 800, fetchTimeoutMs: 80, pollMs: 20, fetch: hangingFetch }) },
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
          Object.assign(child, { pid: undefined, exitCode: null, signalCode: null });
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

function idleChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  Object.assign(child, { pid: 424242, exitCode: null, signalCode: null });
  return child;
}

function markExited(child: ChildProcess, code = 0): void {
  Object.assign(child, { exitCode: code });
  child.emit("exit", code, null);
}

test("single start failure keeps the original error when cleanup succeeds", async () => {
  const original = new Error("spawn socket failed");
  let spawns = 0;
  let child: ChildProcess | undefined;
  const kills: string[] = [];
  await withManager(async (processes) => {
    const states: string[] = [];
    processes.onStatus((_name, status) => states.push(status));
    await assert.rejects(processes.start("web"), (err: unknown) => err === original);
    assert.equal(processes.statusOf("web"), "crashed");
    assert.equal(processes.portOf("web"), undefined);
    assert.equal(processes.lastError("web"), original.message);
    assert.equal(processes.lastError("web")?.includes("Cleanup"), false);
    assert.equal(spawns, 1);
    assert.deepEqual(kills, ["term"]);
    assert.equal(states.includes("crashed"), true);
    assert.equal(states.includes("stopped"), false);
  }, {
    runtime: runtime("ok", {
      spawn: () => {
        spawns += 1;
        child = idleChild();
        queueMicrotask(() => child?.emit("error", original));
        return child;
      },
      kill: async (_pid, kind) => {
        kills.push(kind);
        if (child) markExited(child);
      },
      readyTimeoutMs: 400,
      gracefulWaitMs: 20,
      forceWaitMs: 20,
    }),
  });
});

test("early exit keeps the original failure without a second cause", async () => {
  let spawns = 0;
  const kills: string[] = [];
  await withManager(async (processes) => {
    await assert.rejects(processes.start("web"), (err: unknown) => {
      assert.equal(err instanceof StartFailureError, false);
      assert.match(String(err), /closed before it finished starting/);
      return true;
    });
    assert.equal(processes.statusOf("web"), "crashed");
    assert.equal(processes.portOf("web"), undefined);
    assert.match(processes.lastError("web") ?? "", /closed before it finished starting/);
    assert.equal(processes.lastError("web")?.includes("Cleanup"), false);
    assert.equal(spawns, 1);
    assert.deepEqual(kills, []);
  }, {
    runtime: runtime("ok", {
      spawn: () => {
        spawns += 1;
        const child = idleChild();
        Object.assign(child, { exitCode: 2 });
        return child;
      },
      kill: async (_pid, kind) => {
        kills.push(kind);
      },
      readyTimeoutMs: 400,
      gracefulWaitMs: 20,
      forceWaitMs: 20,
    }),
  });
});

test("cancelled start keeps both causes when cleanup fails", async () => {
  let spawns = 0;
  let child: ChildProcess | undefined;
  await withManager(async (processes) => {
    const states: string[] = [];
    processes.onStatus((_name, status) => states.push(status));
    const started = processes.start("web");
    void started.catch(() => undefined);
    await waitStatus(processes, "web", "starting");
    const port = processes.portOf("web");
    const stopped = processes.stop("web");
    await assert.rejects(started, (err: unknown) => {
      assert.ok(err instanceof StartFailureError);
      assert.equal(isStartCancelled(err.cause), true);
      assert.equal(err.instanceRetained, true);
      assert.match(err.message, /cancelled/i);
      assert.match(err.message, /Cleanup/);
      assert.match(err.message, /SECOND_STOP_FAILURE/);
      return true;
    });
    await assert.rejects(stopped, /SECOND_STOP_FAILURE/);
    const recorded = processes.lastError("web") ?? "";
    assert.match(recorded, /cancelled/i);
    assert.match(recorded, /Cleanup/);
    assert.match(recorded, /SECOND_STOP_FAILURE/);
    assert.equal(typeof port, "number");
    assert.equal(processes.portOf("web"), port);
    assert.equal(processes.statusOf("web"), "starting");
    assert.equal(spawns, 1);
    assert.equal(states.includes("stopped"), false);
    assert.equal(states.includes("crashed"), false);
  }, {
    runtime: runtime("ok", {
      spawn: () => {
        spawns += 1;
        child = idleChild();
        return child;
      },
      kill: async (_pid, kind) => {
        void child;
        if (kind === "kill") throw new Error("SECOND_STOP_FAILURE: force-stop refused; retained");
      },
      readyTimeoutMs: 400,
      gracefulWaitMs: 5,
      forceWaitMs: 5,
    }),
  });
});

test("patch verification failure keeps PatchVerifyError", async () => {
  const reason = new PatchVerifyError("catalog drifted");
  let spawns = 0;
  const processes = new ProcessManager("unused-in-this-test", {
    verify: async () => {
      throw reason;
    },
  } as Pick<PatchWriter, "verify"> as PatchWriter, 3100, 3199, runtime("ok", {
    spawn: () => {
      spawns += 1;
      return idleChild();
    },
  }));
  await assert.rejects(processes.start("notes"), (err: unknown) => err === reason);
  assert.equal(spawns, 0);
  assert.equal(processes.statusOf("notes"), "crashed");
  assert.match(processes.lastError("notes") ?? "", /catalog drifted/);
  assert.equal(processes.lastError("notes")?.includes("Cleanup"), false);
});

test("startup failure keeps both causes when cleanup fails", async () => {
  const original = new Error("FIRST_STARTUP_FAILURE token=fixture-secret");
  let spawns = 0;
  let child: ChildProcess | undefined;
  const kills: string[] = [];
  await withManager(async (processes) => {
    const states: string[] = [];
    processes.onStatus((_name, status) => states.push(status));
    await assert.rejects(processes.start("web"), (err: unknown) => {
      assert.ok(err instanceof StartFailureError);
      assert.equal(err.cause, original);
      assert.equal(err.stage, "endpoint");
      assert.equal(err.instanceRetained, true);
      assert.match(err.message, /FIRST_STARTUP_FAILURE/);
      assert.match(err.message, /Cleanup: /);
      assert.match(err.message, /SECOND_STOP_FAILURE/);
      assert.equal(err.message.includes("fixture-secret"), false);
      return true;
    });
    const recorded = processes.lastError("web") ?? "";
    assert.match(recorded, /FIRST_STARTUP_FAILURE/);
    assert.match(recorded, /Cleanup: /);
    assert.match(recorded, /SECOND_STOP_FAILURE/);
    assert.equal(recorded.includes("fixture-secret"), false);
    assert.equal(spawns, 1);
    assert.deepEqual(kills, ["term", "kill"]);
    assert.equal(processes.statusOf("web"), "starting");
    assert.equal(typeof processes.portOf("web"), "number");
    assert.equal(states.includes("stopped"), false);
    assert.equal(states.includes("crashed"), false);
  }, {
    runtime: runtime("ok", {
      spawn: () => {
        spawns += 1;
        child = idleChild();
        queueMicrotask(() => child?.emit("error", original));
        return child;
      },
      kill: async (_pid, kind) => {
        kills.push(kind);
        if (kind === "kill") throw new Error("SECOND_STOP_FAILURE token=fixture-secret");
      },
      readyTimeoutMs: 400,
      gracefulWaitMs: 5,
      forceWaitMs: 5,
    }),
  });
});
