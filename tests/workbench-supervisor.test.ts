import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Script } from "node:vm";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { HomeController } from "../src/adapters/node/home-controller.ts";
import {
  createWorkbenchSupervisor,
  parseSupervisorArgs,
  supervisorCliArgs,
  type WorkbenchMaintenance,
  type WorkbenchSupervisorHandle,
} from "../src/adapters/node/workbench-supervisor.ts";
import { cookieValue, expectedAuthCookieName, renderEntryPage } from "../src/adapters/node/workbench-http.ts";
import type { PatchWriter } from "../src/main/patch-writer.ts";
import type { ProcessRuntime } from "../src/main/process-manager.ts";
import type { WorkbenchPlan, WorkbenchPlanRequest } from "../src/shared/workbench.ts";

const temps: string[] = [];
const live: ChildProcess[] = [];
const handles: WorkbenchSupervisorHandle[] = [];

test("stable entry scripts parse before any DSH instance is available", () => {
  const html = renderEntryPage({ managerRunning: false, managerViewPath: null,
    maintenance: false, recoveryRequired: false, writable: true, reasons: [] });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  for (const [, source] of scripts) assert.doesNotThrow(() => new Script(source));
});

test("ROOT: interrupted owned manager install resumes without claiming an existing ordinary profile", async () => {
  const home = tempHome();
  const artifact = join(home, "plugin.tgz");
  writeFileSync(artifact, "test archive");
  let fail = true;
  const extra = {
    pluginArtifact: artifact,
    runCli: async (args: readonly string[]) => {
      const profile = args[args.indexOf("--profile") + 1] || "web";
      if (args.includes("--from-default-profile")) writeProfile(home, profile);
      return { code: 0, stdout: dumpText(profile), stderr: "" };
    },
    pluginAdd: async (_home: string, profile: string) => {
      if (fail) throw new Error("install interrupted");
      writeProfile(home, profile, { dependencies: { "@dsh-spaces/plugin": "0.2.0" } });
    },
  };
  const first = await startSupervisor(home, extra);
  assert.equal((await first.runtime.state()).recoveryRequired, true);
  await first.close();
  fail = false;
  const second = await startSupervisor(home, extra);
  assert.equal((await second.runtime.state()).role, "manager");
  assert.equal((await second.runtime.state()).recoveryRequired, false);
  assert.equal(existsSync(join(home, ".dsh-spaces-control", "manager-bootstrap.json")), false);
});

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try {
      await handle.close();
    } catch {
      /* keep lease semantics; still drop the test HTTP server */
    }
    await new Promise<void>((resolveClose) => handle.server.close(() => resolveClose()));
  }
  for (const child of live.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(dirname(dir), `${basename(dir)}-snapshots`), { recursive: true, force: true });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-supervisor-"));
  temps.push(home);
  return home;
}

function writeFakeCli(home: string, version = "0.1.5-rc.1"): string {
  const root = join(home, "cli");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version })}\n`);
  writeFileSync(join(root, "lib", "bin.js"), "console.log('fake-dsh');\n");
  return join(root, "lib", "bin.js");
}

function writeProfile(home: string, name: string, pkg: unknown = {}): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  const record = pkg as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } };
  const manifest = {
    ...record,
    dependencies: {
      "@deepseek-ai/dsh-web-app": "0.1.5-rc.1",
      ...(record.dependencies ?? {}),
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-web-app",
          ...((record.dsh?.profile?.bundles ?? []).filter((item) => item !== "@deepseek-ai/dsh-web-app")),
        ],
      },
    },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(dir, "cordis.patch.yml"),
    `- id: session-persistence-jsonl\n  config:\n    root: keep\n- id: storage-json\n  config:\n    root: keep\n`,
  );
}

function dumpText(profile: string): string {
  return `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/${profile}/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/${profile}/storages')
`;
}

const FIXTURE = `
const http = require("node:http");
const port = Number(process.env.DSH_TEST_PORT);
const mode = process.env.DSH_TEST_MODE || "ok";
const cookieName = process.env.DSH_TEST_COOKIE_NAME || "dsh-auth-fixture";
if (mode === "hang") { setInterval(() => {}, 1e9); }
else {
  const token = "fixture-launch-secret";
  const cookie = cookieName + "=session";
  const server = http.createServer((req, res) => {
    if (req.url && req.url.includes("token=" + token)) {
      res.writeHead(303, { location: "/", "set-cookie": cookie + "; HttpOnly; Path=/; SameSite=Strict" });
      return res.end();
    }
    if (req.headers.cookie !== cookie) {
      res.writeHead(401); return res.end("authentication required");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: { ok: true, value: {} } }));
  });
  server.listen(port, "127.0.0.1", () => console.log("dsh web: http://127.0.0.1:" + port + "/?token=" + token));
}
`;

function spawnFixture(mode = "ok"): ProcessRuntime["spawn"] {
  return (args: string[], options: SpawnOptions = {}): ChildProcess => {
    const port = args[args.indexOf("--port") + 1];
    const child = spawn(process.execPath, ["-e", FIXTURE], {
      ...options,
      env: {
        ...process.env,
        ...(options.env as Record<string, string | undefined> | undefined),
        DSH_TEST_PORT: String(port),
        DSH_TEST_MODE: mode,
        DSH_TEST_COOKIE_NAME: expectedAuthCookieName(`127.0.0.1:${port}`),
      },
    });
    live.push(child);
    child.once("exit", () => {
      const at = live.indexOf(child);
      if (at >= 0) live.splice(at, 1);
    });
    return child;
  };
}

function fakePatchWriter(home: string): PatchWriter {
  return {
    verify: async () => undefined,
    ensureWorkbenchPatch: () => undefined,
    patchPath: (name: string) => join(home, "profiles", name, "cordis.patch.yml"),
  } as unknown as PatchWriter;
}

function fakeMaintenance(): WorkbenchMaintenance {
  return {
    preview: async (request: WorkbenchPlanRequest) => ({
      id: "maint-plan",
      kind: request.kind,
      title: request.kind,
      scope: "home",
      affectedSpaceIds: [],
      runningSpaceIds: [],
      changes: ["delegated"],
      destructive: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    execute: async () => ({ snapshotId: "snap-1" }),
    plugins: async () => [{ id: "p", title: "p", packageName: "p", description: "", version: "1.0.0", installedIn: [], protected: false }],
    snapshots: async () => [],
    snapshot: async () => {
      throw new Error("missing");
    },
    runtimes: async () => [],
    backups: async () => [],
    recover: async () => undefined,
  };
}

async function startSupervisor(
  home: string,
  extra: Partial<Parameters<typeof createWorkbenchSupervisor>[0]> = {},
): Promise<WorkbenchSupervisorHandle> {
  const handle = await createWorkbenchSupervisor({
    home,
    bin: extra.bin ?? writeFakeCli(home),
    port: 0,
    portStart: 34000,
    portEnd: 34999,
    patchWriter: fakePatchWriter(home),
    processRuntime: {
      spawn: spawnFixture("ok"),
      prepareHome: async () => undefined,
      gracefulWaitMs: 40,
      forceWaitMs: 20,
      readyTimeoutMs: 8_000,
      fetchTimeoutMs: 2_000,
      pollMs: 40,
      kill: async (pid, kind) => {
        if (kind === "kill") return;
        await new Promise<void>((resolveKill) => {
          const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.once("exit", () => resolveKill());
          killer.once("error", () => resolveKill());
        });
      },
    },
    runCli: async (args) => {
      const profile = args[args.indexOf("--profile") + 1] ?? "web";
      if (args.includes("--from-default-profile")) {
        writeProfile(home, profile, {
          dependencies: { "@dsh-spaces/plugin": "0.2.0" },
          dsh: { profile: { bundles: ["@dsh-spaces/plugin"] } },
        });
      }
      return { code: 0, stdout: dumpText(profile), stderr: "" };
    },
    dumpConfig: async (profile) => dumpText(profile),
    createMaintenance: () => fakeMaintenance(),
    ...extra,
  });
  handles.push(handle);
  return handle;
}

async function bootstrap(origin: string, bootstrapUrl: string): Promise<string> {
  const response = await fetch(bootstrapUrl, { redirect: "manual" });
  await response.body?.cancel();
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  const setCookie = response.headers.getSetCookie()[0] ?? "";
  const name = expectedAuthCookieName(`127.0.0.1:${new URL(origin).port}`);
  assert.match(setCookie, new RegExp(`^${name}=`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

async function api(
  origin: string,
  cookie: string,
  method: string,
  payload: unknown = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: { ok?: boolean; value?: unknown; error?: { code: string; message: string } } }> {
  const response = await fetch(`${origin}/api/workbench/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as never };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitJob(
  origin: string,
  cookie: string,
  id: string,
  status = "succeeded",
): Promise<{ status: string; error?: { message?: string } }> {
  let last: { status?: string; error?: { message?: string } } | undefined;
  try {
    await waitUntil(async () => {
      const job = await api(origin, cookie, "job", { id });
      last = job.body.value as { status?: string; error?: { message?: string } };
      return last?.status === status || last?.status === "failed" || last?.status === "cancelled";
    }, `job ${id} -> ${status}`);
  } catch (error) {
    throw new Error(`${String(error)}; last=${JSON.stringify(last)}`);
  }
  if (last?.status !== status) {
    throw new Error(`job ${id} ended ${last?.status}: ${last?.error?.message ?? ""}`);
  }
  return last as { status: string; error?: { message?: string } };
}

test("HTTP rejects unknown method, unauthenticated calls, foreign origin, and arbitrary URLs", async () => {
  const handle = await startSupervisor(tempHome());
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);

  const unauth = await fetch(`${handle.origin}/api/workbench/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauth.status, 401);
  const unauthBody = (await unauth.json()) as { ok: boolean; error: { code: string } };
  assert.equal(unauthBody.ok, false);
  assert.equal(unauthBody.error.code, "workbench/unauthorized");

  const foreign = await api(handle.origin, cookie, "state", {}, { origin: "http://127.0.0.1:1" });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.ok, false);

  const unknown = await api(handle.origin, cookie, "not-a-method");
  assert.equal(unknown.status, 404);

  const proxy = await fetch(`${handle.origin}/proxy?url=http://example.com`, { headers: { cookie } });
  assert.equal(proxy.status, 404);
  const proxyBody = (await proxy.json()) as { ok: boolean; error: { message: string } };
  assert.match(proxyBody.error.message, /proxy/i);

  const urlMethod = await fetch(`${handle.origin}/api/workbench/http://127.0.0.1:9`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{}",
  });
  assert.equal(urlMethod.status, 404);

  const ok = await api(handle.origin, cookie, "state");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
});

test("bootstrap exchanges a one-time token for the authority cookie and a clean URL", async () => {
  const handle = await startSupervisor(tempHome());
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const reuse = await fetch(handle.bootstrapUrl, { redirect: "manual" });
  await reuse.body?.cancel();
  assert.equal(reuse.status, 401);

  const page = await fetch(`${handle.origin}/`, { headers: { cookie }, redirect: "manual" });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /稳定入口|工作台入口|救援入口/);
  assert.doesNotMatch(html, /token=/i);
  assert.equal(new URL(handle.origin).hostname, "127.0.0.1");
});

test("workspace origin cannot call management APIs; host bearer can", async () => {
  const home = tempHome();
  writeProfile(home, "alpha", { dependencies: { "@deepseek-ai/dsh-web-app": "0.1.5-rc.1" } });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const started = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "alpha" },
    requestId: "start-alpha",
  });
  assert.equal(started.body.ok, true, JSON.stringify(started.body));
  await waitJob(handle.origin, cookie, "start-alpha");

  const state = await api(handle.origin, cookie, "state");
  const spaces = (state.body.value as { spaces: Array<{ id: string; generation: number }> }).spaces;
  const alpha = spaces.find((row) => row.id === "alpha");
  assert.ok(alpha);
  const view = await api(handle.origin, cookie, "view", { spaceId: "alpha" });
  assert.equal(view.body.ok, true);
  const issued = view.body.value as { origin: string; entryOrigin: string; entryPath: string };
  assert.equal(issued.entryOrigin, handle.origin);
  assert.notEqual(issued.origin, issued.entryOrigin);
  assert.match(issued.entryPath, /^\/view\/alpha\/\d+$/);
  const origin = issued.origin;
  const denied = await api(handle.origin, cookie, "state", {}, { origin });
  assert.equal(denied.status, 403);

  const bearer = readFileSync(join(home, ".dsh-spaces-control", "host.bearer"), "utf8").trim();
  const viaHost = await fetch(`${handle.origin}/api/workbench/state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: "{}",
  });
  const viaBody = (await viaHost.json()) as { ok: boolean };
  assert.equal(viaHost.status, 200);
  assert.equal(viaBody.ok, true);
});

test("role/identity guard does not overwrite an ordinary profile reserved as manager", async () => {
  const home = tempHome();
  writeProfile(home, "spaces-hub", { dependencies: { "dsh-theme-plugin": "0.3.3" } });
  mkdirSync(join(home, ".dsh-spaces-control"), { recursive: true });
  writeFileSync(
    join(home, ".dsh-spaces-control", "manager.json"),
    `${JSON.stringify({ version: 1, profileId: "spaces-hub", createdAt: new Date().toISOString() })}\n`,
  );
  const before = readFileSync(join(home, "profiles", "spaces-hub", "package.json"), "utf8");
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const state = await api(handle.origin, cookie, "state");
  assert.equal(state.body.ok, true);
  const value = state.body.value as { recoveryRequired: boolean; reasons: string[]; managerId: string };
  assert.equal(value.managerId, "spaces-hub");
  assert.equal(value.recoveryRequired, true);
  assert.match(value.reasons.join(" "), /ordinary profile/i);
  assert.equal(readFileSync(join(home, "profiles", "spaces-hub", "package.json"), "utf8"), before);
});

test("jobs.submit is idempotent and maintenance preview is delegated", async () => {
  const home = tempHome();
  writeProfile(home, "alpha", { name: "alpha" });
  const delegated: string[] = [];
  const handle = await startSupervisor(home, {
    createMaintenance: () => ({
      ...fakeMaintenance(),
      preview: async (request) => {
        delegated.push(request.kind);
        return fakeMaintenance().preview(request);
      },
    }),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const first = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "alpha", displayName: "Alpha" },
    requestId: "upd-1",
  });
  const second = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "alpha", displayName: "Alpha" },
    requestId: "upd-1",
  });
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal(second.body.ok, true);
  assert.equal((first.body.value as { id: string }).id, (second.body.value as { id: string }).id);
  await waitJob(handle.origin, cookie, "upd-1");

  const preview = await api(handle.origin, cookie, "preview", {
    request: { kind: "snapshot.create" },
  });
  assert.equal(preview.body.ok, true);
  assert.deepEqual(delegated, ["snapshot.create"]);
});

test("web stop does not force-kill and keeps the instance record", async () => {
  const home = tempHome();
  writeProfile(home, "alpha", { name: "alpha" });
  const kinds: string[] = [];
  const handle = await startSupervisor(home, {
    processRuntime: {
      spawn: spawnFixture("ok"),
      prepareHome: async () => undefined,
      gracefulWaitMs: 40,
      forceWaitMs: 20,
      readyTimeoutMs: 8_000,
      fetchTimeoutMs: 2_000,
      pollMs: 40,
      kill: async (_pid, kind) => {
        kinds.push(kind);
      },
    },
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const started = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "alpha" },
    requestId: "start-live-stop",
  });
  assert.equal(started.body.ok, true, JSON.stringify(started.body));
  await waitJob(handle.origin, cookie, "start-live-stop");

  const preview = await api(handle.origin, cookie, "preview", {
    request: { kind: "space.stop", spaceId: "alpha" },
  });
  assert.equal(preview.body.ok, true);
  const plan = preview.body.value as WorkbenchPlan;
  const stop = await api(handle.origin, cookie, "submit", {
    command: { kind: "plan.execute", planId: plan.id },
    requestId: "stop-noforce",
  });
  assert.equal(stop.body.ok, true, JSON.stringify(stop.body));
  await waitJob(handle.origin, cookie, "stop-noforce", "failed");
  const job = await api(handle.origin, cookie, "job", { id: "stop-noforce" });
  const value = job.body.value as { status: string; error?: { message?: string } };
  assert.equal(value.status, "failed");
  assert.deepEqual(kinds, ["term"]);
  const state = await api(handle.origin, cookie, "state");
  const alpha = (state.body.value as { spaces: Array<{ id: string; status: string }> }).spaces.find((row) => row.id === "alpha");
  assert.ok(alpha);
  assert.notEqual(alpha.status, "stopped");
});

test("stable entry still responds after the manager process is gone", async () => {
  const home = tempHome();
  writeProfile(home, "alpha", { name: "alpha" });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const started = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "alpha" },
    requestId: "start-live",
  });
  assert.equal(started.body.ok, true, JSON.stringify(started.body));
  await waitJob(handle.origin, cookie, "start-live");
  for (const child of live.splice(0)) {
    child.kill("SIGKILL");
  }
  const page = await fetch(`${handle.origin}/`, { headers: { cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /稳定入口|救援入口|工作台入口|管理环境/);
  const state = await api(handle.origin, cookie, "state");
  assert.equal(state.body.ok, true);
});

test("busy home keeps a read-only entry and does not write the job store", async () => {
  const home = tempHome();
  const holder = new HomeController(home).acquire("desktop");
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const page = await fetch(`${handle.origin}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  await page.text();
  const state = await api(handle.origin, cookie, "state");
  assert.equal((state.body.value as { writable: boolean }).writable, false);
  const submit = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "alpha", displayName: "nope" },
    requestId: "busy-1",
  });
  assert.equal(submit.body.ok, false);
  assert.equal(submit.body.error?.code, "workbench/read-only");
  assert.equal(existsSync(join(home, ".dsh-spaces-control", "jobs")), false);
  const acquire = await api(handle.origin, cookie, "submit", {
    command: { kind: "controller.acquire" },
    requestId: "acq-1",
  });
  assert.equal(acquire.body.ok, false);
  assert.equal(acquire.body.error?.code, "workbench/busy");
  holder.release();
});

test("shutdown persists the job then releases rights without deadlocking on whenIdle", async () => {
  const home = tempHome();
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const preview = await api(handle.origin, cookie, "preview", { request: { kind: "controller.shutdown" } });
  assert.equal(preview.body.ok, true);
  const planId = (preview.body.value as { id: string }).id;
  const submitted = await api(handle.origin, cookie, "submit", {
    command: { kind: "plan.execute", planId },
    requestId: "bye-1",
  });
  assert.equal(submitted.body.ok, true);
  const jobFile = join(home, ".dsh-spaces-control", "jobs", "bye-1.json");
  await waitUntil(() => {
    if (!existsSync(jobFile)) return false;
    const record = JSON.parse(readFileSync(jobFile, "utf8")) as { status: string };
    return record.status === "succeeded";
  }, "shutdown job persisted");
  await waitUntil(() => !existsSync(join(home, ".dsh-spaces-control", "run", "owner.json")), "owner released");
  const record = JSON.parse(readFileSync(jobFile, "utf8")) as { status: string; kind: string };
  assert.equal(record.status, "succeeded");
  assert.equal(record.kind, "plan.execute");
});

test("incompatible rc.2 CLI is not admitted; CLI flags stay Node-only paths", async () => {
  const home = tempHome();
  const bin = writeFakeCli(home, "0.1.5-rc.2");
  const handle = await startSupervisor(home, { bin });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const state = await api(handle.origin, cookie, "state");
  const value = state.body.value as { dshVersion: string | null; reasons: string[] };
  assert.equal(value.dshVersion, null);
  assert.match(value.reasons.join(" "), /0\.1\.5-rc\.1|compatible|CLI/i);

  const parsed = parseSupervisorArgs([
    "--home",
    home,
    "--bin",
    bin,
    "--node",
    process.execPath,
    "--port",
    "0",
  ]);
  assert.equal(parsed.home, home);
  assert.deepEqual(supervisorCliArgs(parsed).slice(0, 4), ["--home", home, "--bin", bin]);
  assert.throws(() => parseSupervisorArgs(["--home", home]), /--bin/);
});

test("CLI accepts --cli as an alias of --bin and writes a private endpoint file", async () => {
  const home = tempHome();
  const bin = writeFakeCli(home);
  const parsed = parseSupervisorArgs(["--home", home, "--cli", bin, "--node", process.execPath, "--port", "0"]);
  assert.equal(parsed.bin, bin);
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const endpoint = JSON.parse(
    readFileSync(join(home, ".dsh-spaces-control", "endpoint.json"), "utf8"),
  ) as { version: number; origin: string; bearer: string };
  assert.equal(endpoint.version, 1);
  assert.equal(endpoint.origin.startsWith(handle.origin), true);
  const bearer = readFileSync(join(home, ".dsh-spaces-control", "host.bearer"), "utf8").trim();
  assert.equal(endpoint.bearer, bearer);
  const minted = await fetch(`${handle.origin}/internal/bootstrap`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
  });
  const mintedBody = (await minted.json()) as { url: string };
  assert.equal(minted.status, 200);
  assert.match(mintedBody.url, /^http:\/\/127\.0\.0\.1:\d+\/bootstrap\//);
  assert.doesNotMatch(JSON.stringify(mintedBody), /token=/i);
  const page = await fetch(`${handle.origin}/`, { headers: { cookie } });
  const html = await page.text();
  assert.match(html, /检查并恢复/);
  assert.doesNotMatch(html, /标记恢复完成/);
});

test("recovery resume does not cancel unrelated interrupted jobs", async () => {
  const home = tempHome();
  writeProfile(home, "alpha", { name: "alpha" });
  mkdirSync(join(home, ".dsh-spaces-control", "jobs"), { recursive: true });
  writeFileSync(
    join(home, ".dsh-spaces-control", "jobs", "old-space.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "old-space",
      requestId: "old-space",
      kind: "space.start",
      command: { kind: "space.start", spaceId: "alpha" },
      commandCanonical: JSON.stringify({ kind: "space.start", spaceId: "alpha" }),
      status: "recovery-required",
      phase: "start",
      message: "",
      affectedSpaceIds: ["alpha"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canCancel: false,
    })}\n`,
  );
  const handle = await startSupervisor(home, {
    createMaintenance: () => ({
      ...fakeMaintenance(),
      recover: async () => undefined,
      recoveryOutcome: () => ({
        restoreCompleted: false,
        upgradeRolledBack: false,
        consistent: true,
        settleInterruptedJobs: true,
        message: "No pending snapshot or upgrade journal.",
      }),
    }),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const resume = await api(handle.origin, cookie, "submit", {
    command: { kind: "recovery.resume" },
    requestId: "resume-1",
  });
  assert.equal(resume.body.ok, true, JSON.stringify(resume.body));
  await waitJob(handle.origin, cookie, "resume-1");
  const leftover = JSON.parse(readFileSync(join(home, ".dsh-spaces-control", "jobs", "old-space.json"), "utf8")) as {
    status: string;
  };
  assert.equal(leftover.status, "recovery-required");
});

test("entry cookie helper names match the A0 authority digest", () => {
  assert.equal(
    expectedAuthCookieName("127.0.0.1:9"),
    expectedAuthCookieName("127.0.0.1:9"),
  );
  assert.notEqual(expectedAuthCookieName("127.0.0.1:9"), expectedAuthCookieName("127.0.0.1:10"));
  assert.match(expectedAuthCookieName("127.0.0.1:9"), /^dsh-auth-[A-Za-z0-9_-]+$/);
  assert.equal(cookieValue("a=1; dsh-auth-x=secret; b=2", "dsh-auth-x"), "secret");
});

test("ROOT: initialization starts the real manager lifecycle before normal entry", async () => {
  const handle = await startSupervisor(tempHome());
  const state = await handle.runtime.state();
  assert.ok(state.managerId);
  assert.equal(state.spaces.find(space => space.id === state.managerId)?.status, "running");
});

test("ROOT: failed child shutdown preserves exclusive run rights", async () => {
  const home = tempHome();
  writeProfile(home, "alpha", { name: "alpha" });
  const handle = await startSupervisor(home, { processRuntime: {
    spawn: spawnFixture("ok"),
    prepareHome: async () => undefined,
    kill: async () => undefined,
    gracefulWaitMs: 30, forceWaitMs: 10,
    readyTimeoutMs: 8000, pollMs: 20,
  } });
  await handle.runtime.submit({ kind: "space.start", spaceId: "alpha" }, "root-start");
  await waitUntil(async () => (await handle.runtime.job("root-start")).status === "succeeded", "root start");
  await assert.rejects(() => handle.close());
  assert.equal(new HomeController(home).inspect().held, true);
});
