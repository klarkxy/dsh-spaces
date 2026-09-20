import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, describe, test } from "node:test";
import {
  bindInitialLoopbackHttp,
  isForbiddenFetchPort,
  startWorkbenchHttp,
  type WorkbenchHttpRuntime,
} from "../src/adapters/node/workbench-http.ts";

const HOST = "127.0.0.1";
const FETCH_BLOCKED_PORTS = [
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512,
  513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697,
  10080,
] as const;
const INITIAL_BIND_ATTEMPTS = 8;
const BLOCKED_PROBE_PORTS = [1720, 1719, 1723, 2049, 3659, 4045, 4190, 6566, 10080] as const;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

function runtime(originOf: () => string): WorkbenchHttpRuntime {
  return {
    cookieName: () => "dsh-auth-test",
    sessionCookie: () => "session",
    sessionEquals: (value) => value === "session",
    consumeBootstrapToken: () => false,
    hostBearerEquals: (value) => value === "test-bearer",
    supervisorOrigin: originOf,
    managerOrigin: () => null,
    isWorkspaceOrigin: () => false,
    dispatch: async () => ({ ok: true }),
    entryPage: () => "<html></html>",
    viewEntry: async () => ({ status: 404, message: "missing" }),
    mintHandoff: () => "",
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      server.close();
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function listenLoopback(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected 127.0.0.1 bind"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function fetchState(origin: string): Promise<Response> {
  return fetch(`${origin}/api/workbench/state`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-bearer" },
    body: "{}",
  });
}

async function freeBlockedPort(): Promise<number> {
  for (const port of BLOCKED_PROBE_PORTS) {
    const probe = createServer();
    try {
      await listenLoopback(probe, port);
      await closeServer(probe);
      return port;
    } catch {
      await closeServer(probe).catch(() => undefined);
    }
  }
  throw new Error("no free WHATWG-blocked loopback port for the test");
}

async function freeAllowedPort(): Promise<number> {
  for (let attempt = 0; attempt < INITIAL_BIND_ATTEMPTS; attempt += 1) {
    const probe = createServer();
    try {
      const port = await listenLoopback(probe, 0);
      await closeServer(probe);
      if (!isForbiddenFetchPort(port)) return port;
    } catch (error) {
      await closeServer(probe).catch(() => undefined);
      throw error;
    }
  }
  throw new Error("could not sample an allowed loopback port");
}

function scriptedBinds(ports: number[]) {
  const remaining = [...ports];
  const closedPorts: number[] = [];
  const live = new Set<Server>();
  let opens = 0;
  return {
    remaining,
    closedPorts,
    live,
    get opens() {
      return opens;
    },
    open(): Server {
      const forced = remaining.shift();
      if (forced === undefined) throw new Error("unexpected extra bind attempt");
      opens += 1;
      const server = createServer();
      server.listen = ((...args: unknown[]) => {
        assert.equal(args[0], 0);
        const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
        server.address = () => ({ port: forced, family: "IPv4", address: HOST });
        process.nextTick(() => callback?.());
        return server;
      }) as Server["listen"];
      const close = server.close.bind(server);
      server.close = ((callback?: (error?: Error) => void) => {
        closedPorts.push(forced);
        live.delete(server);
        return close(callback);
      }) as Server["close"];
      live.add(server);
      return server;
    },
  };
}

async function occupyAllowedPort(): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < INITIAL_BIND_ATTEMPTS; attempt += 1) {
    const server = createServer();
    try {
      const port = await listenLoopback(server, 0);
      if (!isForbiddenFetchPort(port)) return { server, port };
      await closeServer(server);
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      throw error;
    }
  }
  throw new Error("could not occupy an allowed loopback port");
}

describe("workbench-http ports", { concurrency: 1 }, () => {
  test("WHATWG Fetch blocked-port set includes 1720 and the verified official list", () => {
    for (const port of FETCH_BLOCKED_PORTS) assert.equal(isForbiddenFetchPort(port), true);
    assert.equal(isForbiddenFetchPort(1720), true);
    for (const port of [80, 443, 3000, 8080, 5173, 18765, 49152]) {
      assert.equal(isForbiddenFetchPort(port), false);
    }
  });

  test("Node fetch refuses WHATWG blocked ports such as 1720 with cause bad port", async () => {
    const error = await fetch(`http://${HOST}:1720/`).then(
      () => {
        throw new Error("expected fetch to refuse port 1720");
      },
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof Error);
    assert.equal(error.message, "fetch failed");
    const cause = (error as { cause?: { message?: string } }).cause;
    assert.equal(cause?.message, "bad port");
  });

  test("explicit blocked port rejects before listen, publish, or mutation", async () => {
    const blocked = await freeBlockedPort();
    let opened = 0;
    await assert.rejects(
      () => bindInitialLoopbackHttp(() => {
        opened += 1;
        return createServer();
      }, blocked),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`port ${blocked}`));
        assert.match(error.message, /fetch\.spec\.whatwg\.org\/#port-blocking/);
        return true;
      },
    );
    assert.equal(opened, 0);

    let origin = "unset";
    await assert.rejects(
      () => startWorkbenchHttp(runtime(() => origin), blocked),
      /blocked by Fetch/,
    );
    assert.equal(origin, "unset");

    const probe = createServer();
    closers.push(() => closeServer(probe));
    const rebound = await listenLoopback(probe, blocked);
    assert.equal(rebound, blocked);
  });

  test("allowed explicit port keeps identity and origin is reachable", async () => {
    const port = await freeAllowedPort();
    let origin = "";
    const http = await startWorkbenchHttp(runtime(() => origin), port);
    closers.push(() => http.close());
    origin = http.origin;
    assert.equal(origin, `http://${HOST}:${port}`);
    assert.equal(isForbiddenFetchPort(Number(new URL(origin).port)), false);
    const response = await fetchState(origin);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok?: boolean };
    assert.equal(body.ok, true);
  });

  test("automatic port 0 publishes a fetchable origin that is not a blocked port", async () => {
    let origin = "";
    const http = await startWorkbenchHttp(runtime(() => origin), 0);
    closers.push(() => http.close());
    origin = http.origin;
    const port = Number(new URL(origin).port);
    assert.equal(Number.isInteger(port), true);
    assert.equal(isForbiddenFetchPort(port), false);
    const response = await fetchState(origin);
    assert.equal(response.status, 200);
  });

  test("explicit EADDRINUSE fails immediately without switching ports", async () => {
    const occupant = await occupyAllowedPort();
    closers.push(() => closeServer(occupant.server));
    let origin = "unset";
    await assert.rejects(
      () => startWorkbenchHttp(runtime(() => origin), occupant.port),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "EADDRINUSE");
        return true;
      },
    );
    assert.equal(origin, "unset");
    assert.equal(occupant.server.listening, true);
    assert.equal((occupant.server.address() as { port: number }).port, occupant.port);
  });

  test("automatic allocation closes a blocked first assignment and keeps a later safe port", async () => {
    const scripted = scriptedBinds([1720, 49152]);
    const bound = await bindInitialLoopbackHttp(() => scripted.open(), 0);
    closers.push(() => closeServer(bound.server));
    assert.equal(bound.port, 49152);
    assert.equal(isForbiddenFetchPort(bound.port), false);
    assert.deepEqual(scripted.closedPorts, [1720]);
    assert.equal(scripted.live.size, 1);
    assert.equal(scripted.live.has(bound.server), true);
    assert.equal(scripted.opens, 2);
  });

  test("automatic allocation exhaustion closes every unexposed listener and does not take a later safe port", async () => {
    const blocked = Array.from({ length: INITIAL_BIND_ATTEMPTS }, () => 1720);
    const scripted = scriptedBinds([...blocked, 49152]);
    await assert.rejects(
      () => bindInitialLoopbackHttp(() => scripted.open(), 0),
      /browser-safe loopback port/,
    );
    assert.equal(scripted.opens, INITIAL_BIND_ATTEMPTS);
    assert.equal(scripted.closedPorts.length, INITIAL_BIND_ATTEMPTS);
    assert.deepEqual(scripted.closedPorts, blocked);
    assert.equal(scripted.live.size, 0);
    assert.deepEqual(scripted.remaining, [49152]);
  });

  test("listen errors on port 0 fail immediately without further candidates", async () => {
    let opens = 0;
    await assert.rejects(
      () =>
        bindInitialLoopbackHttp(() => {
          opens += 1;
          const server = createServer();
          server.listen = ((port: number, _host?: string, _callback?: () => void) => {
            assert.equal(port, 0);
            const error = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
            process.nextTick(() => server.emit("error", error));
            return server;
          }) as Server["listen"];
          return server;
        }, 0),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "EADDRINUSE");
        return true;
      },
    );
    assert.equal(opens, 1);
  });
});
