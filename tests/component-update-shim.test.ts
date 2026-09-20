import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import {
  isPluginRegistryRequest,
  rewritePluginRegistryUrl,
} from "./fixtures/component-update/rewrite.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const SHIM = join(ROOT, "fixtures", "component-update", "fetch-shim.mjs");
const temps: string[] = [];

after(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-component-update-shim-"));
  temps.push(dir);
  return dir;
}

function probeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, NODE_OPTIONS: "", ...env, ELECTRON_RUN_AS_NODE: "" };
}

function spawnProbe(env: NodeJS.ProcessEnv, script: string): { status: number | null; stdout: string; stderr: string } {
  const dir = tempDir();
  const file = join(dir, "probe.mjs");
  writeFileSync(file, script, "utf8");
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(SHIM).href, file], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    env: probeEnv(env),
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: `${result.stderr || ""}${result.error?.message || ""}`,
  };
}

/** Parent HTTP fixture + child --import must use async spawn. spawnSync blocks the event loop so the fixture never accepts. */
function spawnProbeAsync(env: NodeJS.ProcessEnv, script: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const dir = tempDir();
  const file = join(dir, "probe.mjs");
  writeFileSync(file, script, "utf8");
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(SHIM).href, file], {
      windowsHide: true,
      env: probeEnv(env),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ status: null, stdout, stderr: `${stderr}ETIMEDOUT` });
    }, 15_000);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ status: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

test("rewrite maps only @dsh-spaces/plugin packument and tarball URLs onto loopback fixture", () => {
  const fixture = "http://127.0.0.1:17999";
  assert.equal(
    rewritePluginRegistryUrl("https://registry.npmjs.org/%40dsh-spaces%2Fplugin", fixture),
    "http://127.0.0.1:17999/%40dsh-spaces%2Fplugin",
  );
  assert.equal(
    rewritePluginRegistryUrl("https://registry.npmmirror.com/@dsh-spaces/plugin", fixture),
    "http://127.0.0.1:17999/@dsh-spaces/plugin",
  );
  assert.equal(
    rewritePluginRegistryUrl(
      "https://registry.npmjs.org/@dsh-spaces/plugin/-/dsh-spaces-plugin-0.3.1-test.1.tgz",
      fixture,
    ),
    "http://127.0.0.1:17999/@dsh-spaces/plugin/-/dsh-spaces-plugin-0.3.1-test.1.tgz",
  );
  assert.equal(isPluginRegistryRequest("https://registry.npmjs.org/@dsh-spaces/view-bridge"), false);
  assert.equal(isPluginRegistryRequest("https://registry.npmjs.org/@deepseek-ai/dsh"), false);
  assert.equal(rewritePluginRegistryUrl("https://nodejs.org/dist/index.json", fixture), null);
  assert.equal(rewritePluginRegistryUrl("http://127.0.0.1:9/api/workbench/state", fixture), null);
  assert.equal(rewritePluginRegistryUrl("https://registry.npmjs.org/%40dsh-spaces%2Fplugin", "https://example.invalid"), null);
});

test("shim refuses to load without the disposable-Home flag (not a silent backdoor)", () => {
  const refused = spawnProbe({}, "console.log('loaded')\n");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /DSH_TEST_COMPONENT_UPDATE=1/);
});

test("shim refuses real ~/.dsh even when the flag is set", () => {
  const real = resolve(homedir(), ".dsh");
  const refused = spawnProbe(
    {
      DSH_TEST_COMPONENT_UPDATE: "1",
      DSH_TEST_COMPONENT_UPDATE_HOME: real,
      DSH_HOME: real,
      DSH_TEST_FIXTURE_REGISTRY: "http://127.0.0.1:9",
    },
    "console.log('loaded')\n",
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refuses real/);
});

test("shim redirects plugin registry fetch to loopback fixture and passes other requests through", async () => {
  const home = tempDir();
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/@dsh-spaces/plugin" || req.url === "/%40dsh-spaces%2Fplugin") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "@dsh-spaces/plugin", fixture: true }));
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listen failed");
  const fixture = `http://127.0.0.1:${address.port}`;
  try {
    const other = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ other: true, path: req.url }));
    });
    await new Promise<void>((resolveListen) => other.listen(0, "127.0.0.1", resolveListen));
    const otherAddr = other.address();
    if (!otherAddr || typeof otherAddr === "string") throw new Error("passthrough listen failed");
    const otherUrl = `http://127.0.0.1:${otherAddr.port}/health`;
    try {
      const probe = await spawnProbeAsync(
        {
          DSH_TEST_COMPONENT_UPDATE: "1",
          DSH_TEST_COMPONENT_UPDATE_HOME: home,
          DSH_HOME: home,
          DSH_SPACES_HOME: home,
          DSH_TEST_FIXTURE_REGISTRY: fixture,
        },
        `
const plugin = await fetch("https://registry.npmjs.org/${encodeURIComponent("@dsh-spaces/plugin")}");
const passthrough = await fetch(${JSON.stringify(otherUrl)});
const pluginBody = await plugin.json();
const otherBody = await passthrough.json();
if (!pluginBody.fixture) throw new Error("plugin packument was not the local fixture");
if (!otherBody.other) throw new Error("non-plugin fetch was not passed through");
if (globalThis.fetch.shim !== "dsh-spaces-component-update-fixture") throw new Error("fetch was not patched");
console.log("ok");
`,
      );
      assert.equal(probe.status, 0, probe.stderr || probe.stdout);
      assert.match(probe.stdout, /^ok/m);
      assert.ok(hits.some((row) => row.includes("@dsh-spaces/plugin") || row.includes("%40dsh-spaces%2Fplugin")));
    } finally {
      await new Promise<void>((resolveClose) => other.close(() => resolveClose()));
    }
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
