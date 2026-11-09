/**
 * Supervisor-side UI automation: contract parsing and the session/ownership
 * rules of UiAutomationManager against a stub engine — no real browser.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import {
  CONTROL_UI_SCREENSHOT_MAX_BYTES,
  ControlPublicError,
  parseControlUiAct,
  parseControlUiActInput,
  parseControlUiEvalInput,
  parseControlUiOpenInput,
  parseControlUiSnapshotInput,
} from "../../src/shared/control.ts";
import { UiAutomationManager, type UiAutomationPorts } from "../../src/adapters/node/supervisor/ui-automation.ts";
import type { UiContext, UiEngine, UiLocator, UiPage } from "../../src/adapters/node/supervisor/ui-playwright.ts";
import { findBrowserChannel } from "../../src/adapters/node/supervisor/ui-playwright.ts";
import {
  EVAL_ON_ELEMENT_SOURCE,
  EVAL_ON_PAGE_SOURCE,
  pageFunction,
  relativePagePath,
  redactCredentials,
  SANITIZE_ATTR_PAYLOAD_MIN,
  SANITIZE_OUTER_HTML_SOURCE,
  sanitizeAttributeValue,
  SCROLL_BY_SOURCE,
  truncateUtf8,
} from "../../src/adapters/node/supervisor/ui-shared.ts";
import { WorkbenchPublicError } from "../../src/adapters/node/supervisor/errors.ts";

/* ------------------------------------------------------------------ parsing */

test("ui.open input is closed and spaceId-strict", () => {
  assert.deepEqual(parseControlUiOpenInput({ spaceId: "space-a1" }), { spaceId: "space-a1" });
  for (const bad of [{}, { spaceId: "Web" }, { spaceId: "x", extra: 1 }, "x"]) {
    assert.throws(() => parseControlUiOpenInput(bad), (error: unknown) =>
      error instanceof ControlPublicError && error.code === "control/invalid-input");
  }
});

test("ui.snapshot input: formats deduped, ref shape and maxBytes clamp", () => {
  const parsed = parseControlUiSnapshotInput({
    uiSessionId: "ui-abc", formats: ["html", "aria", "html"], ref: "e12", maxBytes: 999_999,
  });
  assert.deepEqual(parsed.formats, ["html", "aria"]);
  assert.equal(parsed.ref, "e12");
  assert.equal(parsed.maxBytes, 256 * 1024);
  for (const bad of [
    { uiSessionId: "ui-abc", formats: ["png"] },
    { uiSessionId: "ui-abc", formats: [] },
    { uiSessionId: "ui-abc", ref: "div#x" },
    { uiSessionId: "ui-abc", maxBytes: 0 },
  ]) {
    assert.throws(() => parseControlUiSnapshotInput(bad), (error: unknown) =>
      error instanceof ControlPublicError && error.code === "control/invalid-input");
  }
});

test("ui act union: closed kinds, ref-or-coordinates, bounds", () => {
  assert.deepEqual(parseControlUiAct({ kind: "click", ref: "e3" }), { kind: "click", ref: "e3" });
  assert.deepEqual(parseControlUiAct({ kind: "click", x: 1, y: 2, clickCount: 2 }),
    { kind: "click", x: 1, y: 2, clickCount: 2 });
  assert.deepEqual(parseControlUiAct({ kind: "navigate", path: "/settings/x?y=1" }),
    { kind: "navigate", path: "/settings/x?y=1" });
  const rejected = [
    { kind: "goto", url: "http://evil.example" },
    { kind: "click" },
    { kind: "click", ref: "e3", x: 1, y: 2 },
    { kind: "navigate", path: "https://evil.example/" },
    { kind: "navigate", path: "//evil.example/" },
    { kind: "navigate", path: "/\\escape" },
    { kind: "press", key: "F5" },
    { kind: "scroll", deltaY: 5000 },
    { kind: "wait", ms: 99999 },
    { kind: "type", ref: "e1", text: "x".repeat(9 * 1024) },
    { kind: "eval", script: "1" },
  ];
  for (const bad of rejected) {
    assert.throws(() => parseControlUiAct(bad), (error: unknown) =>
      error instanceof ControlPublicError && error.code === "control/invalid-input",
      JSON.stringify(bad));
  }
  const input = parseControlUiActInput({ uiSessionId: "ui-1", requestId: "r-1", act: { kind: "wait", ms: 10 } });
  assert.deepEqual(input.act, { kind: "wait", ms: 10 });
});

test("ui.eval input: script byte cap and timeout bound", () => {
  const ok = parseControlUiEvalInput({ uiSessionId: "ui-1", requestId: "r-1", script: "return 1", timeoutMs: 5000 });
  assert.equal(ok.timeoutMs, 5000);
  for (const bad of [
    { uiSessionId: "ui-1", requestId: "r-1", script: "  " },
    { uiSessionId: "ui-1", requestId: "r-1", script: "x".repeat(17 * 1024) },
    { uiSessionId: "ui-1", requestId: "r-1", script: "1", timeoutMs: 31_000 },
  ]) {
    assert.throws(() => parseControlUiEvalInput(bad), (error: unknown) =>
      error instanceof ControlPublicError && error.code === "control/invalid-input");
  }
});

/* ----------------------------------------------------------------- helpers */

test("relativePagePath keeps only path+query", () => {
  assert.equal(relativePagePath("http://127.0.0.1:3999/a/b?x=1#frag"), "/a/b?x=1#frag");
  assert.equal(relativePagePath("not-a-url"), "/");
});

test("redactCredentials replaces secrets and never echoes them", () => {
  const out = redactCredentials("cookie=vddodbh-12345; token=private-token-9", ["vddodbh-12345", "private-token-9"]);
  assert.equal(out, "cookie=[redacted]; token=[redacted]");
  assert.equal(redactCredentials("nothing", ["vddodbh-12345"]), "nothing");
});

test("truncateUtf8 never splits a multi-byte sequence", () => {
  const text = "ab" + "汉".repeat(10);
  const cut = truncateUtf8(text, 4); // boundary lands inside 汉 (3 bytes)
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, "ab");
});

test("sanitizeAttributeValue strips oversized inline payloads, keeps structure", () => {
  // Pure base64-looking blob in a data-* attribute (the real-browser failure:
  // a 600-char payload with no data: prefix must still be stripped).
  assert.equal(sanitizeAttributeValue("data-large", "A".repeat(600)), "[stripped]");
  // data: and blob: URIs anywhere in the value, including srcset entries.
  assert.equal(sanitizeAttributeValue("src", `data:image/png;base64,${"iVBOR".repeat(120)}`), "[stripped]");
  assert.equal(sanitizeAttributeValue("srcset", `a.png 1x, data:image/png;base64,${"iVBOR".repeat(120)} 2x`), "[stripped]");
  // Small values, URLs and spaced values are ordinary attributes.
  assert.equal(sanitizeAttributeValue("src", `data:image/png;base64,${"x".repeat(100)}`), `data:image/png;base64,${"x".repeat(100)}`);
  assert.equal(sanitizeAttributeValue("href", `http://127.0.0.1/${"a".repeat(600)}`), `http://127.0.0.1/${"a".repeat(600)}`);
  assert.equal(sanitizeAttributeValue("class", `a b ${"c".repeat(600)}`), `a b ${"c".repeat(600)}`);
  assert.equal(sanitizeAttributeValue("aria-label", `label ${"x".repeat(600)}`), `label ${"x".repeat(600)}`);
});

/** Minimal DOM stub for the fresh-scope regression: attributes + clone + querySelectorAll. */
function fakeElement(attrs: Record<string, string> = {}, children: unknown[] = []): unknown {
  const attrsMap = new Map(Object.entries(attrs));
  const el = {
    attrsMap,
    children: children as Array<ReturnType<typeof fakeElement> & { nodeType?: number }>,
    textContent: "",
    cloneNode: (deep: boolean) => {
      const copy = fakeElement(Object.fromEntries(attrsMap), deep ? children.map((c) => (c as { cloneNode: (d: boolean) => unknown }).cloneNode(deep)) : []);
      (copy as { nodeType?: number }).nodeType = 1;
      return copy;
    },
    querySelectorAll: (sel: string) => {
      const out: unknown[] = [];
      const want = sel.split(",").map((s) => s.trim());
      const tagOf = (node: unknown) => String((node as { tag?: string }).tag ?? "").toLowerCase();
      const visit = (nodes: unknown[]): void => {
        for (const node of nodes) {
          const n = node as { children?: unknown[]; tag?: string };
          if (want.includes("*") || want.includes(tagOf(n))) out.push(n);
          visit(n.children ?? []);
        }
      };
      visit(children);
      return out;
    },
    hasAttribute: (name: string) => attrsMap.has(name),
    removeAttribute: (name: string) => { attrsMap.delete(name); },
    setAttribute: (name: string, value: string) => { attrsMap.set(name, value); },
    get attributes() { return [...attrsMap.entries()].map(([name, value]) => ({ name, value })); },
    get outerHTML() {
      const inner = children
        .map((c) => (c as { outerHTML?: string }).outerHTML ?? String((c as { textContent: string }).textContent))
        .join("");
      const attrsText = [...attrsMap.entries()].map(([k, v]) => ` ${k}="${v}"`).join("");
      return `<div${attrsText}>${(el as { textContent: string }).textContent}${inner}</div>`;
    },
  };
  (el as { nodeType?: number }).nodeType = 1;
  return el;
}

test("SANITIZE_OUTER_HTML_SOURCE executes verbatim in a foreign scope", () => {
  // The source string must be self-contained text: no transpiler helpers
  // (__name) and no references to identifiers outside its own body/args.
  for (const source of [SANITIZE_OUTER_HTML_SOURCE, EVAL_ON_ELEMENT_SOURCE, EVAL_ON_PAGE_SOURCE, SCROLL_BY_SOURCE]) {
    assert.ok(!source.includes("__name"), `transpiler helper leaked: ${source.slice(0, 60)}`);
    // The Node-side rebuild must keep toString() verbatim — that is exactly
    // what Playwright serializes into the page.
    assert.equal(pageFunction(source).toString(), source);
  }
  const dom = fakeElement(
    {
      style: "color:red",
      "data-large": "A".repeat(600),
      "data-ok": "small",
      src: `data:image/png;base64,${"iVBOR".repeat(120)}`,
    },
    [
      Object.assign(fakeElement({ class: "a b" }) as Record<string, unknown>, { tag: "script", textContent: "alert(1)" }),
      Object.assign(fakeElement({ id: "p" }) as Record<string, unknown>, { tag: "p", textContent: "keep" }),
    ],
  );
  // Run the verbatim string exactly as the page would: in a fresh scope
  // whose only binding is the element/argument — no module names exist.
  const html = vm.runInNewContext(
    `(${SANITIZE_OUTER_HTML_SOURCE})(root, ${SANITIZE_ATTR_PAYLOAD_MIN})`,
    { root: dom },
  ) as string;
  assert.ok(!html.includes("alert(1)"), "script content dropped");
  assert.ok(!/style=/.test(html), "style attribute removed");
  assert.ok(!html.includes("A".repeat(600)) && !html.includes("iVBOR".repeat(120)), "payloads stripped");
  assert.ok(html.includes('data-ok="small"'), "small attributes kept");
  assert.ok(html.includes('class="a b"'), "class kept");
  assert.ok(html.includes('data-large="[stripped]"'), "attribute name preserved");
  // Missing threshold argument must also stay self-contained (fallback 512).
  const html2 = vm.runInNewContext(`(${SANITIZE_OUTER_HTML_SOURCE})(root)`, { root: dom }) as string;
  assert.ok(html2.includes('data-large="[stripped]"'));

  // The eval wrappers in the same foreign scope: function-body script text
  // with element binding for ref form, bare body for page form.
  const byRef = vm.runInNewContext(
    `(${EVAL_ON_ELEMENT_SOURCE})(el, "return element.textContent")`,
    { el: { textContent: "bound" } },
  );
  assert.equal(byRef, "bound");
  const byPage = vm.runInNewContext(
    `(${EVAL_ON_PAGE_SOURCE})("return 40 + 2")`,
    {},
  );
  assert.equal(byPage, 42);
});

test("browser channel choice: msedge first, then chrome, deterministic", () => {
  const env = { PROGRAMFILES: "C:/Program Files", "PROGRAMFILES(X86)": "C:/Program Files (x86)", LOCALAPPDATA: "C:/Users/x/AppData/Local" } as NodeJS.ProcessEnv;
  const none = findBrowserChannel("win32", env, () => false);
  assert.equal(none, undefined);
  const chromeOnly = findBrowserChannel("win32", env, (path) => path.includes("chrome.exe"));
  assert.equal(chromeOnly, "chrome");
  const both = findBrowserChannel("win32", env, () => true);
  assert.equal(both, "msedge");
  const darwin = findBrowserChannel("darwin", {}, (path) => path === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(darwin, "chrome");
  const linux = findBrowserChannel("linux", { PATH: "/usr/bin:/bin" }, (path) => path === "/usr/bin/google-chrome");
  assert.equal(linux, "chrome");
});

/* --------------------------------------------------------- stub engine */

const LAUNCH_TOKEN = "private-launch-token-0001";
const COOKIE_VALUE = "vddodbh-session-cookie-0002";

function stubLocator(actions: string[] = []): UiLocator {
  return {
    click: async (opts) => { actions.push(`click:${opts?.button ?? "left"}:${opts?.clickCount ?? 1}`); },
    fill: async (text) => { actions.push(`fill:${text}`); },
    press: async (key) => { actions.push(`press:${key}`); },
    hover: async () => { actions.push("hover"); },
    selectOption: async (value) => { actions.push(`select:${value}`); },
    scrollIntoViewIfNeeded: async () => { actions.push("scrollIntoView"); },
    ariaSnapshot: async () => `- button "OK" [ref=e1]\n- textbox "Name" [ref=e2]`,
    innerText: async () => "page text with secret " + COOKIE_VALUE,
    evaluate: async (fn, arg) => {
      // Playwright semantics: a string is evaluated as an expression and its
      // *value* returned — it is never invoked as a function. Only a real
      // function is serialized into the page and called with (el, arg).
      if (typeof fn === "string") {
        return new Function(`return (${fn});`)() as never;
      }
      return (fn as (el: unknown, a: unknown) => unknown)(
        { outerHTML: "<p>x</p>", querySelectorAll: () => [], hasAttribute: () => false, removeAttribute: () => undefined, attributes: [] },
        arg,
      ) as never;
    },
    screenshot: async () => Buffer.from("png-bytes"),
    elementHandle: async () => ({ asElement: () => ({}) as never }),
  };
}

function stubPage(url: string, actions: string[] = []): UiPage {
  const listeners = new Map<string, Array<() => void>>();
  return {
    locator: () => stubLocator(actions),
    goto: async (target) => { actions.push(`goto:${target}`); (urlHolder.value = target); },
    title: async () => "Child Space",
    url: () => urlHolder.value,
    ariaSnapshot: async () => `- button "OK" [ref=e1]`,
    innerText: async () => "root text",
    evaluate: async (fn, arg) => {
      if (typeof fn === "string") return new Function(`return (${fn});`)() as never;
      return (fn as (a: unknown) => unknown)(arg) as never;
    },
    mouse: {
      click: async (x, y, opts) => { actions.push(`mouse:${x},${y}:${opts?.button ?? "left"}`); },
      wheel: async (dx, dy) => { actions.push(`wheel:${dy}`); },
    },
    screenshot: async () => Buffer.from("page-png"),
    waitForTimeout: async (ms) => { actions.push(`wait:${ms}`); },
    isClosed: () => false,
    on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
    close: async () => { listeners.get("close")?.forEach((fn) => fn()); },
  };
}
const urlHolder = { value: "http://127.0.0.1:3100/" };

function stubContext(actions: string[]): UiContext & { cookies: unknown[]; closed: boolean } {
  const context = {
    cookies: [] as unknown[],
    closed: false,
    newPage: async () => stubPage(urlHolder.value, actions),
    addCookies: async (cookies: Array<{ name: string; value: string; url: string }>) => {
      context.cookies.push(...cookies);
    },
    close: async () => { context.closed = true; },
    on: () => undefined,
  };
  return context as unknown as UiContext & { cookies: unknown[]; closed: boolean };
}

function stubEngine(actions: string[], contexts: Array<ReturnType<typeof stubContext>>): UiEngine {
  return {
    newContext: async () => {
      const ctx = stubContext(actions);
      contexts.push(ctx);
      return ctx;
    },
    close: async () => { actions.push("engine:close"); },
  };
}

interface Fx {
  manager: UiAutomationManager;
  ports: UiAutomationPorts;
  actions: string[];
  contexts: Array<ReturnType<typeof stubContext>>;
  mutable: {
    status: "running" | "stopped";
    generation: number;
    epoch: string;
    spawned: boolean;
    engineReady: boolean;
  };
}

function makeManager(options: { idleTimeoutMs?: number; engineReady?: boolean } = {}): Fx {
  const actions: string[] = [];
  const contexts: Array<ReturnType<typeof stubContext>> = [];
  const mutable = {
    status: "running" as const,
    generation: 7,
    epoch: "e".repeat(64),
    spawned: true,
    engineReady: options.engineReady !== false,
  };
  const engine = stubEngine(actions, contexts);
  const ports: UiAutomationPorts = {
    requireSpace: (spaceId) => {
      if (!spaceId.startsWith("space-")) throw new WorkbenchPublicError("workbench/not-found");
      return spaceId;
    },
    managerId: () => "spaces-hub",
    unmanaged: () => false,
    statusOf: () => mutable.status,
    generationOf: () => mutable.generation,
    spawned: () => mutable.spawned,
    urlOf: () => `http://127.0.0.1:3100/?token=${LAUNCH_TOKEN}`,
    portOf: () => 3100,
    currentServiceEpoch: () => mutable.epoch,
    fetch: (async () => new Response(null, {
      status: 303,
      headers: { location: "./", "set-cookie": `dsh-auth-x=${COOKIE_VALUE}; HttpOnly; Path=/` },
    })) as typeof fetch,
    resolveEngine: async () => (mutable.engineReady ? { launch: async () => engine } as never : undefined),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
  };
  return { manager: new UiAutomationManager(ports), ports, actions, contexts, mutable: mutable as Fx["mutable"] };
}

const REG = "reg-1";

/* ------------------------------------------------------------ manager */

test("open: whitelist, running+generation+epoch ownership, cookie injection", async () => {
  const fx = makeManager();
  for (const spaceId of ["web", "desktop", "spaces-hub"]) {
    await assert.rejects(() => fx.manager.open(REG, spaceId), (error: unknown) =>
      error instanceof ControlPublicError && error.code === "control/protected", spaceId);
  }
  await assert.rejects(() => fx.manager.open(REG, "ghost"), (error: unknown) =>
    error instanceof ControlPublicError && error.code === "control/not-found");

  const result = await fx.manager.open(REG, "space-alpha");
  assert.match(result.uiSessionId, /^ui-[a-f0-9]{32}$/);
  assert.equal(result.spaceId, "space-alpha");
  assert.equal(result.generation, 7);
  assert.deepEqual(result.viewport, { width: 1280, height: 720 });
  assert.equal(result.path, "/");
  const cookies = fx.contexts[0]!.cookies as Array<{ name: string; value: string; url: string }>;
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0]!.name, "dsh-auth-x");
  assert.equal(cookies[0]!.value, COOKIE_VALUE);
  assert.equal(cookies[0]!.url, "http://127.0.0.1:3100");
  assert.deepEqual(fx.actions, ["goto:http://127.0.0.1:3100/"]);

  // Idempotent open returns the same session for the same generation.
  const again = await fx.manager.open(REG, "space-alpha");
  assert.equal(again.uiSessionId, result.uiSessionId);
  assert.equal(fx.contexts.length, 1);

  // A different registration never sees the session.
  await assert.rejects(() => fx.manager.snapshot("reg-2", { uiSessionId: result.uiSessionId }),
    (error: unknown) => error instanceof ControlPublicError && error.code === "control/not-found");

  // No credential material appears in the open DTO.
  const text = JSON.stringify(result);
  assert.ok(!text.includes(COOKIE_VALUE) && !text.includes(LAUNCH_TOKEN));
});

test("a failed cookie exchange reports control/unavailable, once", async () => {
  const fx = makeManager();
  fx.ports.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
  await assert.rejects(() => fx.manager.open(REG, "space-alpha"), (error: unknown) =>
    error instanceof ControlPublicError && error.code === "control/unavailable");
  assert.equal(fx.contexts.length, 0, "no context survives a failed exchange");
});

test("a failed engine launch is terminal for the epoch", async () => {
  const fx = makeManager();
  fx.ports.resolveEngine = async () => ({
    launch: async () => { throw new Error("chrome died at startup"); },
  }) as never;
  await assert.rejects(() => fx.manager.open(REG, "space-alpha"), (error: unknown) =>
    error instanceof ControlPublicError && error.code === "control/engine-unavailable");
  // Terminal: the manager does not try again with the same epoch.
  fx.ports.resolveEngine = async () => ({ launch: async () => ({}) }) as never;
  await assert.rejects(() => fx.manager.open(REG, "space-alpha"), (error: unknown) =>
    error instanceof ControlPublicError && error.code === "control/engine-unavailable");
});

test("stopped or restarted space invalidates the session and authorization", async () => {
  const fx = makeManager();
  const session = await fx.manager.open(REG, "space-alpha");

  fx.mutable.generation = 8; // restart bumped the run generation
  await assert.rejects(() => fx.manager.snapshot(REG, { uiSessionId: session.uiSessionId }),
    (error: unknown) => error instanceof ControlPublicError && error.code === "control/not-running");
  fx.mutable.generation = 7;

  // Proactive stop notification kills the session for good.
  fx.manager.spaceStatusChanged("space-alpha", "stopped");
  await assert.rejects(() => fx.manager.snapshot(REG, { uiSessionId: session.uiSessionId }),
    (error: unknown) => error instanceof ControlPublicError && error.code === "control/not-running");
  // Closing a dead session is still a plain release, not a second failure.
  const closed = await fx.manager.close(REG, session.uiSessionId);
  assert.deepEqual(closed, { closed: true });

  // A stopped space cannot be opened at all.
  fx.mutable.status = "stopped";
  await assert.rejects(() => fx.manager.open(REG, "space-alpha"), (error: unknown) =>
    error instanceof ControlPublicError && error.code === "control/not-running");
});

test("engine probe is once-per-epoch and terminal", async () => {
  const fx = makeManager({ engineReady: false });
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(() => fx.manager.open(REG, "space-alpha"), (error: unknown) =>
      error instanceof ControlPublicError && error.code === "control/engine-unavailable");
  }
  // No browser exists in the probe result — the manager does not re-probe
  // inside the same service epoch.
  fx.mutable.engineReady = true;
  await assert.rejects(() => fx.manager.open(REG, "space-alpha"), (error: unknown) =>
    error instanceof ControlPublicError && error.code === "control/engine-unavailable");
});

test("snapshot: formats, redaction, ref scoping and screenshot bytes", async () => {
  const fx = makeManager();
  const session = await fx.manager.open(REG, "space-alpha");
  const result = await fx.manager.snapshot(REG, {
    uiSessionId: session.uiSessionId,
    formats: ["aria", "text", "screenshot"],
  });
  assert.match(result.aria ?? "", /\[ref=e1\]/);
  assert.equal(result.text, `page text with secret [redacted]`, "cookie value is redacted");
  assert.equal(result.screenshot, Buffer.from("page-png").toString("base64"));
  assert.equal(result.screenshotBytes, 8);
  assert.equal(result.truncated, false);
  assert.equal(result.path, "/");
});

test("act: closed union dispatch and requestId idempotency", async () => {
  const fx = makeManager();
  const session = await fx.manager.open(REG, "space-alpha");
  const act = { kind: "wait", ms: 5 } as const;
  const first = await fx.manager.act(REG, { uiSessionId: session.uiSessionId, requestId: "r-1", act });
  assert.equal(first.done, true);
  const replay = await fx.manager.act(REG, { uiSessionId: session.uiSessionId, requestId: "r-1", act });
  assert.deepEqual(replay, first);
  await assert.rejects(
    () => fx.manager.act(REG, { uiSessionId: session.uiSessionId, requestId: "r-1", act: { kind: "wait", ms: 6 } }),
    (error: unknown) => error instanceof ControlPublicError && error.code === "control/request-conflict");
  const waits = fx.actions.filter((row) => row === "wait:5");
  assert.equal(waits.length, 1, "the replayed requestId did not re-run the action");
});

test("eval: result is JSON-safe, secrets redacted, oversized results truncate", async () => {
  const fx = makeManager();
  const session = await fx.manager.open(REG, "space-alpha");
  const result = await fx.manager.eval(REG, {
    uiSessionId: session.uiSessionId, requestId: "r-eval", script: "return 1",
  });
  assert.deepEqual(result, { value: 1, truncated: false });
});

test("per-space serialization: a second in-flight op is busy, never queued", async () => {
  const fx = makeManager();
  const session = await fx.manager.open(REG, "space-alpha");
  const inner = fx.manager as unknown as { serialized: (s: unknown, a: () => Promise<unknown>) => Promise<unknown> };
  const stored = (fx.manager as unknown as { sessions: Map<string, { inFlight: boolean }> }).sessions.get(session.uiSessionId)!;
  stored.inFlight = true;
  await assert.rejects(() => inner.serialized(stored, async () => "x"), (error: unknown) =>
    error instanceof ControlPublicError && error.code === "control/busy");
  stored.inFlight = false;
});

test("session limit is enforced globally", async () => {
  const fx = makeManager();
  for (let i = 0; i < 8; i += 1) {
    await fx.manager.open(REG, `space-n${i}`);
  }
  await assert.rejects(() => fx.manager.open(REG, "space-overflow"), (error: unknown) =>
    error instanceof ControlPublicError && error.code === "control/busy");
});

test("idle timeout closes the session as ordinary release", async (t) => {
  const fx = makeManager({ idleTimeoutMs: 25 });
  const session = await fx.manager.open(REG, "space-alpha");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fx.contexts[0]!.closed, true);
  await assert.rejects(() => fx.manager.snapshot(REG, { uiSessionId: session.uiSessionId }),
    (error: unknown) => error instanceof ControlPublicError && error.code === "control/failed");
});

test("closeAll releases contexts and the browser", async () => {
  const fx = makeManager();
  await fx.manager.open(REG, "space-alpha");
  await fx.manager.closeAll();
  assert.equal(fx.contexts[0]!.closed, true);
  assert.deepEqual(fx.actions.filter((row) => row === "engine:close"), ["engine:close"]);
  await assert.rejects(() => fx.manager.open(REG, "space-alpha"), (error: unknown) =>
    error instanceof ControlPublicError && error.code === "control/unavailable");
});
