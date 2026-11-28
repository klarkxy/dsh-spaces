import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RotatingDiagnosticLogger } from "../../src/adapters/node/diagnostics/rotating-log.ts";
import { CooperativeChildren, COOPERATIVE_STOP_WAIT_MS } from "../../src/adapters/node/runtime/cooperative-children.ts";
import { ProcessManager } from "../../src/adapters/node/runtime/process-manager.ts";
import type { PatchWriter } from "../../src/adapters/node/profile/patch-writer.ts";

let nextPortStart = 32_100;

function portStartBlock(): number {
  const start = nextPortStart;
  nextPortStart += 20;
  return start;
}

async function fixture(t: TestContext, options: { delay: number; wait?: number; code?: number; rejectStop?: boolean }) {
  const home = mkdtempSync(join(tmpdir(), "spaces-stop-regression-"));
  const logger = new RotatingDiagnosticLogger(home, "supervisor");
  const children = new CooperativeChildren();
  const spawned: ChildProcess[] = [];
  const requests: string[] = [];
  const statuses: string[] = [];
  const portStart = portStartBlock();
  const manager = new ProcessManager(home, { verify: async () => {} } as unknown as PatchWriter, portStart, portStart + 12, {
    ensureCli: async () => "fixture",
    prepareHome: async () => {},
    gracefulWaitMs: options.wait ?? COOPERATIVE_STOP_WAIT_MS,
    readyTimeoutMs: 8_000,
    spawn: (args, spawnOptions) => {
      const port = args[args.indexOf("--port") + 1];
      const child = children.spawn(["-e", `
        const http = require('node:http');
        process.on('SIGTERM', () => setTimeout(() => process.exit(${options.code ?? 0}), ${options.delay}));
        process.on('message', message => {
          if (message?.type === 'fixture:exit') process.exit(message.code);
        });
        http.createServer((req, res) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({result: {ok: true}}));
        }).listen(${port}, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:${port}'));
      `], spawnOptions);
      spawned.push(child);
      return child;
    },
    kill: async (pid, kind) => {
      requests.push(kind);
      if (kind === "kill") throw Error("STOP_DEADLINE: process retained");
      if (options.rejectStop) throw Error("STOP_NOT_DELIVERED");
      await children.stop(pid);
    },
  }, logger);
  manager.onStatus((_name, status) => statuses.push(status));
  t.after(async () => {
    for (const child of spawned) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.send({ type: "fixture:exit", code: 0 });
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  });
  await manager.start("coding");
  return { manager, requests, statuses, spawned,
    logs: () => readFileSync(join(home, ".dsh-spaces-control", "logs", "supervisor.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line)),
  };
}

test("cooperative stop allows a real child more than five seconds without escalation", async t => {
  const f = await fixture(t, { delay: 6_000 });
  const started = Date.now();
  await f.manager.stop("coding");
  assert.ok(Date.now() - started >= 6_000);
  assert.deepEqual(f.requests, ["term"]);
  assert.equal(f.manager.statusOf("coding"), "stopped");
  assert.equal(f.logs().some(row => row.event === "space.stop.failed"), false);
});

test("late clean exit updates only process state and preserves the failed stop diagnostic", async t => {
  const f = await fixture(t, { delay: 500, wait: 20 });
  const exited = once(f.spawned[0], "exit");
  await assert.rejects(f.manager.stop("coding"), /STOP_DEADLINE/);
  assert.notEqual(f.manager.statusOf("coding"), "stopped");
  await exited;
  assert.equal(f.manager.statusOf("coding"), "stopped");
  assert.equal(f.manager.lastError("coding"), undefined);
  assert.equal(f.manager.portOf("coding"), undefined);
  assert.deepEqual(f.requests, ["term", "kill"]);
  assert.equal(f.statuses.includes("crashed"), false);
  const logs = f.logs();
  assert.equal(logs.filter(row => row.event === "space.stop.failed").length, 1);
  assert.equal(logs.filter(row => row.event === "space.stop.exited-after-failure").length, 1);
  assert.equal(logs.some(row => row.event === "space.stop.completed" || row.event === "space.exited"), false);

  // A fresh process must not inherit the old process's shutdown intent.
  await f.manager.start("coding");
  const nextExit = once(f.spawned[1], "exit");
  f.spawned[1].send({ type: "fixture:exit", code: 0 });
  await nextExit;
  assert.equal(f.manager.statusOf("coding"), "crashed");
  assert.equal(f.logs().filter(row => row.event === "space.exited").length, 1);
});

test("late nonzero exit retains an actual failure with stop-stage diagnostics", async t => {
  const f = await fixture(t, { delay: 500, wait: 20, code: 7 });
  const exited = once(f.spawned[0], "exit");
  await assert.rejects(f.manager.stop("coding"), /STOP_DEADLINE/);
  await exited;
  assert.equal(f.manager.statusOf("coding"), "crashed");
  assert.match(f.manager.lastError("coding")!, /停止失败/);
  assert.match(f.manager.lastError("coding")!, /阶段：stop/);
  assert.match(f.manager.lastError("coding")!, /退出码：7/);
  assert.equal(f.logs().some(row => row.event === "space.exited"), false);
});

test("a rejected stop delivery does not turn a later unexpected exit into a clean stop", async t => {
  const f = await fixture(t, { delay: 0, rejectStop: true });
  await assert.rejects(f.manager.stop("coding"), /STOP_NOT_DELIVERED/);
  const exited = once(f.spawned[0], "exit");
  f.spawned[0].send({ type: "fixture:exit", code: 0 });
  await exited;
  assert.equal(f.manager.statusOf("coding"), "crashed");
  assert.equal(f.logs().some(row => row.event === "space.stop.exited-after-failure"), false);
});
