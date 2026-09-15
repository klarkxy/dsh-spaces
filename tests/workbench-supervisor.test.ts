import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Script } from "node:vm";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { HomeController } from "../src/adapters/node/home-controller.ts";
import { HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE } from "../src/adapters/node/home-operation-lock.ts";
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

test("default entry origin survives clean cold restart while explicit port zero stays ephemeral", async () => {
  const home = tempHome();
  const first = await startSupervisor(home, { port: undefined });
  const origin = first.origin;
  await first.close();
  const second = await startSupervisor(home, { port: undefined });
  assert.equal(second.origin, origin);
  const saved = JSON.parse(readFileSync(join(home, ".dsh-spaces-control", "entry-port.json"), "utf8"));
  assert.equal(saved.port, Number(new URL(origin).port));
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
      if (profile === "web" && args.includes("--from-default-profile")) {
        return {
          code: 1,
          stdout: "",
          stderr: "error: profile web is shipped and cannot be a custom profile target; omit --from-default-profile",
        };
      }
      if (args.includes("--from-default-profile") || (profile === "web" && args.includes("--dump-config"))) {
        writeProfile(home, profile);
      }
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

function writeInterruptedJob(
  home: string,
  input: {
    id: string;
    kind: string;
    command: Record<string, unknown>;
    phase: string;
    affectedSpaceIds?: string[];
  },
): void {
  const dir = join(home, ".dsh-spaces-control", "jobs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${input.id}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      id: input.id,
      requestId: input.id,
      kind: input.kind,
      command: input.command,
      commandCanonical: JSON.stringify(input.command),
      status: "recovery-required",
      phase: input.phase,
      message: "",
      affectedSpaceIds: input.affectedSpaceIds ?? [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canCancel: false,
    })}\n`,
  );
}

function writeInterruptedPlan(
  home: string,
  id: string,
  command: { kind: string; snapshotId?: string },
): void {
  const dir = join(home, ".dsh-spaces-control", "plans");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      id,
      public: { id, kind: command.kind, title: command.kind, scope: "home", affectedSpaceIds: [], runningSpaceIds: [], changes: [], destructive: true, expiresAt: "2026-01-01T00:05:00.000Z" },
      command,
      fingerprint: "fp",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
      status: "running",
    })}\n`,
  );
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
      if (profile === "web" && args.includes("--from-default-profile")) {
        return {
          code: 1,
          stdout: "",
          stderr: "error: profile web is shipped and cannot be a custom profile target; omit --from-default-profile",
        };
      }
      if (args.includes("--from-default-profile")) {
        writeProfile(home, profile, {
          dependencies: { "@dsh-spaces/plugin": "0.2.0" },
          dsh: { profile: { bundles: ["@dsh-spaces/plugin"] } },
        });
      } else if (profile === "web" && args.includes("--dump-config")) {
        writeProfile(home, "web");
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

function jobStatus(home: string, id: string): string {
  return (JSON.parse(readFileSync(join(home, ".dsh-spaces-control", "jobs", `${id}.json`), "utf8")) as { status: string }).status;
}

async function waitJob(
  origin: string,
  cookie: string,
  id: string,
  status = "succeeded",
): Promise<{ status: string; message?: string; error?: { message?: string } }> {
  let last: { status?: string; message?: string; error?: { message?: string } } | undefined;
  try {
    await waitUntil(async () => {
      const job = await api(origin, cookie, "job", { id });
      last = job.body.value as { status?: string; message?: string; error?: { message?: string } };
      return last?.status === status || last?.status === "failed" || last?.status === "cancelled";
    }, `job ${id} -> ${status}`);
  } catch (error) {
    throw new Error(`${String(error)}; last=${JSON.stringify(last)}`);
  }
  if (last?.status !== status) {
    throw new Error(`job ${id} ended ${last?.status}: ${last?.error?.message ?? last?.message ?? ""}`);
  }
  return last as { status: string; message?: string; error?: { message?: string } };
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
  assert.match(html, /工作台入口|管理环境/);
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

test("maintenance polling preserves inventory during a Home swap and reads live job progress", async () => {
  const home = tempHome();
  writeProfile(home, "alpha");
  let release!: () => void;
  const paused = new Promise<void>(resolvePause => { release = resolvePause; });
  const handle = await startSupervisor(home, {
    createMaintenance: ports => ({
      ...fakeMaintenance(),
      execute: async (_plan, ctx) => {
        ports.setMaintenance(true);
        const original = join(home, "profiles", "alpha");
        const staged = join(home, "alpha-held-by-restore");
        renameSync(original, staged);
        try {
          writeProfile(home, "beta");
          ctx.phase("stage");
          await paused;
        } finally {
          renameSync(staged, original);
          ports.setMaintenance(false);
        }
      },
    }),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await handle.runtime.preview({ kind: "snapshot.create" });
  await handle.runtime.submit({ kind: "plan.execute", planId: "maint-plan" }, "inventory-swap");
  try {
    await waitUntil(async () => (await handle.runtime.job("inventory-swap")).phase === "stage", "maintenance stage");
    const response = await api(handle.origin, cookie, "state");
    assert.equal(response.body.ok, true);
    const state = response.body.value as Awaited<ReturnType<typeof handle.runtime.state>>;
    assert.equal(state.maintenance, true);
    assert.equal(state.recoveryRequired, false);
    assert.ok(state.spaces.some(row => row.id === "alpha"));
    assert.equal(state.spaces.some(row => row.id === "beta"), false);
    assert.equal(state.jobs.find(job => job.id === "inventory-swap")?.phase, "stage");
    const entry = await fetch(handle.origin, { headers: { cookie } });
    assert.equal(entry.status, 200);
    await entry.body?.cancel();
  } finally { release(); }
  await waitJob(handle.origin, cookie, "inventory-swap");
  const refreshed = await handle.runtime.state();
  assert.equal(refreshed.maintenance, false);
  assert.ok(refreshed.spaces.some(row => row.id === "beta"));
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
  assert.match(html, /工作台入口|管理环境/);
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

test("web release then desktop acquire refuses web writes as read-only or busy, not as releasing", async () => {
  const home = tempHome();
  writeProfile(home, "alpha", { name: "alpha" });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const preview = await api(handle.origin, cookie, "preview", { request: { kind: "controller.release" } });
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body));
  const planId = (preview.body.value as { id: string }).id;
  const submitted = await api(handle.origin, cookie, "submit", {
    command: { kind: "plan.execute", planId },
    requestId: "rel-1",
  });
  assert.equal(submitted.body.ok, true, JSON.stringify(submitted.body));
  await waitUntil(() => {
    if (!existsSync(join(home, ".dsh-spaces-control", "jobs", "rel-1.json"))) return false;
    const record = JSON.parse(readFileSync(join(home, ".dsh-spaces-control", "jobs", "rel-1.json"), "utf8")) as {
      status: string;
    };
    return record.status === "succeeded";
  }, "release job persisted");
  await waitUntil(() => !existsSync(join(home, ".dsh-spaces-control", "run", "owner.json")), "web owner released");

  const afterRelease = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "alpha", displayName: "web-should-not-write" },
    requestId: "web-after-release",
  });
  assert.equal(afterRelease.body.ok, false);
  assert.equal(afterRelease.body.error?.code, "workbench/read-only");
  assert.doesNotMatch(afterRelease.body.error?.message ?? "", /releasing run rights/i);

  const desktop = new HomeController(home).acquire("desktop");
  const whileDesktop = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "alpha", displayName: "web-should-not-write" },
    requestId: "web-while-desktop",
  });
  assert.equal(whileDesktop.body.ok, false);
  assert.match(whileDesktop.body.error?.code ?? "", /read-only|busy/);
  assert.doesNotMatch(whileDesktop.body.error?.message ?? "", /releasing run rights/i);
  const steal = await api(handle.origin, cookie, "submit", {
    command: { kind: "controller.acquire" },
    requestId: "web-steal",
  });
  assert.equal(steal.body.ok, false);
  assert.equal(steal.body.error?.code, "workbench/busy");

  desktop.release();
  const reacquire = await api(handle.origin, cookie, "submit", {
    command: { kind: "controller.acquire" },
    requestId: "web-reacquire",
  });
  assert.equal(reacquire.body.ok, true, JSON.stringify(reacquire.body));
  const write = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "alpha", displayName: "web-after-reacquire" },
    requestId: "web-write",
  });
  assert.equal(write.body.ok, true, JSON.stringify(write.body));
  await waitJob(handle.origin, cookie, "web-write");
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
  let shutdownWrite: { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
  try {
    shutdownWrite = (await api(handle.origin, cookie, "submit", {
      command: { kind: "controller.acquire" },
      requestId: "after-shutdown",
    })).body;
  } catch {
    shutdownWrite = { ok: false };
  }
  assert.notEqual(shutdownWrite?.ok, true);
  if (shutdownWrite?.error?.message) {
    assert.match(shutdownWrite.error.message, /releasing run rights|read-only|unavailable/i);
  }
});

test("rc.2 CLI is admitted; unknown versions stay out; CLI flags stay Node-only paths", async () => {
  const rc2Home = tempHome();
  const rc2 = writeFakeCli(rc2Home, "0.1.5-rc.2");
  const admitted = await startSupervisor(rc2Home, { bin: rc2 });
  const cookie = await bootstrap(admitted.origin, admitted.bootstrapUrl);
  const state = await api(admitted.origin, cookie, "state");
  const value = state.body.value as { dshVersion: string | null; reasons: string[] };
  assert.equal(value.dshVersion, "0.1.5-rc.2");
  assert.doesNotMatch(value.reasons.join(" "), /not a supported version|not the supported/i);

  const unknownHome = tempHome();
  const unknownBin = writeFakeCli(unknownHome, "0.1.5-rc.3");
  const blocked = await startSupervisor(unknownHome, { bin: unknownBin });
  const blockedCookie = await bootstrap(blocked.origin, blocked.bootstrapUrl);
  const blockedState = await api(blocked.origin, blockedCookie, "state");
  const blockedValue = blockedState.body.value as { dshVersion: string | null; reasons: string[] };
  assert.equal(blockedValue.dshVersion, null);
  assert.match(blockedValue.reasons.join(" "), /0\.1\.5-rc\.1, 0\.1\.5-rc\.2|supported version/i);

  const parsed = parseSupervisorArgs([
    "--home",
    rc2Home,
    "--bin",
    rc2,
    "--node",
    process.execPath,
    "--port",
    "0",
  ]);
  assert.equal(parsed.home, rc2Home);
  assert.deepEqual(supervisorCliArgs(parsed).slice(0, 4), ["--home", rc2Home, "--bin", rc2]);
  assert.throws(() => parseSupervisorArgs(["--home", rc2Home]), /--bin/);
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
  assert.doesNotMatch(html, /检查并恢复|救援入口|需要恢复|recovery\.resume/);
  assert.match(html, /查看错误详情|复制脱敏日志|接管运行权/);
  assert.doesNotMatch(html, /标记恢复完成/);
});

test("recovery.resume is unsupported and leftover jobs stay failed", async () => {
  const home = tempHome();
  writeProfile(home, "alpha", { name: "alpha" });
  writeInterruptedJob(home, {
    id: "old-space",
    kind: "space.start",
    command: { kind: "space.start", spaceId: "alpha" },
    phase: "start",
    affectedSpaceIds: ["alpha"],
  });
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
  const leftoverBefore = readFileSync(join(home, ".dsh-spaces-control", "jobs", "old-space.json"));
  const resume = await api(handle.origin, cookie, "submit", {
    command: { kind: "recovery.resume" },
    requestId: "resume-1",
  });
  assert.equal(resume.body.ok, false, JSON.stringify(resume.body));
  assert.equal(resume.body.error?.code, "workbench/unsupported");
  const leftoverAfter = readFileSync(join(home, ".dsh-spaces-control", "jobs", "old-space.json"));
  assert.deepEqual(leftoverAfter, leftoverBefore);
});

async function assertRecoveryResumeUnsupported(
  origin: string,
  cookie: string,
  files: string[],
  requestId: string,
): Promise<void> {
  const before = files.map((path) => (existsSync(path) ? readFileSync(path) : Buffer.from("")));
  const resume = await api(origin, cookie, "submit", {
    command: { kind: "recovery.resume" },
    requestId,
  });
  assert.equal(resume.body.ok, false, JSON.stringify(resume.body));
  assert.equal(resume.body.error?.code, "workbench/unsupported");
  for (let i = 0; i < files.length; i += 1) {
    const path = files[i]!;
    const after = existsSync(path) ? readFileSync(path) : Buffer.from("");
    assert.deepEqual(after, before[i]);
  }
}

test("recovery resume settles only the matching plan.execute restore and fails while others remain", async () => {
  const home = tempHome();
  const snapA = "11111111-1111-1111-1111-111111111111";
  const snapB = "22222222-2222-2222-2222-222222222222";
  writeInterruptedPlan(home, "plan-restore-a", { kind: "snapshot.restore", snapshotId: snapA });
  writeInterruptedPlan(home, "plan-restore-b", { kind: "snapshot.restore", snapshotId: snapB });
  writeInterruptedPlan(home, "plan-upgrade", { kind: "runtime.upgrade" });
  writeInterruptedJob(home, {
    id: "job-restore-a",
    kind: "plan.execute",
    command: { kind: "plan.execute", planId: "plan-restore-a" },
    phase: "restore",
  });
  writeInterruptedJob(home, {
    id: "job-restore-b",
    kind: "plan.execute",
    command: { kind: "plan.execute", planId: "plan-restore-b" },
    phase: "restore",
  });
  writeInterruptedJob(home, {
    id: "job-upgrade",
    kind: "plan.execute",
    command: { kind: "plan.execute", planId: "plan-upgrade" },
    phase: "commit",
  });
  writeFileSync(join(home, ".dsh-spaces-control", "jobs", "broken.json"), "{\"schemaVersion\":1,\"status\":\"running\"");
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const files = [
    join(home, ".dsh-spaces-control", "jobs", "job-restore-a.json"),
    join(home, ".dsh-spaces-control", "jobs", "job-restore-b.json"),
    join(home, ".dsh-spaces-control", "jobs", "job-upgrade.json"),
    join(home, ".dsh-spaces-control", "jobs", "broken.json"),
    join(home, ".dsh-spaces-control", "plans", "plan-restore-a.json"),
    join(home, ".dsh-spaces-control", "plans", "plan-restore-b.json"),
    join(home, ".dsh-spaces-control", "plans", "plan-upgrade.json"),
  ];
  await assertRecoveryResumeUnsupported(handle.origin, cookie, files, "resume-match-1");
  await assertRecoveryResumeUnsupported(handle.origin, cookie, files, "resume-match-2");
  assert.equal(jobStatus(home, "job-restore-a"), "recovery-required");
  assert.equal(jobStatus(home, "job-restore-b"), "recovery-required");
  assert.equal(jobStatus(home, "job-upgrade"), "recovery-required");
});

test("recovery resume does not settle jobs or start the manager when pending recover fails", async () => {
  const home = tempHome();
  writeInterruptedPlan(home, "plan-restore-a", {
    kind: "snapshot.restore",
    snapshotId: "11111111-1111-1111-1111-111111111111",
  });
  writeInterruptedJob(home, {
    id: "job-restore-a",
    kind: "plan.execute",
    command: { kind: "plan.execute", planId: "plan-restore-a" },
    phase: "restore",
  });
  mkdirSync(join(home, ".dsh-spaces-control"), { recursive: true });
  writeFileSync(
    join(home, ".dsh-spaces-control", "plugin-mutation.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      phase: "mutating",
      planId: "plan-plugin-1",
      spaceIds: ["alpha"],
      expected: [],
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
  const mutation = readFileSync(join(home, ".dsh-spaces-control", "plugin-mutation.json"), "utf8");
  const handle = await startSupervisor(home, {
    createMaintenance: () => ({
      ...fakeMaintenance(),
      recover: async () => {
        throw new Error("pending restore unreadable");
      },
      recoveryOutcome: () => ({
        restoreCompleted: false,
        upgradeRolledBack: false,
        consistent: false,
        settleInterruptedJobs: false,
        message: "Pending restore metadata is unreadable. Original bytes were left in place.",
      }),
    }),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await assertRecoveryResumeUnsupported(
    handle.origin,
    cookie,
    [
      join(home, ".dsh-spaces-control", "jobs", "job-restore-a.json"),
      join(home, ".dsh-spaces-control", "plugin-mutation.json"),
      join(home, ".dsh-spaces-control", "plans", "plan-restore-a.json"),
    ],
    "resume-fail-1",
  );
  assert.equal(jobStatus(home, "job-restore-a"), "recovery-required");
  assert.equal(readFileSync(join(home, ".dsh-spaces-control", "plugin-mutation.json"), "utf8"), mutation);
});

test("ROOT cold recovery opens with a dead transaction lock and reclaims only after explicit resume", async () => {
  for (const pid of [2147483647, process.pid]) {
    const home = tempHome();
    await new HomeController(home).ensureManager();
    const lockDir = join(home, HOME_LOCK_DIR_NAME);
    mkdirSync(lockDir);
    const owner = JSON.stringify({ pid, nonce: "a".repeat(32), startedAt: new Date().toISOString(), label: "interrupted-restore" });
    writeFileSync(join(lockDir, HOME_LOCK_OWNER_FILE), owner);
    const handle = await startSupervisor(home, { createMaintenance: () => fakeMaintenance() });
    const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
    assert.equal((await handle.runtime.state()).writable, true);
    await assertRecoveryResumeUnsupported(
      handle.origin,
      cookie,
      [join(lockDir, HOME_LOCK_OWNER_FILE)],
      `resume-lock-${pid}`,
    );
    assert.equal(existsSync(lockDir), true);
    assert.equal(existsSync(join(home, ".dsh-spaces-reclaim")), false);
  }
});

test("ROOT package recovery settles only its matching job and preserves abandoned failure", async () => {
  const home = tempHome();
  for (const suffix of ["a", "b"]) {
    writeInterruptedPlan(home, `plan-package-${suffix}`, { kind: "workbench.upgrade" });
    writeInterruptedJob(home, {
      id: `job-package-${suffix}`, kind: "plan.execute", phase: "install",
      command: { kind: "plan.execute", planId: `plan-package-${suffix}` },
    });
  }
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await assertRecoveryResumeUnsupported(
    handle.origin,
    cookie,
    [
      join(home, ".dsh-spaces-control", "jobs", "job-package-a.json"),
      join(home, ".dsh-spaces-control", "jobs", "job-package-b.json"),
      join(home, ".dsh-spaces-control", "plans", "plan-package-a.json"),
      join(home, ".dsh-spaces-control", "plans", "plan-package-b.json"),
    ],
    "resume-package",
  );
  assert.equal(jobStatus(home, "job-package-a"), "recovery-required");
  assert.equal(jobStatus(home, "job-package-b"), "recovery-required");
});

test("recovery resume settles only the matching runtime.upgrade planId", async () => {
  const home = tempHome();
  writeInterruptedPlan(home, "plan-upgrade-a", { kind: "runtime.upgrade" });
  writeInterruptedPlan(home, "plan-upgrade-b", { kind: "runtime.upgrade" });
  writeInterruptedJob(home, {
    id: "job-upgrade-a",
    kind: "plan.execute",
    command: { kind: "plan.execute", planId: "plan-upgrade-a" },
    phase: "commit",
  });
  writeInterruptedJob(home, {
    id: "job-upgrade-b",
    kind: "plan.execute",
    command: { kind: "plan.execute", planId: "plan-upgrade-b" },
    phase: "commit",
  });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await assertRecoveryResumeUnsupported(
    handle.origin,
    cookie,
    [
      join(home, ".dsh-spaces-control", "jobs", "job-upgrade-a.json"),
      join(home, ".dsh-spaces-control", "jobs", "job-upgrade-b.json"),
      join(home, ".dsh-spaces-control", "plans", "plan-upgrade-a.json"),
      join(home, ".dsh-spaces-control", "plans", "plan-upgrade-b.json"),
    ],
    "resume-upgrade-1",
  );
  assert.equal(jobStatus(home, "job-upgrade-a"), "recovery-required");
  assert.equal(jobStatus(home, "job-upgrade-b"), "recovery-required");

  const homeLegacy = tempHome();
  writeInterruptedPlan(homeLegacy, "plan-upgrade-old", { kind: "runtime.upgrade" });
  writeInterruptedJob(homeLegacy, {
    id: "job-upgrade-old",
    kind: "plan.execute",
    command: { kind: "plan.execute", planId: "plan-upgrade-old" },
    phase: "commit",
  });
  const legacy = await startSupervisor(homeLegacy);
  const legacyCookie = await bootstrap(legacy.origin, legacy.bootstrapUrl);
  await assertRecoveryResumeUnsupported(
    legacy.origin,
    legacyCookie,
    [
      join(homeLegacy, ".dsh-spaces-control", "jobs", "job-upgrade-old.json"),
      join(homeLegacy, ".dsh-spaces-control", "plans", "plan-upgrade-old.json"),
    ],
    "resume-upgrade-old",
  );
  assert.equal(jobStatus(homeLegacy, "job-upgrade-old"), "recovery-required");
});

test("recovery resume does not follow a junctioned plans directory", async () => {
  const home = tempHome();
  const snapA = "11111111-1111-1111-1111-111111111111";
  const outside = join(home, "outside-plans");
  mkdirSync(outside, { recursive: true });
  writeFileSync(
    join(outside, "plan-restore-a.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "plan-restore-a",
      public: { id: "plan-restore-a", kind: "snapshot.restore" },
      command: { kind: "snapshot.restore", snapshotId: snapA },
      fingerprint: "fp",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
      status: "running",
    })}\n`,
  );
  mkdirSync(join(home, ".dsh-spaces-control"), { recursive: true });
  symlinkSync(outside, join(home, ".dsh-spaces-control", "plans"), process.platform === "win32" ? "junction" : "dir");
  writeInterruptedJob(home, {
    id: "job-restore-a",
    kind: "plan.execute",
    command: { kind: "plan.execute", planId: "plan-restore-a" },
    phase: "restore",
  });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await assertRecoveryResumeUnsupported(
    handle.origin,
    cookie,
    [
      join(home, ".dsh-spaces-control", "jobs", "job-restore-a.json"),
      join(outside, "plan-restore-a.json"),
    ],
    "resume-symlink-1",
  );
  assert.equal(jobStatus(home, "job-restore-a"), "recovery-required");
  assert.equal(existsSync(join(outside, "plan-restore-a.json")), true);
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

test("official web seed omits --from-default-profile; shipped web clone args are refused; manager still clones from web", async () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/adapters/node/workbench-supervisor.ts"), "utf8");
  assert.match(source, /runBoundCli\(\["--profile", "web", "--dump-config"\]\)/);
  assert.doesNotMatch(
    source,
    /runBoundCli\(\[\s*"--profile",\s*"web",\s*"--from-default-profile",\s*"web"/,
  );
  assert.match(source, /"--from-default-profile",\s*"web"/);

  const home = tempHome();
  const calls: string[][] = [];
  const handle = await startSupervisor(home, {
    runCli: async (args) => {
      const argv = [...args];
      calls.push(argv);
      const profile = argv[argv.indexOf("--profile") + 1] ?? "web";
      if (profile === "web" && argv.includes("--from-default-profile")) {
        return {
          code: 1,
          stdout: "",
          stderr: "error: profile web is shipped and cannot be a custom profile target; omit --from-default-profile",
        };
      }
      if (argv.includes("--from-default-profile")) {
        writeProfile(home, profile, {
          dependencies: { "@dsh-spaces/plugin": "0.2.0" },
          dsh: { profile: { bundles: ["@dsh-spaces/plugin"] } },
        });
      } else if (profile === "web" && argv.includes("--dump-config")) {
        writeProfile(home, "web");
      }
      return { code: 0, stdout: dumpText(profile), stderr: "" };
    },
  });
  const state = await handle.runtime.state();
  assert.equal(state.recoveryRequired, false);
  assert.deepEqual(
    calls.find((args) => args[args.indexOf("--profile") + 1] === "web" && args.includes("--dump-config")),
    ["--profile", "web", "--dump-config"],
  );
  assert.equal(
    calls.some((args) => args[args.indexOf("--profile") + 1] === "web" && args.includes("--from-default-profile")),
    false,
  );
  assert.ok(state.managerId);
  assert.notEqual(state.managerId, "web");
  assert.deepEqual(
    calls.find((args) => args[args.indexOf("--profile") + 1] === state.managerId),
    ["--profile", state.managerId, "--from-default-profile", "web", "--dump-config"],
  );
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
