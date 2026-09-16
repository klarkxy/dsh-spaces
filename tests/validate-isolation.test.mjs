import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { rpc, waitForApi } from "../scripts/validate-isolation.mjs";

test("isolation gate exchanges one launch token and reuses its session cookie", async () => {
  const secret = randomUUID();
  const cookie = `dsh-auth-fixture=${randomUUID()}`;
  let exchanges = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === `/?token=${secret}`) {
      exchanges += 1;
      res.writeHead(303, { location: "/", "set-cookie": `${cookie}; HttpOnly; SameSite=Strict` });
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/api/session.list") {
      if (req.headers.cookie !== cookie) {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      for await (const _chunk of req) {
        // Drain the request before replying, like the real local API.
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result: { ok: true, value: { items: [] } } }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const dir = mkdtempSync(join(tmpdir(), "dsh-isolation-auth-"));
  const log = join(dir, "web.log");
  writeFileSync(log, `dsh web: http://127.0.0.1:${address.port}/?token=${secret}\n`);
  try {
    const authenticated = await waitForApi(address.port, log, 2_000);
    assert.equal(authenticated, cookie);
    assert.deepEqual(await rpc(address.port, "session.list", {}, authenticated), { items: [] });
    assert.equal(exchanges, 1);
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
