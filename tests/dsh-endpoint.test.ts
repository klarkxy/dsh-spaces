import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import { dshSessionCookie, dshSessionList, waitForDshEndpoint } from "../src/adapters/node/dsh-endpoint.ts";

function childFixture(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  return child;
}
test("readiness waits for the complete endpoint announced by the owned child", async () => {
  const child = childFixture();
  const ready = waitForDshEndpoint(child, 3210, new AbortController().signal, 1000);
  (child.stdout as PassThrough).write("dsh web: http://127.0.0.1:32");
  await new Promise(resolve => setImmediate(resolve));
  (child.stdout as PassThrough).write("10\n");
  assert.equal(await ready, "http://127.0.0.1:3210/");
  assert.equal(child.stdout!.listenerCount("data"), 0);
});

test("authentication refuses redirects outside the local root and omits token from errors", async () => {
  const url = "http://127.0.0.1:3210/?token=private-launch-token";
  const fetchImpl = (async (_url, options) => {
    assert.equal(options?.redirect, "manual");
    return new Response(null, { status: 303, headers: { location: "https://example.com", "set-cookie": "dsh-auth-fixture=private-cookie; HttpOnly" } });
  }) as typeof fetch;
  await assert.rejects(dshSessionCookie(url, fetchImpl, new AbortController().signal), error => {
    assert.match(String(error), /authentication failed/);
    assert.ok(!String(error).includes("private-"));
    return true;
  });
});
test("a different port is rejected rather than probing an unrelated listener", async () => {
  const child = childFixture();
  const ready = waitForDshEndpoint(child, 3210, new AbortController().signal, 1000);
  (child.stdout as PassThrough).write("dsh web: http://127.0.0.1:3211\n");
  await assert.rejects(ready, /instead of the reserved/);
});

test("alpha directory-relative authentication redirect keeps the owned cookie", async () => {
  const fetchImpl = (async () => new Response(null, { status: 303,
    headers: { location: "./", "set-cookie": "dsh-auth-fixture=private-cookie; HttpOnly" },
  })) as typeof fetch;
  assert.equal(await dshSessionCookie("http://127.0.0.1:3210/?token=private-token", fetchImpl,
    new AbortController().signal), "dsh-auth-fixture=private-cookie");
});
test("cancelled startup removes endpoint listeners", async () => {
  const child = childFixture(); const abort = new AbortController();
  const ready = waitForDshEndpoint(child, 3210, abort.signal, 1000);
  abort.abort(new Error("cancelled"));
  await assert.rejects(ready, /cancelled/);
  assert.equal(child.stdout!.listenerCount("data"), 0);
});

test("typed session list fallback uses named arguments and preserves authentication", async () => {
  const methods: string[] = [];
  const fetchImpl = (async (url, options) => {
    const body = JSON.parse(String(options?.body));
    methods.push(body.method);
    assert.equal((options?.headers as Record<string,string>).cookie, "dsh-auth-test=cookie");
    if(body.method==='session.list') return new Response('not found',{status:404});
    assert.equal(url,'http://127.0.0.1:3210/api/session/list');
    assert.deepEqual(body.payload,{args:{_request:{}}});
    return Response.json({result:{ok:true,value:{items:[]}}});
  }) as typeof fetch;
  assert.deepEqual(await dshSessionList(3210,fetchImpl,new AbortController().signal,'dsh-auth-test=cookie'),{items:[]});
  assert.deepEqual(methods,['session.list','session/list']);
});

test("authentication failure does not fall back to a different session API", async () => {
  let calls=0;
  const fetchImpl=(async()=>{calls++; return new Response('unauthorized',{status:401});}) as typeof fetch;
  await assert.rejects(dshSessionList(3210,fetchImpl,new AbortController().signal),/HTTP 401/);
  assert.equal(calls,1);
});
