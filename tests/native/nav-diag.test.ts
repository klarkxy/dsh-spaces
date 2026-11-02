import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { createNavDiag, navDiagPortalPrelude, parseNavDiag } from "../../src/shared/nav-diag.ts";

function collect(run: (lines: string[]) => void) {
  const lines: string[] = [];
  const prior = console.log;
  console.log = ((first: unknown, ...rest: unknown[]) => {
    if (typeof first === "string" && first.startsWith("dsh-spaces-nav-diag ")) lines.push(first);
    else prior(first, ...rest);
  }) as typeof console.log;
  try { run(lines); }
  finally { console.log = prior; }
  return lines;
}
function parsed(lines: string[]) {
  return lines.map(line => {
    const row = parseNavDiag(line);
    assert.ok(row, line);
    return row;
  });
}

test("nav diagnosis drops raw urls, tokens, channels and non-whitelist fields", () => {
  const [line] = collect(out => {
    createNavDiag("controller")("user-select", {
      url: "http://user:secret-token@evil.example/path?channel=channel-secret#hash-secret",
      channel: "channel-secret", epoch: "e".repeat(64), lease: "lease-secret", spaceName: "private-space",
      message: "Bearer token", stack: "Error: secret-stack", token: "raw-token", hash: "#select/1/@settings",
      reason: "constructor", route: "toString", code: "workbench/not-a-code",
    });
    assert.equal(out.length, 1);
  });
  for (const secret of ["secret-token", "channel-secret", "lease-secret", "private-space", "Bearer", "secret-stack",
    "hash-secret", "raw-token", "constructor", "toString", "evil.example", "not-a-code"]) {
    assert.equal(line!.includes(secret), false, secret);
  }
  const row = parseNavDiag(line!)!;
  assert.equal(row.ev, "user-select");
  assert.equal(row.src, "controller");
  assert.equal(row.route, "other");
  assert.equal(row.hashKind, "other");
  assert.equal(row.reason, undefined);
  assert.equal(row.code, undefined);
});

test("nav diagnosis ignores inherited whitelist fields", () => {
  const extra = Object.create({ reason: "state-request", route: "bootstrap", targetKind: "settings", code: "workbench/failed" });
  extra.url = "http://127.0.0.1:3333/native/" + "ab".repeat(16);
  const [line] = collect(lines => { createNavDiag("controller")("user-select", extra); assert.equal(lines.length, 1); });
  const row = parseNavDiag(line!)!;
  assert.equal(row.route, "native-portal");
  assert.equal(row.reason, undefined);
  assert.equal(row.targetKind, undefined);
  assert.equal(row.code, undefined);
  assert.equal(line!.includes("state-request"), false);
});

test("a throwing diagnostic getter does not escape and keeps the other whitelist fields", () => {
  let blew = false;
  const extra = Object.defineProperty({ targetKind: "settings" }, "url", {
    get() { blew = true; throw new Error("diagnostic probe"); },
  });
  const [line] = collect(lines => {
    const emit = createNavDiag("controller");
    assert.doesNotThrow(() => emit("user-select", extra));
    assert.equal(lines.length, 1);
  });
  assert.equal(blew, true);
  const row = parseNavDiag(line!)!;
  assert.equal(row.ev, "user-select");
  assert.equal(row.targetKind, "settings");
  assert.equal(row.route, undefined);
  assert.equal(line!.includes("diagnostic probe"), false);
});

test("a throwing console sink does not escape from emit or end", () => {
  const prior = console.log;
  console.log = () => { throw new Error("disk full"); };
  try {
    const emit = createNavDiag("portal");
    assert.doesNotThrow(() => emit("document-start"));
    assert.doesNotThrow(() => emit.end());
    assert.doesNotThrow(() => emit("ready"));
  } finally { console.log = prior; }
});

test("elapsed time stays non-negative and monotonic from zero through a clock fault", () => {
  const marks = [0, 0, 12, 7, 40];
  let index = 0;
  const priorPerformance = globalThis.performance;
  const priorNow = Date.now;
  globalThis.performance = { now: () => marks[Math.min(index++, marks.length - 1)]! } as Performance;
  try {
    const lines = collect(out => {
      const emit = createNavDiag("controller");
      for (let n = 0; n < marks.length; n++) emit("user-select");
      assert.deepEqual(parsed(out).map(row => row.t), [0, 0, 12, 12, 40]);
      index = 0;
      globalThis.performance = { now: () => { throw new Error("performance down"); } } as unknown as Performance;
      Date.now = () => { throw new Error("date down"); };
      assert.doesNotThrow(() => emit("bridge-acquired"));
      const fault = parsed(out).at(-1)!;
      assert.equal(fault.ev, "bridge-acquired");
      assert.ok(fault.t >= 40);
      assert.equal(out.join("\n").includes("performance down"), false);
      assert.equal(out.join("\n").includes("date down"), false);
    });
    assert.equal(parsed(lines).at(-1)!.t >= 40, true);
  } finally {
    globalThis.performance = priorPerformance;
    Date.now = priorNow;
  }
});

test("navigation diagnosis keeps 96 records including truncation and then stays silent", () => {
  const lines = collect(out => {
    const emit = createNavDiag("bootstrap");
    for (let n = 0; n < 200; n++) emit("script-run");
    assert.equal(out.length, 96);
    emit("replace-call");
    emit.end();
    emit("ready");
  });
  const rows = parsed(lines);
  assert.equal(rows.length, 96);
  assert.equal(rows[94]!.ev, "script-run");
  assert.equal(rows[95]!.ev, "truncated");
  assert.equal(rows[95]!.seq, 96);
});

test("end stops later navigation diagnosis", () => {
  const lines = collect(out => {
    const emit = createNavDiag("controller");
    emit("guest-created");
    emit.end();
    emit("guest-dom-ready");
    emit("ready");
    emit.end();
    assert.equal(out.length, 1);
  });
  assert.equal(parseNavDiag(lines[0]!)!.ev, "guest-created");
});

test("parseNavDiag rejects unknown keys and accepts a closed record", () => {
  const [line] = collect(out => { createNavDiag("controller")("ready", { stage: "selection" }); assert.equal(out.length, 1); });
  const row = parseNavDiag(line!)!;
  assert.equal(row.ev, "ready");
  assert.equal(row.stage, "selection");
  for (const value of [
    'dsh-spaces-nav-diag {"v":1,"src":"controller","seq":1,"t":0,"ev":"ready","url":"http://secret"}',
    'dsh-spaces-nav-diag {"v":1,"src":"controller","seq":1,"t":0,"ev":"ready","token":"x"}',
    'dsh-spaces-nav-diag {"v":1,"src":"controller","seq":1,"t":0,"ev":"ready","channel":"abc"}',
    '{"v":1,"src":"controller","seq":1,"t":0,"ev":"ready","hash":"#select/1/@settings"}',
  ]) assert.equal(parseNavDiag(value), null, value);
});

test("the portal prelude runs in a standard VM without a global __name", () => {
  const captured: string[] = [];
  const context: { console: { log(value: string): void }; performance: { now(): number }; URL: typeof URL; Date: typeof Date; __name?: unknown } = {
    console: { log: value => captured.push(value) },
    performance: { now: () => 1 },
    URL, Date,
  };
  assert.doesNotThrow(() => new Script(navDiagPortalPrelude()).runInNewContext(context));
  assert.equal(Object.hasOwn(context, "__name"), false);
  const row = parseNavDiag(captured[0]!)!;
  assert.equal(row.src, "portal");
  assert.equal(row.ev, "document-start");
  const shadowed: string[] = [];
  const hostile = {
    console: { log: (value: string) => shadowed.push(value) },
    performance: { now: () => 1 },
    URL, Date,
    __name: () => { throw new Error("global __name"); },
  };
  assert.doesNotThrow(() => new Script(navDiagPortalPrelude()).runInNewContext(hostile));
  assert.equal(parseNavDiag(shadowed[0]!)!.ev, "document-start");
  assert.equal(shadowed.join("\n").includes("global __name"), false);
});
