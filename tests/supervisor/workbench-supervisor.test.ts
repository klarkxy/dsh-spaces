import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { Script } from "node:vm";
import { basename, dirname, join } from "node:path";
import { archiveAbsPath } from "../../src/adapters/node/products/plugin-library.ts";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { satisfies } from "semver";
import { SPACES_MIN_DSH_VERSION } from "../../src/shared/runtime.ts";
import { HomeLease } from "../../src/adapters/node/home/home-lease.ts";
import { HOME_LOCK_DIR_NAME, HOME_LOCK_OWNER_FILE } from "../../src/adapters/node/home/home-operation-lock.ts";
import {
  createWorkbenchSupervisor,
  WorkbenchSupervisorRuntime,
  parseSupervisorArgs,
  supervisorCliArgs,
  type WorkbenchMaintenance,
  type WorkbenchSupervisorHandle,
} from "../../src/adapters/node/workbench-supervisor.ts";
import {
  cookieValue,
  expectedAuthCookieName,
  renderEntryPage,
  startWorkbenchHttp,
  WORKBENCH_HTTP_BODY_LIMIT,
  type WorkbenchHttpRuntime,
} from "../../src/adapters/node/server/workbench-http.ts";
import { WorkbenchMaintenance as WorkbenchMaintenanceService } from "../../src/adapters/node/maintenance/workbench-maintenance.ts";
import type { PatchWriter } from "../../src/adapters/node/profile/patch-writer.ts";
import type { ProcessRuntime } from "../../src/adapters/node/runtime/process-manager.ts";
import { writeComponentPayloadManifest, COMPONENT_PAYLOAD_PACKAGES, type ValidatedComponentPayload } from "../../src/adapters/node/payload/component-payload.ts";
import type { WorkbenchPlan, WorkbenchPlanRequest } from "../../src/shared/workbench.ts";

const temps: string[] = [];
const live: ChildProcess[] = [];
const handles: WorkbenchSupervisorHandle[] = [];

test("stable entry scripts parse before any DSH instance is available", () => {
  const html = renderEntryPage({ managerRunning: false, managerViewPath: null,
    maintenance: false, writable: true, reasons: [], serviceEpoch: "a".repeat(64) });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  for (const [, source] of scripts) assert.doesNotThrow(() => new Script(source));
});

function fakeHttpRuntime(originOf: () => string): WorkbenchHttpRuntime {
  return {
    cookieName: () => "dsh-auth-test",
    sessionCookie: () => "",
    sessionEquals: () => false,
    consumeBootstrapToken: () => false,
    hostBearerEquals: (value) => value === "test-bearer",
    supervisorOrigin: () => originOf(),
    managerOrigin: () => null,
    isWorkspaceOrigin: () => false,
    dispatch: async () => ({ ok: true }),
    entryPage: () => "<html></html>",
    viewEntry: async () => ({ status: 404, message: "missing" }),
    mintHandoff: () => "",
  };
}

test("sealed blueprint product reads and apply are unsupported without creating a job", async () => {
  const home = tempHome();
  const handle = await startSupervisor(home);
  for (const method of ["blueprint.source", "blueprint.generate", "blueprint.inspect", "blueprint.preview"]) {
    await assert.rejects(
      () => handle.runtime.product({ method } as never),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "workbench/unsupported", method);
        return true;
      },
    );
  }
  const before = await handle.runtime.state();
  await assert.rejects(
    () => handle.runtime.submit(
      { kind: "blueprint.apply", planId: "sealed-plan" },
      "req-blueprint-sealed",
      { serviceEpoch: before.serviceEpoch, expectedRevision: before.revision },
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "workbench/unsupported");
      return true;
    },
  );
  const after = await handle.runtime.state();
  assert.equal(after.jobs.some((job) => job.requestId === "req-blueprint-sealed"), false);
  assert.equal((await handle.runtime.product({ method: "settings" })).method, "settings");
});

test("sealed Browser creation aliases and catalog cannot create jobs or profiles", async () => {
  const home = tempHome();
  const handle = await startSupervisor(home);
  const before = await handle.runtime.state();
  const unsupported = (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'workbench/unsupported');
    return true;
  };
  await assert.rejects(() => handle.runtime.product({ method: 'base.versions', base: 'browser' }), unsupported);
  for (const input of [
    { name: 'browser', browser: true },
    { name: 'browser', base: 'browser' as const, baseVersion: '0.4.0' },
    { name: 'browser', base: 'web' as const, baseVersion: '0.2.1-rc.2', browser: true },
  ]) await assert.rejects(() => handle.runtime.submit({ kind: 'space.create', input }, 'req-browser-sealed',
    { serviceEpoch: before.serviceEpoch, expectedRevision: before.revision }), unsupported);
  const after = await handle.runtime.state();
  assert.equal(after.jobs.some(job => job.requestId === 'req-browser-sealed'), false);
  assert.equal(existsSync(join(home, 'profiles', 'space-browser')), false);
});

test("ordinary workbench methods keep the small body limit; product share.previewImport may exceed it", async () => {
  let origin = "http://127.0.0.1:9";
  const http = await startWorkbenchHttp(fakeHttpRuntime(() => origin), 0);
  origin = http.origin;
  const headers = { "content-type": "application/json", authorization: "Bearer test-bearer" };
  try {
    const overOrdinary = `{${"\"pad\":\""}${"A".repeat(WORKBENCH_HTTP_BODY_LIMIT)}"}\n`;
    const state = await fetch(`${http.origin}/api/workbench/state`, {
      method: "POST",
      headers,
      body: overOrdinary,
    });
    assert.equal(state.status, 413);

    const productOther = JSON.stringify({
      request: { method: "settings.read", pad: "A".repeat(WORKBENCH_HTTP_BODY_LIMIT) },
    });
    const other = await fetch(`${http.origin}/api/workbench/product`, {
      method: "POST",
      headers,
      body: productOther,
    });
    assert.equal(other.status, 413);

    const share = JSON.stringify({
      request: { method: "share.previewImport", archive: "A".repeat(WORKBENCH_HTTP_BODY_LIMIT) },
    });
    const preview = await fetch(`${http.origin}/api/workbench/product`, {
      method: "POST",
      headers,
      body: share,
    });
    assert.notEqual(preview.status, 413);
    const previewBody = (await preview.json()) as { ok?: boolean };
    assert.equal(previewBody.ok, true);
  } finally {
    await http.close();
  }
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

test("ROOT: failed manager installation blocks writes and a later launch keeps its evidence without replay", async () => {
  const home = tempHome();
  const artifact = join(home, "plugin.tgz");
  writeFileSync(artifact, "test archive");
  let fail = true;
  let installs = 0;
  let cliCalls = 0;
  const extra = {
    pluginArtifact: artifact,
    runCli: async (args: readonly string[]) => {
      cliCalls += 1;
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
      installs += 1;
      if (fail) throw new Error("install interrupted");
      writeProfile(home, profile, { dependencies: { "@dsh-spaces/plugin": "0.2.0" } });
    },
  };
  const first = await startSupervisor(home, extra);
  const state = await first.runtime.state();
  assert.equal(state.availability, "limited");
  assert.ok(state.managerId);
  await assert.rejects(() => first.runtime.submit({ kind: "space.start", spaceId: state.managerId! }, "retry-incomplete-manager", {
    serviceEpoch: state.serviceEpoch, expectedRevision: state.revision,
  }), /Manager initialization did not complete/);
  const marker = join(home, ".dsh-spaces-control", "manager-bootstrap.json");
  const evidence = readFileSync(marker, "utf8");
  const profilePath = join(home, "profiles", state.managerId!, "package.json");
  const profile = readFileSync(profilePath, "utf8");
  const before = { installs, cliCalls };
  await first.close();
  fail = false;
  const second = await startSupervisor(home, extra);
  const next = await second.runtime.state();
  assert.equal(next.availability, "limited");
  assert.ok(next.reasons.some(reason => reason.includes("installation was not replayed")));
  assert.deepEqual({ installs, cliCalls }, before);
  assert.equal(readFileSync(marker, "utf8"), evidence);
  assert.equal(readFileSync(profilePath, "utf8"), profile);
  await assert.rejects(() => second.runtime.submit({ kind: "space.create", input: { name: "unrelated" } }, "blocked-create", {
    serviceEpoch: next.serviceEpoch, expectedRevision: next.revision,
  }), /installation was not replayed/);
});

test("damaged manager bootstrap evidence is preserved before manager identity allocation", async () => {
  const home = tempHome();
  const control = join(home, ".dsh-spaces-control");
  mkdirSync(control, { recursive: true });
  const marker = join(control, "manager-bootstrap.json");
  writeFileSync(marker, "{interrupted");
  let calls = 0;
  const handle = await startSupervisor(home, {
    runCli: async () => { calls += 1; throw new Error("must not run"); },
    pluginAdd: async () => { calls += 1; throw new Error("must not install"); },
  });
  assert.equal(calls, 0);
  assert.equal(readFileSync(marker, "utf8"), "{interrupted");
  assert.equal(existsSync(join(control, "manager.json")), false);
  assert.ok((await handle.runtime.state()).reasons.some(reason => reason.includes("installation was not replayed")));
});

test("manager bootstrap admits no concurrent mutation before its failure is known", async () => {
  const home = tempHome();
  writeProfile(home, "space-healthy");
  const registryFile = join(home, "hub", "spaces.json");
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(registryFile, JSON.stringify({ version: 1, order: ["space-healthy"], meta: {
    "space-healthy": { displayName: "before", order: 0, createdAt: "2026-10-13T00:00:00.000Z", dshVersion: "0.2.0-rc.2" },
  } }));
  const before = readFileSync(registryFile);
  const artifact = join(home, "plugin.tgz");
  writeFileSync(artifact, "test archive");
  let entered!: () => void, release!: () => void;
  const installing = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const runtime = new WorkbenchSupervisorRuntime({
    home, bin: writeFakeCli(home), port: 0, pluginArtifact: artifact,
    patchWriter: fakePatchWriter(home),
    runCli: async args => {
      const id = args[args.indexOf("--profile") + 1]!;
      if (args.includes("--from-default-profile")) writeProfile(home, id);
      return { code: 0, stdout: dumpText(id), stderr: "" };
    },
    dumpConfig: async id => dumpText(id),
    pluginAdd: async () => { entered(); await held; throw new Error("concurrent bootstrap failure"); },
    createMaintenance: () => fakeMaintenance(),
  });
  runtime.attachHttp("http://127.0.0.1:45111", async () => {});
  const starting = runtime.tryOwn();
  try {
    await installing;
    const state = await runtime.state();
    for (const requestId of ["during-bootstrap-1", "during-bootstrap-2"]) {
      await assert.rejects(() => runtime.submit({ kind: "space.update", spaceId: "space-healthy", displayName: "changed" }, requestId, {
        serviceEpoch: state.serviceEpoch, expectedRevision: state.revision,
      }), /still initializing/);
    }
    release();
    await starting;
    const failed = await runtime.state();
    await assert.rejects(() => runtime.submit({ kind: "space.update", spaceId: "space-healthy", displayName: "changed" }, "after-bootstrap-failure", {
      serviceEpoch: failed.serviceEpoch, expectedRevision: failed.revision,
    }), /Manager initialization did not complete/);
    assert.deepEqual(readFileSync(registryFile), before);
  } finally {
    release();
    await starting;
    await runtime.close();
  }
});

test("HTTP state during owned manager bootstrap stays limited without latching blocked", async () => {
  const home = tempHome();
  const artifact = join(home, "plugin.tgz");
  writeFileSync(artifact, "test archive");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enteredAdd = false;
  const creating = createWorkbenchSupervisor({
    home,
    bin: writeFakeCli(home),
    port: 0,
    portStart: 34000,
    portEnd: 34999,
    patchWriter: fakePatchWriter(home),
    pluginArtifact: artifact,
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
        writeProfile(home, profile);
      } else if (profile === "web" && args.includes("--dump-config")) {
        writeProfile(home, "web");
      }
      return { code: 0, stdout: dumpText(profile), stderr: "" };
    },
    dumpConfig: async (profile) => dumpText(profile),
    createMaintenance: () => fakeMaintenance(),
    pluginAdd: async (_home, profile, spec) => {
      enteredAdd = true;
      await held;
      writeProfile(home, profile, {
        dependencies: { "@dsh-spaces/plugin": "0.2.0" },
        dsh: { profile: { bundles: ["@dsh-spaces/plugin"] } },
      });
      const match = /^(@?[a-z0-9-]+(?:\/[a-z0-9-]+)?)@([^@]+)$/.exec(spec);
      if (match) {
        const dir = join(home, "profiles", profile, "node_modules", ...match[1].split("/"));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: match[1], version: match[2] })}\n`);
      }
    },
  });
  creating.then(
    (handle) => {
      if (!handles.includes(handle)) handles.push(handle);
    },
    () => undefined,
  );
  try {
    await waitUntil(
      () => enteredAdd && existsSync(join(home, ".dsh-spaces-control", "endpoint.json")),
      "endpoint during owned bootstrap",
    );
    const endpoint = JSON.parse(readFileSync(join(home, ".dsh-spaces-control", "endpoint.json"), "utf8")) as {
      origin?: string;
      bearer?: string;
    };
    assert.equal(typeof endpoint.origin, "string");
    assert.equal(typeof endpoint.bearer, "string");
    const origin = new URL(endpoint.origin!).origin;
    const transient = await fetch(`${origin}/api/workbench/state`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        authorization: `Bearer ${endpoint.bearer}`,
      },
      body: "{}",
    });
    assert.equal(transient.status, 200);
    const body = (await transient.json()) as {
      ok?: boolean;
      value?: { availability?: string; reasons?: string[] };
    };
    assert.equal(body.ok, true);
    assert.equal(body.value?.availability, "limited");
    assert.ok((body.value?.reasons ?? []).length > 0);
  } finally {
    release();
  }
  const handle = await creating;
  if (!handles.includes(handle)) handles.push(handle);
  const ready = await handle.runtime.state();
  assert.equal(ready.availability, "ready", JSON.stringify(ready));
  assert.equal(ready.role, "manager");
  assert.equal(ready.spaces.find((space) => space.id === ready.managerId)?.status, "running");
  const again = await handle.runtime.state();
  assert.equal(again.availability, "ready");
  assert.equal(again.spaces.find((space) => space.id === again.managerId)?.status, "running");
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

function writeFakeCli(home: string, version = "0.2.0-rc.2"): string {
  const root = join(home, "cli");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version })}\n`);
  writeFileSync(join(root, "lib", "bin.js"), "console.log('fake-dsh');\n");
  for (const name of ["dsh-base", "dsh-web-app"]) {
    const dir = join(root, "node_modules", "@deepseek-ai", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `@deepseek-ai/${name}`, version })}\n`);
  }
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

/** A registered space: profile dir `profiles/space-<name>` plus a spaces.json meta entry. */
function writeSpace(
  home: string,
  name: string,
  pkg: unknown = {},
  meta: { dshVersion?: string; createdAt?: string } = {},
): string {
  const id = `space-${name}`;
  writeProfile(home, id, pkg);
  const spacesPath = join(home, "hub", "spaces.json");
  const spaces = existsSync(spacesPath)
    ? (JSON.parse(readFileSync(spacesPath, "utf8")) as {
        version: 1;
        order: string[];
        meta: Record<string, Record<string, unknown>>;
      })
    : { version: 1 as const, order: [] as string[], meta: {} as Record<string, Record<string, unknown>> };
  const entry: Record<string, unknown> = {
    displayName: name,
    order: spaces.order.length + 1000,
    createdAt: meta.createdAt ?? "2025-01-01T00:00:00.000Z",
  };
  if (meta.dshVersion !== undefined) entry.dshVersion = meta.dshVersion;
  spaces.meta[id] = entry;
  if (!spaces.order.includes(id)) spaces.order.push(id);
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(spacesPath, `${JSON.stringify(spaces, null, 2)}\n`);
  return id;
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
      serviceEpoch: "a".repeat(64),
      stateRevision: "b".repeat(64),
    }),
    execute: async () => ({ snapshotId: "snap-1" }),
    plugins: async () => [{ id: "p", title: "p", packageName: "p", description: "", version: "1.0.0", installedIn: [], protected: false }],
    snapshots: async () => [],
    snapshot: async () => {
      throw new Error("missing");
    },
    runtimes: async () => [],
    backups: async () => [],
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
    pluginAdd: async (addedHome, profile, spec) => {
      const official = spec.match(/^(@?[a-z0-9-]+(?:\/[a-z0-9-]+)?)@([^@]+)$/);
      if (!official) return;
      const dir = join(addedHome, "profiles", profile, "node_modules", ...official[1]!.split("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: official[1], version: official[2] })}\n`);
    },
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

async function mutationContext(
  origin: string,
  cookie: string,
): Promise<{ serviceEpoch: string; expectedRevision: string }> {
  const state = await api(origin, cookie, "state");
  const value = state.body.value as { serviceEpoch: string; revision: string };
  return { serviceEpoch: value.serviceEpoch, expectedRevision: value.revision };
}

async function mutate(
  origin: string,
  cookie: string,
  method: "submit" | "preview",
  payload: Record<string, unknown>,
): Promise<{ status: number; body: { ok?: boolean; value?: unknown; error?: { code: string; message: string } } }> {
  return api(origin, cookie, method, { ...payload, context: await mutationContext(origin, cookie) });
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
  writeSpace(home, "alpha", { dependencies: { "@deepseek-ai/dsh-web-app": "0.1.5-rc.1" } }, { dshVersion: "0.2.0-rc.2" });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const started = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-alpha" },
    requestId: "start-alpha",
  });
  assert.equal(started.body.ok, true, JSON.stringify(started.body));
  await waitJob(handle.origin, cookie, "start-alpha");

  const state = await api(handle.origin, cookie, "state");
  const spaces = (state.body.value as { spaces: Array<{ id: string; generation: number }> }).spaces;
  const alpha = spaces.find((row) => row.id === "space-alpha");
  assert.ok(alpha);
  const view = await api(handle.origin, cookie, "view", { spaceId: "space-alpha" });
  assert.equal(view.body.ok, true);
  const issued = view.body.value as { origin: string; entryOrigin: string; entryPath: string };
  assert.equal(issued.entryOrigin, handle.origin);
  assert.notEqual(issued.origin, issued.entryOrigin);
  assert.match(issued.entryPath, /^\/view\/space-alpha\/\d+$/);
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
  const value = state.body.value as { availability: string; reasons: string[]; managerId: string };
  assert.equal(value.managerId, "spaces-hub");
  assert.equal(value.availability, "limited");
  assert.match(value.reasons.join(" "), /ordinary profile/i);
  assert.equal(readFileSync(join(home, "profiles", "spaces-hub", "package.json"), "utf8"), before);
});

test("maintenance polling preserves inventory during a Home swap and reads live job progress", async () => {
  const home = tempHome();
  writeSpace(home, "alpha");
  let release!: () => void;
  const paused = new Promise<void>(resolvePause => { release = resolvePause; });
  const handle = await startSupervisor(home, {
    createMaintenance: ports => ({
      ...fakeMaintenance(),
      execute: async (_plan, ctx) => {
        ports.setMaintenance(true);
        const original = join(home, "profiles", "space-alpha");
        const staged = join(home, "space-alpha-held-by-restore");
        renameSync(original, staged);
        try {
          writeSpace(home, "beta");
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
  const observed = await handle.runtime.state();
  const context = { serviceEpoch: observed.serviceEpoch, expectedRevision: observed.revision };
  await handle.runtime.preview({ kind: "snapshot.create" }, context);
  await handle.runtime.submit({ kind: "plan.execute", planId: "maint-plan" }, "inventory-swap", context);
  try {
    await waitUntil(async () => (await handle.runtime.job("inventory-swap")).phase === "stage", "maintenance stage");
    const response = await api(handle.origin, cookie, "state");
    assert.equal(response.body.ok, true);
    const state = response.body.value as Awaited<ReturnType<typeof handle.runtime.state>>;
    assert.equal(state.maintenance, true);
    assert.notEqual(state.availability, "unavailable");
    assert.ok(state.spaces.some(row => row.id === "space-alpha"));
    assert.equal(state.spaces.some(row => row.id === "space-beta"), false);
    assert.equal(state.jobs.find(job => job.id === "inventory-swap")?.phase, "stage");
    const entry = await fetch(handle.origin, { headers: { cookie } });
    assert.equal(entry.status, 200);
    await entry.body?.cancel();
  } finally { release(); }
  await waitJob(handle.origin, cookie, "inventory-swap");
  const refreshed = await handle.runtime.state();
  assert.equal(refreshed.maintenance, false);
  assert.ok(refreshed.spaces.some(row => row.id === "space-beta"));
});

test("jobs.submit is idempotent and maintenance preview is delegated", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", { name: "space-alpha" });
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
  const first = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "space-alpha", displayName: "Alpha" },
    requestId: "upd-1",
  });
  const second = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "space-alpha", displayName: "Alpha" },
    requestId: "upd-1",
  });
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal(second.body.ok, true);
  assert.equal((first.body.value as { id: string }).id, (second.body.value as { id: string }).id);
  await waitJob(handle.origin, cookie, "upd-1");

  const preview = await mutate(handle.origin, cookie, "preview", {
    request: { kind: "snapshot.create" },
  });
  assert.equal(preview.body.ok, true);
  assert.deepEqual(delegated, ["snapshot.create"]);
});

test("web stop does not force-kill and keeps the instance record", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", { name: "space-alpha" }, { dshVersion: "0.2.0-rc.2" });
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
  const started = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-alpha" },
    requestId: "start-live-stop",
  });
  assert.equal(started.body.ok, true, JSON.stringify(started.body));
  await waitJob(handle.origin, cookie, "start-live-stop");

  const preview = await mutate(handle.origin, cookie, "preview", {
    request: { kind: "space.stop", spaceId: "space-alpha" },
  });
  assert.equal(preview.body.ok, true);
  const plan = preview.body.value as WorkbenchPlan;
  const stop = await mutate(handle.origin, cookie, "submit", {
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
  const alpha = (state.body.value as { spaces: Array<{ id: string; status: string }> }).spaces.find((row) => row.id === "space-alpha");
  assert.ok(alpha);
  assert.notEqual(alpha.status, "stopped");
});

test("stable entry still responds after the manager process is gone", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", { name: "space-alpha" }, { dshVersion: "0.2.0-rc.2" });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const started = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-alpha" },
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
  const holder = new HomeLease(home).acquire("web");
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const page = await fetch(`${handle.origin}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  await page.text();
  const state = await api(handle.origin, cookie, "state");
  assert.equal((state.body.value as { writable: boolean }).writable, false);
  const submit = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "alpha", displayName: "nope" },
    requestId: "busy-1",
  });
  assert.equal(submit.body.ok, false);
  assert.equal(submit.body.error?.code, "workbench/read-only");
  assert.equal(existsSync(join(home, ".dsh-spaces-control", "jobs")), false);
  const acquire = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "controller.acquire" },
    requestId: "acq-1",
  });
  assert.equal(acquire.body.ok, false);
  assert.equal(acquire.body.error?.code, "workbench/unsupported");
  holder.release();
});

test("controller.release and controller.acquire are unsupported; desktop holder keeps web read-only", async () => {
  const home = tempHome();
  writeProfile(home, "alpha", { name: "alpha" });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const preview = await mutate(handle.origin, cookie, "preview", { request: { kind: "controller.release" } });
  assert.equal(preview.body.ok, false);
  assert.equal(preview.body.error?.code, "workbench/unsupported");
  const steal = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "controller.acquire" },
    requestId: "web-steal",
  });
  assert.equal(steal.body.ok, false);
  assert.equal(steal.body.error?.code, "workbench/unsupported");
});

test("shutdown persists the job then releases rights without deadlocking on whenIdle", async () => {
  const home = tempHome();
  let normalExit = false;
  const handle = await startSupervisor(home, { onNormalExit: () => {
    const record = JSON.parse(readFileSync(join(home, ".dsh-spaces-control", "jobs", "bye-1.json"), "utf8"));
    assert.equal(record.status, "succeeded");
    assert.equal(existsSync(join(home, ".dsh-spaces-control", "run", "owner.json")), false);
    normalExit = true;
  } });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const preview = await mutate(handle.origin, cookie, "preview", { request: { kind: "service.shutdown" } });
  assert.equal(preview.body.ok, true);
  const planId = (preview.body.value as { id: string }).id;
  const submitted = await mutate(handle.origin, cookie, "submit", {
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
  await waitUntil(() => normalExit, "normal exit is reported after durable shutdown");
  const record = JSON.parse(readFileSync(jobFile, "utf8")) as { status: string; kind: string };
  assert.equal(record.status, "succeeded");
  assert.equal(record.kind, "plan.execute");
  let shutdownWrite: { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
  try {
    shutdownWrite = (await mutate(handle.origin, cookie, "submit", {
      command: { kind: "space.update", spaceId: "alpha", displayName: "after" },
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

test("exact CLI versions are admitted; tags stay unbound; CLI flags stay Node-only paths", async () => {
  const rc2Home = tempHome();
  const rc2 = writeFakeCli(rc2Home, "0.1.5-rc.2");
  const admitted = await startSupervisor(rc2Home, { bin: rc2 });
  const cookie = await bootstrap(admitted.origin, admitted.bootstrapUrl);
  const state = await api(admitted.origin, cookie, "state");
  const value = state.body.value as { dshVersion: string | null; reasons: string[] };
  assert.equal(value.dshVersion, "0.1.5-rc.2");
  assert.doesNotMatch(value.reasons.join(" "), /not a supported version|not the supported|exact installed version/i);

  const laterHome = tempHome();
  const laterBin = writeFakeCli(laterHome, "0.1.5-rc.3");
  const later = await startSupervisor(laterHome, { bin: laterBin });
  const laterCookie = await bootstrap(later.origin, later.bootstrapUrl);
  const laterState = await api(later.origin, laterCookie, "state");
  const laterValue = laterState.body.value as { dshVersion: string | null; reasons: string[] };
  assert.equal(laterValue.dshVersion, "0.1.5-rc.3");

  const unknownHome = tempHome();
  const unknownBin = writeFakeCli(unknownHome, "latest");
  const blocked = await startSupervisor(unknownHome, { bin: unknownBin });
  const blockedCookie = await bootstrap(blocked.origin, blocked.bootstrapUrl);
  const blockedState = await api(blocked.origin, blockedCookie, "state");
  const blockedValue = blockedState.body.value as { dshVersion: string | null; reasons: string[] };
  assert.equal(blockedValue.dshVersion, null);
  assert.match(blockedValue.reasons.join(" "), /could not be bound|exact installed version/i);

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

test("CLI parses and serializes --dev-checkout", () => {
  const checkout = mkdtempSync(join(tmpdir(), "dsh-devcli-"));
  temps.push(checkout);
  const parsed = parseSupervisorArgs(["--home", checkout, "--bin", join(checkout, "bin.js"), "--dev-checkout", checkout]);
  assert.equal(parsed.devCheckoutRoot, checkout);
  assert.deepEqual(supervisorCliArgs(parsed).slice(-2), ["--dev-checkout", checkout]);
  assert.equal(parseSupervisorArgs(["--home", checkout, "--bin", join(checkout, "bin.js")]).devCheckoutRoot, undefined);
});

test("CLI parses and serializes --exit-with-host", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-exithost-"));
  temps.push(home);
  const bin = join(home, "bin.js");
  const parsed = parseSupervisorArgs(["--home", home, "--bin", bin, "--exit-with-host"]);
  assert.equal(parsed.exitWithHost, true);
  assert.deepEqual(supervisorCliArgs(parsed).slice(-1), ["--exit-with-host"]);
  assert.equal(parseSupervisorArgs(["--home", home, "--bin", bin]).exitWithHost, undefined);
  assert.throws(() => parseSupervisorArgs(["--home", home, "--bin", bin, "--exit-with-host", "1"]), /Unknown flag/);
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
  ) as { version: number; protocolVersion: number; homeId: string; serviceEpoch: string; origin: string; bearer: string };
  assert.equal(endpoint.version, 2);
  assert.equal(endpoint.protocolVersion, 2);
  assert.match(endpoint.homeId, /^[a-f0-9]{64}$/);
  assert.match(endpoint.serviceEpoch, /^[a-f0-9]{64}$/);
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
  assert.match(html, /查看错误详情|复制脱敏日志/);
  assert.doesNotMatch(html, /接管运行权/);
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
    }),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const leftoverBefore = readFileSync(join(home, ".dsh-spaces-control", "jobs", "old-space.json"));
  const resume = await mutate(handle.origin, cookie, "submit", {
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
  const resume = await mutate(origin, cookie, "submit", {
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

test("a dead transaction lock stays in place and recovery.resume is unsupported", async () => {
  for (const pid of [2147483647, process.pid]) {
    const home = tempHome();
    await new HomeLease(home).ensureManager();
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

test("recovery.resume is unsupported and both interrupted package jobs stay unchanged", async () => {
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

test("damaged registry reports failure and blocks mutations without replacing its bytes", async () => {
  for (const damaged of ["{", JSON.stringify({ version: 1, meta: [] })]) {
    const home = tempHome();
    const handle = await startSupervisor(home);
    const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
    const context = await handle.runtime.state();
    const registryPath = join(home, "hub", "spaces.json");
    writeFileSync(registryPath, damaged);

    const observed = await api(handle.origin, cookie, "state", {});
    assert.equal(observed.body.ok, false);
    assert.equal(observed.body.error?.code, "workbench/unavailable");
    assert.match(observed.body.error?.message ?? "", /Space registry could not be read/);
    const changed = await api(handle.origin, cookie, "submit", {
      command: { kind: "space.create", input: { name: "unaccepted" } },
      requestId: `damaged-${damaged.length}`,
      context: { serviceEpoch: context.serviceEpoch, expectedRevision: context.revision },
    });
    assert.equal(changed.body.ok, false);
    assert.equal(changed.body.error?.code, "workbench/unavailable");
    assert.equal(readFileSync(registryPath, "utf8"), damaged);
    assert.equal(existsSync(join(home, "profiles", "space-unaccepted")), false);

    // Close normally for test cleanup after checking that no mutation was admitted.
    writeFileSync(registryPath, JSON.stringify({ version: 1, order: [], meta: {} }));
    await assert.rejects(handle.runtime.submit(
      { kind: "space.create", input: { name: "unaccepted" } }, "after-observation",
      { serviceEpoch: context.serviceEpoch, expectedRevision: context.revision },
    ), /Space registry could not be read/);
  }
});

test("registry corruption is rejected before mutation even without a preceding state read", async () => {
  const home = tempHome();
  const handle = await startSupervisor(home);
  const context = await handle.runtime.state();
  const registryPath = join(home, "hub", "spaces.json");
  writeFileSync(registryPath, "{");
  await assert.rejects(handle.runtime.submit(
    { kind: "space.create", input: { name: "unaccepted" } }, "first-read-is-submit",
    { serviceEpoch: context.serviceEpoch, expectedRevision: context.revision },
  ), /Space registry could not be read/);
  assert.equal(readFileSync(registryPath, "utf8"), "{");
  writeFileSync(registryPath, JSON.stringify({ version: 1, order: [], meta: {} }));
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

test("shutdown with unconfirmed final persistence keeps ownership and never announces normal exit", async () => {
  const home = tempHome();
  let normalExit = false;
  const jobFile = join(home, ".dsh-spaces-control", "jobs", "unconfirmed-stop.json");
  const handle = await startSupervisor(home, {
    onNormalExit: () => { normalExit = true; },
    jobsInject: (op, id) => {
      if (op !== "write" || id !== "unconfirmed-stop" || !existsSync(jobFile)) return;
      const record = JSON.parse(readFileSync(jobFile, "utf8"));
      if (record.phase === "finalizing" && record.status === "running") throw new Error("injected final persistence failure");
    },
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const preview = await mutate(handle.origin, cookie, "preview", { request: { kind: "service.shutdown" } });
  const submitted = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "plan.execute", planId: (preview.body.value as { id: string }).id },
    requestId: "unconfirmed-stop",
  });
  assert.equal(submitted.body.ok, true);
  await waitUntil(async () => (await handle.runtime.state()).reasons.some(row => row.includes("Shutdown completion could not be saved")), "unconfirmed shutdown remains visible");
  assert.equal(normalExit, false);
  assert.equal(new HomeLease(home).inspect().held, true);
  const record = JSON.parse(readFileSync(jobFile, "utf8"));
  assert.equal(record.status, "running");
  assert.equal(record.phase, "finalizing");
  const state = await handle.runtime.state();
  assert.match(state.reasons.join(" "), /Owned processes stopped/);
  assert.doesNotMatch(state.reasons.join(" "), /could not be stopped/);
  const observedJob = await handle.runtime.job("unconfirmed-stop");
  assert.match(observedJob.error?.message ?? "", /operation ran.*result could not be saved/i);
  assert.doesNotMatch(observedJob.error?.message ?? "", /operation was not accepted/i);
});

test("first startup clones the shipped preset into the manager without materializing web", async () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/adapters/node/workbench-supervisor.ts"), "utf8");
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
  assert.notEqual(state.availability, "unavailable");
  assert.deepEqual(
    calls.find((args) => args[args.indexOf("--profile") + 1] === "web" && args.includes("--dump-config")),
    undefined,
  );
  assert.equal(existsSync(join(home, "profiles", "web")), false);
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

test("manager bootstrap reads the manager dump-config once and reuses it for the loader sync", async () => {
  const home = tempHome();
  let dumpReads = 0;
  const handle = await startSupervisor(home, {
    dumpConfig: async (profile) => {
      dumpReads += 1;
      return dumpText(profile);
    },
  });
  const state = await handle.runtime.state();
  assert.ok(state.managerId);
  assert.equal(dumpReads, 1);
});

test("a later launch without bootstrap still reads dump-config fresh for the loader", async () => {
  const home = tempHome();
  let dumpReads = 0;
  const countingDump = async (profile: string) => {
    dumpReads += 1;
    return dumpText(profile);
  };
  const first = await startSupervisor(home, { dumpConfig: countingDump });
  await first.close();
  dumpReads = 0;
  const second = await startSupervisor(home, { dumpConfig: countingDump });
  const state = await second.runtime.state();
  assert.ok(state.managerId);
  assert.equal(dumpReads, 1);
});

test("ROOT: initialization starts the real manager lifecycle before normal entry", async () => {
  const handle = await startSupervisor(tempHome());
  const state = await handle.runtime.state();
  assert.ok(state.managerId);
  assert.equal(state.spaces.find(space => space.id === state.managerId)?.status, "running");
});

test("ROOT: failed child shutdown preserves exclusive run rights", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", { name: "space-alpha" }, { dshVersion: "0.2.0-rc.2" });
  const handle = await startSupervisor(home, { processRuntime: {
    spawn: spawnFixture("ok"),
    prepareHome: async () => undefined,
    kill: async () => undefined,
    gracefulWaitMs: 30, forceWaitMs: 10,
    readyTimeoutMs: 8000, pollMs: 20,
  } });
  const startedState = await handle.runtime.state();
  await handle.runtime.submit(
    { kind: "space.start", spaceId: "space-alpha" },
    "root-start",
    { serviceEpoch: startedState.serviceEpoch, expectedRevision: startedState.revision },
  );
  await waitUntil(async () => (await handle.runtime.job("root-start")).status === "succeeded", "root start");
  await assert.rejects(() => handle.close());
  assert.equal(new HomeLease(home).inspect().held, true);
});

test("submit without context is rejected and old epoch cannot mutate", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", { name: "space-alpha" });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const missing = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "space-alpha", displayName: "no-context" },
    requestId: "no-ctx",
  });
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.error?.code, "workbench/invalid-input");
  const stale = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "space-alpha", displayName: "stale" },
    requestId: "stale-epoch",
    context: { serviceEpoch: "c".repeat(64), expectedRevision: "d".repeat(64) },
  });
  assert.equal(stale.body.ok, true, JSON.stringify(stale.body));
  await waitUntil(async () => {
    const job = await handle.runtime.job("stale-epoch");
    return job.status === "failed";
  }, "stale epoch job failed");
  const failed = await handle.runtime.job("stale-epoch");
  assert.equal(failed.error?.code, "workbench/conflict");
});

test("two clients with the same revision: only one mutating job succeeds", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", { name: "space-alpha" });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const context = await mutationContext(handle.origin, cookie);
  const first = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "space-alpha", displayName: "One" },
    requestId: "cas-a",
    context,
  });
  const second = await api(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "space-alpha", displayName: "Two" },
    requestId: "cas-b",
    context,
  });
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal(second.body.ok, true, JSON.stringify(second.body));
  await waitJob(handle.origin, cookie, "cas-a");
  await waitUntil(async () => {
    const job = await handle.runtime.job("cas-b");
    return job.status === "failed" || job.status === "succeeded";
  }, "second cas job settled");
  const a = await handle.runtime.job("cas-a");
  const b = await handle.runtime.job("cas-b");
  const winners = [a, b].filter((job) => job.status === "succeeded");
  const losers = [a, b].filter((job) => job.status === "failed");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0]?.error?.code, "workbench/conflict");
});

test("same request id with a different command is rejected even after revision moves", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", { name: "space-alpha" });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const first = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.update", spaceId: "space-alpha", displayName: "Alpha" },
    requestId: "same-id",
  });
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  await waitJob(handle.origin, cookie, "same-id");
  const conflict = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-alpha" },
    requestId: "same-id",
  });
  assert.equal(conflict.body.ok, false);
  assert.equal(conflict.body.error?.code, "workbench/conflict");
});

test("official desktop stays outside management and rejects start, update, delete and plugin changes", async () => {
  const home = tempHome();
  writeProfile(home, "desktop", { name: "official-desktop" });
  const path = join(home, "profiles", "desktop", "package.json");
  const before = readFileSync(path, "utf8");
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  assert.equal((await handle.runtime.state()).spaces.some(space => space.id === "desktop"), false);
  for (const command of [
    { kind: "space.start", spaceId: "desktop" },
    { kind: "space.update", spaceId: "desktop", displayName: "Renamed" },
  ] as const) {
    const requestId = `reserved-${command.kind}`;
    const result = await mutate(handle.origin, cookie, "submit", { command, requestId });
    if (result.body.ok) await waitJob(handle.origin, cookie, requestId, "failed");
    else assert.ok(result.body.error?.code);
  }
  for (const request of [
    { kind: "space.delete", spaceId: "desktop", removeData: true },
    { kind: "plugin.install", spaceIds: ["desktop"], catalogId: "p", version: "1.0.0" },
    { kind: "plugin.remove", spaceId: "desktop", packageName: "p" },
    { kind: "plugin.toggle", spaceId: "desktop", pluginId: "p", enabled: false },
  ]) {
    const result = await mutate(handle.origin, cookie, "preview", { request });
    assert.equal(result.body.ok, false, JSON.stringify(result.body));
  }
  assert.equal(readFileSync(path, "utf8"), before);
});

const appBootPath = createRequire(import.meta.url).resolve("@deepseek-ai/dsh-app-boot");

function writeFakeCliWithWebApp(home: string, version = "0.2.0-rc.2"): string {
  const root = join(home, "cli-webapp");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version })}\n`);
  writeFileSync(join(root, "lib", "bin.js"), "console.log('fake-dsh');\n");
  const web = join(root, "node_modules", "@deepseek-ai", "dsh-web-app");
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh-web-app", version, dsh: { bundle: { patch: "./cordis.patch.yml" } } })}\n`);
  writeFileSync(join(web, "cordis.patch.yml"), "- insert:\n    - id: settings\n      name: '@deepseek-ai/dsh-web-app'\n");
  const base = join(root, "node_modules", "@deepseek-ai", "dsh-base");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh-base", version, dsh: { bundle: { patch: "./cordis.patch.yml" } } })}\n`);
  writeFileSync(join(base, "cordis.patch.yml"), "- insert:\n    - id: dsh-base\n      name: '@deepseek-ai/dsh-base'\n");
  const bootFacade = join(root, "node_modules", "@deepseek-ai", "dsh-app-boot");
  mkdirSync(bootFacade, { recursive: true });
  writeFileSync(join(bootFacade, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", type: "module", main: "index.js" })}\n`);
  writeFileSync(join(bootFacade, "index.js"), `export * from ${JSON.stringify(pathToFileURL(appBootPath).href)};\n`);
  return join(root, "lib", "bin.js");
}

function installManagerModules(home: string, payload: ValidatedComponentPayload, pluginRoot: string): void {
  cpSync(pluginRoot, join(home, "profiles", "spaces-hub", "node_modules", "@dsh-spaces", "plugin"), { recursive: true });
  cpSync(join(payload.payloadRootLib, "view-bridge"), join(home, "profiles", "spaces-hub", "node_modules", "@dsh-spaces", "view-bridge"), { recursive: true });
}

function alphaDump(profile: string): string {
  return `${dumpText(profile)}- id: settings\n  disabled: true\n- id: dsh-spaces-settings\n  name: '@dsh-spaces/view-bridge/settings'\n`;
}

function writeManagerRecord(home: string, profileId = "spaces-hub"): void {
  mkdirSync(join(home, ".dsh-spaces-control"), { recursive: true });
  writeFileSync(
    join(home, ".dsh-spaces-control", "manager.json"),
    `${JSON.stringify({ version: 1, profileId, createdAt: new Date().toISOString() })}
`,
  );
}

function writePayload(pluginRoot: string, marker = "payload"): ValidatedComponentPayload {
  const pkg = (name: string, bundle = false) => `${JSON.stringify(bundle
    ? { name, version: "0.2.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }
    : { name, version: "0.2.0" })}\n`;
  const files: Array<[string, string]> = [
    ["package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["manager-plugin"], true)],
    ["cordis.patch.yml", `- insert:\n    - id: dsh-spaces\n      name: '${COMPONENT_PAYLOAD_PACKAGES["manager-plugin"]}'\n      config: {}\n`],
    ["lib/index.js", `export const marker = ${JSON.stringify(marker)};\n`],
    ["lib/typert.host.js", "export {};\n"],
    ["lib/typert.remote-client.js", "export {};\n"],
    ["lib/client.js", "export {};\n"],
    ["lib/supervisor/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES.supervisor)],
    ["lib/supervisor/index.js", "export {};\n"],
    ["lib/supervisor/snapshot-worker.mjs", "export {};\n"],
    ["lib/view-bridge/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["view-bridge"], true)],
    ["lib/view-bridge/cordis.patch.yml", `- insert:\n    - id: dsh-spaces-view-bridge\n      name: '${COMPONENT_PAYLOAD_PACKAGES["view-bridge"]}'\n      config: {}\n- id: settings\n  disabled: true\n- insert:\n    - id: dsh-spaces-settings\n      name: '${COMPONENT_PAYLOAD_PACKAGES["view-bridge"]}/settings'\n`],
    ["lib/view-bridge/lib/index.js", "export {};\n"],
    ["lib/view-bridge/lib/client.js", "export {};\n"],
    ["lib/view-bridge/lib/settings.js", "export {};\n"],
    ["lib/view-bridge/lib/typert.host.js", "export {};\n"],
    ["lib/browser/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES.browser)],
    ["lib/browser/cordis.patch.yml", "browser: dummy\n"],
    ["lib/browser/lib/index.js", "export {};\n"],
    ["lib/browser/lib/client.js", "export {};\n"],
    ["lib/browser/lib/typert.host.js", "export {};\n"],
    ["lib/llm-bridge/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["llm-bridge"], true)],
    ["lib/llm-bridge/cordis.patch.yml", `- insert:\n    - id: dsh-spaces-llm-bridge\n      name: '${COMPONENT_PAYLOAD_PACKAGES["llm-bridge"]}'\n      config: {}\n`],
    ["lib/llm-bridge/lib/index.js", "export {};\n"],
    ["lib/llm-bridge/lib/auxiliary.js", "export {};\n"],
    ["lib/space-control.js", "export {};\n"],
    ["lib/supervisor/ui-engine/node_modules/playwright-core/package.json", `${JSON.stringify({ name: "playwright-core", version: "1.62.1" })}\n`],
    ["lib/supervisor/ui-engine/node_modules/playwright-core/index.mjs", "export {};\n"],
    ["lib/supervisor/ui-engine/node_modules/playwright-core/index.js", "module.exports = {};\n"],
  ];
  for (const [rel, content] of files) {
    const abs = join(pluginRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return writeComponentPayloadManifest(join(pluginRoot, "lib"));
}

function packNpmTar(sourceDir: string, destTgz: string): string {
  const staging = mkdtempSync(join(tmpdir(), "dsh-align-tar-"));
  cpSync(sourceDir, join(staging, "package"), { recursive: true });
  const tar = process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
  const packed = spawnSync(tar, ["-czf", destTgz, "-C", staging, "package"], { encoding: "utf8" });
  if (packed.status !== 0) {
    throw new Error(packed.stderr || packed.stdout || "tar pack failed");
  }
  return destTgz;
}

function packPayloadArtifacts(
  payload: ValidatedComponentPayload,
  destDir: string,
): { pluginArtifact: string; viewBridgeArtifact: string; browserArtifact: string; llmBridgeArtifact: string } {
  mkdirSync(destDir, { recursive: true });
  return {
    pluginArtifact: packNpmTar(payload.packageRoot, join(destDir, "plugin.tgz")),
    viewBridgeArtifact: packNpmTar(join(payload.packageRoot, "lib", "view-bridge"), join(destDir, "view.tgz")),
    browserArtifact: packNpmTar(join(payload.packageRoot, "lib", "browser"), join(destDir, "browser.tgz")),
    llmBridgeArtifact: packNpmTar(join(payload.packageRoot, "lib", "llm-bridge"), join(destDir, "llm.tgz")),
  };
}

function alignProcessRuntime(spawned: string[]): Partial<ProcessRuntime> {
  return {
    spawn: (args, options = {}) => {
      spawned.push(args[args.indexOf("--profile") + 1] ?? "");
      return spawnFixture("ok")(args, options);
    },
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
  };
}

test("startup aligns a mismatched manager plugin once before the manager starts", async () => {
  const home = tempHome();
  writeProfile(home, "spaces-hub", {
    dependencies: { "@dsh-spaces/plugin": "0.2.0" },
    dsh: { profile: { bundles: ["@dsh-spaces/plugin", "@dsh-spaces/view-bridge"] } },
  });
  writeManagerRecord(home);
  const payload = writePayload(mkdtempSync(join(tmpdir(), "dsh-align-payload-")), "aligned");
  const stale = writePayload(mkdtempSync(join(tmpdir(), "dsh-align-stale-")), "stale");
  installManagerModules(home, payload, stale.packageRoot);
  const artifacts = packPayloadArtifacts(payload, join(home, "artifacts"));
  let installs = 0;
  const spawned: string[] = [];
  const specs: string[] = [];
  const handle = await startSupervisor(home, {
    bin: writeFakeCliWithWebApp(home),
    componentPayloadRoot: payload.payloadRootLib,
    ...artifacts,
    dumpConfig: async (profile) => profile === "spaces-hub" ? alphaDump(profile) : dumpText(profile),
    processRuntime: alignProcessRuntime(spawned),
    pluginAdd: async (addedHome, profile, spec) => {
      specs.push(basename(spec));
      if (!spec.includes("dsh-spaces-plugin")) return;
      installs += 1;
      cpSync(payload.packageRoot, join(addedHome, "profiles", profile, "node_modules", "@dsh-spaces", "plugin"), { recursive: true });
    },
  });
  const state = await handle.runtime.state();
  const artifactDigest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 20);
  assert.deepEqual(specs.sort(), [
    `dsh-spaces-plugin-${artifactDigest(artifacts.pluginArtifact)}.tgz`,
  ].sort());
  assert.equal(state.role, "manager");
  assert.equal(installs, 1);
  assert.equal(state.spaces.find((space) => space.id === state.managerId)?.status, "running", state.reasons.join(" | "));
  assert.ok(state.managerId && spawned.includes(state.managerId));
});

test("startup skips the manager plugin align when the installed payload matches", async () => {
  const home = tempHome();
  writeProfile(home, "spaces-hub", {
    dependencies: { "@dsh-spaces/plugin": "0.2.0" },
    dsh: { profile: { bundles: ["@dsh-spaces/plugin", "@dsh-spaces/view-bridge"] } },
  });
  writeManagerRecord(home);
  const payload = writePayload(mkdtempSync(join(tmpdir(), "dsh-align-same-")), "same");
  installManagerModules(home, payload, payload.packageRoot);
  const artifacts = packPayloadArtifacts(payload, join(home, "artifacts"));
  let installs = 0;
  const handle = await startSupervisor(home, {
    bin: writeFakeCliWithWebApp(home),
    componentPayloadRoot: payload.payloadRootLib,
    ...artifacts,
    dumpConfig: async (profile) => profile === "spaces-hub" ? alphaDump(profile) : dumpText(profile),
    pluginAdd: async (_addedHome, _profile, spec) => {
      if (spec.includes("dsh-spaces-plugin")) installs += 1;
    },
  });
  const state = await handle.runtime.state();
  assert.equal(installs, 0);
  assert.equal(state.spaces.find((space) => space.id === state.managerId)?.status, "running", state.reasons.join(" | "));
});

test("a matching manager plugin does not block alignment of a drifted manager view bridge", async () => {
  const home = tempHome();
  writeProfile(home, "spaces-hub", {
    dependencies: { "@dsh-spaces/plugin": "0.2.0" },
    dsh: { profile: { bundles: ["@dsh-spaces/plugin", "@dsh-spaces/view-bridge"] } },
  });
  writeManagerRecord(home);
  const payload = writePayload(mkdtempSync(join(tmpdir(), "dsh-align-drift-")), "drift");
  installManagerModules(home, payload, payload.packageRoot);
  writeFileSync(join(home, "profiles", "spaces-hub", "node_modules", "@dsh-spaces", "view-bridge", "lib", "index.js"), "drifted;\n");
  const artifacts = packPayloadArtifacts(payload, join(home, "artifacts"));
  const specs: string[] = [];
  const handle = await startSupervisor(home, {
    bin: writeFakeCliWithWebApp(home),
    componentPayloadRoot: payload.payloadRootLib,
    ...artifacts,
    dumpConfig: async (profile) => profile === "spaces-hub" ? alphaDump(profile) : dumpText(profile),
    pluginAdd: async (addedHome, profile, spec) => {
      specs.push(basename(spec));
      if (spec.includes("dsh-spaces-view-bridge")) {
        cpSync(join(payload.payloadRootLib, "view-bridge"), join(addedHome, "profiles", profile, "node_modules", "@dsh-spaces", "view-bridge"), { recursive: true });
      }
    },
  });
  const state = await handle.runtime.state();
  const artifactDigest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 20);
  assert.deepEqual(specs, [`dsh-spaces-view-bridge-${artifactDigest(artifacts.viewBridgeArtifact)}.tgz`]);
  assert.equal(state.spaces.find((space) => space.id === state.managerId)?.status, "running", state.reasons.join(" | "));
});

test("startup blocks and does not start the manager when the align cannot be verified", async () => {
  const home = tempHome();
  writeProfile(home, "spaces-hub", {
    dependencies: { "@dsh-spaces/plugin": "0.2.0" },
    dsh: { profile: { bundles: ["@dsh-spaces/plugin", "@dsh-spaces/view-bridge"] } },
  });
  writeManagerRecord(home);
  const payload = writePayload(mkdtempSync(join(tmpdir(), "dsh-align-fail-")), "failing");
  const stale = writePayload(mkdtempSync(join(tmpdir(), "dsh-align-fail-stale-")), "stale");
  installManagerModules(home, payload, stale.packageRoot);
  const artifacts = packPayloadArtifacts(payload, join(home, "artifacts"));
  let installs = 0;
  const spawned: string[] = [];
  const handle = await startSupervisor(home, {
    bin: writeFakeCliWithWebApp(home),
    componentPayloadRoot: payload.payloadRootLib,
    ...artifacts,
    dumpConfig: async (profile) => profile === "spaces-hub" ? alphaDump(profile) : dumpText(profile),
    processRuntime: alignProcessRuntime(spawned),
    pluginAdd: async (_addedHome, _profile, spec) => {
      if (spec.includes("dsh-spaces-plugin")) installs += 1;
    },
  });
  const state = await handle.runtime.state();
  assert.equal(installs, 1);
  assert.ok(state.reasons.some((reason) => reason.includes("manager plugin could not be aligned")));
  assert.notEqual(state.spaces.find((space) => space.id === state.managerId)?.status, "running");
  assert.equal(state.managerId && spawned.includes(state.managerId), false);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const submitted = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: state.managerId! },
    requestId: "start-unaligned-manager",
  });
  assert.equal(submitted.body.ok, true);
  const job = await waitJob(handle.origin, cookie, (submitted.body.value as { id: string }).id, "failed");
  assert.equal(job.status, "failed");
  assert.match(job.error?.message ?? job.message ?? "", /manager plugin could not be aligned/);
  assert.equal(installs, 1, "a rejected start does not repeat the alignment attempt");
  assert.equal(spawned.includes(state.managerId!), false);
});

test("same-coordinate drift adds the alternate archive once and keeps the drifted tree", async () => {
  const home = tempHome();
  writeProfile(home, "spaces-hub", {
    dependencies: { "@dsh-spaces/plugin": "0.2.0" },
    dsh: { profile: { bundles: ["@dsh-spaces/plugin", "@dsh-spaces/view-bridge"] } },
  });
  const payload = writePayload(mkdtempSync(join(tmpdir(), "dsh-align-r1-")), "fresh");
  const stale = writePayload(mkdtempSync(join(tmpdir(), "dsh-align-r1-stale-")), "stale");
  installManagerModules(home, payload, stale.packageRoot);
  const artifacts = packPayloadArtifacts(payload, join(home, "artifacts"));
  const digest = createHash("sha256").update(readFileSync(artifacts.pluginArtifact)).digest("hex").slice(0, 20);
  const id = `dsh-spaces-plugin-${digest}`;
  const canonical = archiveAbsPath(home, id);
  mkdirSync(dirname(canonical), { recursive: true });
  writeFileSync(canonical, readFileSync(artifacts.pluginArtifact));
  const canonicalBytes = readFileSync(canonical);
  const drifted = join(home, "profiles", "spaces-hub", "node_modules", "@dsh-spaces", "plugin", "lib", "index.js");
  const driftedBytes = Buffer.from("drifted-bytes;\n");
  writeFileSync(drifted, driftedBytes);
  const pkgPath = join(home, "profiles", "spaces-hub", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies: Record<string, string> };
  pkg.dependencies["@dsh-spaces/plugin"] = `file:${canonical.replaceAll("\\", "/")}`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeManagerRecord(home);
  const added: Array<{ spec: string; force?: boolean }> = [];
  const handle = await startSupervisor(home, {
    bin: writeFakeCliWithWebApp(home),
    componentPayloadRoot: payload.payloadRootLib,
    ...artifacts,
    dumpConfig: async (profile) => profile === "spaces-hub" ? alphaDump(profile) : dumpText(profile),
    pluginAdd: async (_addedHome, _profile, spec, options) => {
      added.push({ spec, force: options?.force });
    },
  });
  const state = await handle.runtime.state();
  assert.deepEqual(added.map((item) => basename(item.spec)), [`${id}-r1.tgz`]);
  assert.equal(added[0]?.force, undefined);
  assert.equal(readFileSync(drifted).equals(driftedBytes), true);
  assert.equal(readFileSync(canonical).equals(canonicalBytes), true);
  assert.equal(existsSync(archiveAbsPath(home, `${id}-r1`)), true);
  const installed = JSON.parse(readFileSync(join(home, "profiles", "spaces-hub", "node_modules", "@dsh-spaces", "plugin", "package.json"), "utf8")) as { name: string; version: string };
  assert.equal(installed.name, "@dsh-spaces/plugin");
  assert.equal(installed.version, "0.2.0");
  assert.notEqual(state.spaces.find((space) => space.id === state.managerId)?.status, "running");
  assert.ok(state.reasons.some((reason) => reason.includes("manager plugin could not be aligned")));
});

test("a malformed manager manifest fails alignment before plugin add", async () => {
  const home = tempHome();
  writeProfile(home, "spaces-hub", {
    dependencies: { "@dsh-spaces/plugin": "0.2.0" },
    dsh: { profile: { bundles: ["@dsh-spaces/plugin", "@dsh-spaces/view-bridge"] } },
  });
  writeManagerRecord(home);
  const payload = writePayload(mkdtempSync(join(tmpdir(), "dsh-align-bad-manifest-")), "bad");
  const stale = writePayload(mkdtempSync(join(tmpdir(), "dsh-align-bad-manifest-stale-")), "stale");
  installManagerModules(home, payload, stale.packageRoot);
  const artifacts = packPayloadArtifacts(payload, join(home, "artifacts"));
  const pkgPath = join(home, "profiles", "spaces-hub", "package.json");
  const drifted = join(home, "profiles", "spaces-hub", "node_modules", "@dsh-spaces", "plugin", "lib", "index.js");
  const driftedBytes = readFileSync(drifted);
  writeFileSync(pkgPath, `${JSON.stringify({
    dependencies: null,
    dsh: { profile: { bundles: ["@dsh-spaces/plugin", "@dsh-spaces/view-bridge"] } },
  })}\n`);
  let installs = 0;
  const handle = await startSupervisor(home, {
    bin: writeFakeCliWithWebApp(home),
    componentPayloadRoot: payload.payloadRootLib,
    ...artifacts,
    dumpConfig: async (profile) => profile === "spaces-hub" ? alphaDump(profile) : dumpText(profile),
    pluginAdd: async () => {
      installs += 1;
    },
  });
  const state = await handle.runtime.state();
  assert.equal(installs, 0);
  assert.equal(readFileSync(drifted).equals(driftedBytes), true);
  assert.notEqual(state.spaces.find((space) => space.id === state.managerId)?.status, "running");
  assert.ok(state.reasons.some((reason) => reason.includes("could not be read")));
});

test("registered spaces keep their pin; unregistered profiles and stale meta stay unpinned", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", {}, { dshVersion: "9.9.9" });
  writeProfile(home, "beta");
  writeProfile(home, "space-ghost");
  const spacesPath = join(home, "hub", "spaces.json");
  const file = JSON.parse(readFileSync(spacesPath, "utf8")) as {
    order: string[];
    meta: Record<string, Record<string, unknown>>;
  };
  // A meta entry without createdAt is not a registered space, even for a space-* dir.
  file.meta["space-ghost"] = { displayName: "ghost", order: 1001 };
  file.meta["web"] = { displayName: "web", order: -1 };
  writeFileSync(spacesPath, `${JSON.stringify(file, null, 2)}\n`);
  const handle = await startSupervisor(home);
  const readMeta = () => (JSON.parse(readFileSync(spacesPath, "utf8")) as {
    meta: Record<string, { dshVersion?: string }>;
  }).meta;
  assert.equal(readMeta()["space-alpha"].dshVersion, "9.9.9");
  assert.equal(readMeta()["space-ghost"].dshVersion, undefined);
  assert.equal(readMeta().beta, undefined);
  assert.equal(readMeta()["spaces-hub"]?.dshVersion, undefined);
  assert.equal(readMeta().web.dshVersion, undefined);
  const state = await handle.runtime.state();
  assert.equal(state.spaces.find((row) => row.id === "space-alpha")?.dshVersion, "9.9.9");
  assert.equal(state.spaces.some((row) => ["beta", "space-ghost", "web"].includes(row.id)), false);
  assert.ok(state.managerId);
  assert.equal(state.spaces.find((row) => row.id === state.managerId)?.dshVersion, null);
  await handle.close();
  await startSupervisor(home);
  assert.equal(readMeta()["space-alpha"].dshVersion, "9.9.9");
  assert.equal(readMeta()["space-ghost"].dshVersion, undefined);
});

test("a new space pins the host DSH version", async () => {
  const home = tempHome();
  const runtimeRoot = join(home, "runtimes");
  const handle = await startSupervisor(home, {
    runtimeRoot,
    snapshotWorkerFile: writeFakeRuntimeWorker(home),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const created = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.create", input: { name: "created" } },
    requestId: "create-created",
  });
  assert.equal(created.body.ok, true, JSON.stringify(created.body));
  await waitJob(handle.origin, cookie, "create-created");
  const state = await api(handle.origin, cookie, "state");
  const row = (state.body.value as { spaces: Array<{ id: string; dshVersion: string | null }> }).spaces
    .find((space) => space.id === "space-created");
  assert.equal(row?.dshVersion, "0.2.0-rc.2");
  const meta = (JSON.parse(readFileSync(join(home, "hub", "spaces.json"), "utf8")) as {
    meta: Record<string, { createdAt?: string; dshVersion?: string }>;
  }).meta["space-created"];
  assert.equal(typeof meta?.createdAt, "string");
  assert.ok(!Number.isNaN(Date.parse(meta?.createdAt ?? "")));
  assert.equal(meta?.dshVersion, "0.2.0-rc.2");
});

test("spaces pinned to different installed runtimes spawn with their own binaries; the manager uses the host CLI", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", {}, { dshVersion: "0.2.0-rc.2" });
  writeSpace(home, "beta", {}, { dshVersion: "0.9.9" });
  const hostBin = writeFakeCli(home);
  const runtimeRoot = join(home, "runtimes");
  const betaDir = join(runtimeRoot, "versions", "0.9.9", "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(betaDir, "lib"), { recursive: true });
  const betaBin = join(betaDir, "lib", "bin.js");
  writeFileSync(betaBin, "console.log('beta');\n");
  writeFileSync(join(betaDir, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.9.9" })}\n`);
  for (const name of ["dsh-base", "dsh-web-app"]) {
    const dir = join(runtimeRoot, "versions", "0.9.9", "node_modules", "@deepseek-ai", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `@deepseek-ai/${name}`, version: "0.9.9" })}\n`);
  }
  // A host-version pin that also has a store copy must prefer the store bin.
  const gammaDir = join(runtimeRoot, "versions", "0.2.0-rc.2", "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(gammaDir, "lib"), { recursive: true });
  const gammaBin = join(gammaDir, "lib", "bin.js");
  writeFileSync(gammaBin, "console.log('gamma');\n");
  writeFileSync(join(gammaDir, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.0-rc.2" })}\n`);
  writeSpace(home, "gamma", {}, { dshVersion: "0.2.0-rc.2" });
  writeSpace(home, "delta", {}, { dshVersion: "0.9.8" });
  const spawned: Array<{ profile: string; bin: string }> = [];
  const handle = await startSupervisor(home, {
    runtimeRoot,
    processRuntime: {
      ...alignProcessRuntime([]),
      spawn: (args, options = {}) => {
        spawned.push({ profile: args[args.indexOf("--profile") + 1] ?? "", bin: String(args.find((item) => item.endsWith("bin.js")) ?? args[0]) });
        return spawnFixture("ok")(args, options);
      },
    },
  });
  const state = await handle.runtime.state();
  assert.ok(state.managerId);
  assert.equal(spawned.find((row) => row.profile === state.managerId)?.bin, hostBin);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-alpha" },
    requestId: "start-a",
  });
  await waitJob(handle.origin, cookie, "start-a");
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-beta" },
    requestId: "start-b",
  });
  await waitJob(handle.origin, cookie, "start-b");
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-gamma" },
    requestId: "start-g",
  });
  await waitJob(handle.origin, cookie, "start-g");
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-delta" },
    requestId: "start-d",
  });
  await assert.rejects(waitJob(handle.origin, cookie, "start-d"), /not installed/);
  assert.equal(spawned.find((row) => row.profile === "space-alpha")?.bin, gammaBin,
    "a host-version pin prefers the store bin over the host CLI");
  assert.equal(spawned.find((row) => row.profile === "space-beta")?.bin, betaBin);
  assert.equal(spawned.find((row) => row.profile === "space-gamma")?.bin, gammaBin);
  assert.equal(spawned.some((row) => row.profile === "space-delta"), false);
});

test("startup without a selected payload checks each component's target engine requirement", async () => {
  const home = tempHome();
  const version = "0.2.1-rc.2";
  writeSpace(home, "alpha", {}, { dshVersion: version });
  const bridgeDir = join(home, "profiles", "space-alpha", "node_modules", "@dsh-spaces", "view-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  const bridgePath = join(bridgeDir, "package.json");
  const writeBridge = (engine: string, peer: string) => writeFileSync(bridgePath, JSON.stringify({
    name: "@dsh-spaces/view-bridge", version: "0.4.0",
    engines: { dsh: engine }, peerDependencies: { "@deepseek-ai/dsh": peer },
  }));
  writeBridge("<0.1.0", "workspace:*");
  const handle = await startSupervisor(home, { bin: writeFakeCli(home, version) });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-alpha" }, requestId: "engine-rejected",
  });
  const failed = await waitJob(handle.origin, cookie, "engine-rejected", "failed");
  assert.match(failed.error?.message ?? "", /view-bridge.*engines\.dsh@<0\.1\.0/);
  assert.equal((await handle.runtime.state()).spaces.find(row => row.id === "space-alpha")?.status, "stopped");
  writeBridge(">=0.2.1-alpha.4", "<0.1.0");
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-alpha" }, requestId: "engine-accepted",
  });
  await waitJob(handle.origin, cookie, "engine-accepted");
  assert.equal((await handle.runtime.state()).spaces.find(row => row.id === "space-alpha")?.status, "running");
});

test("a pinned version below the supported minimum rejects at start", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", {}, { dshVersion: "0.0.1-rc.1" });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-alpha" },
    requestId: "start-min",
  });
  const job = await waitJob(handle.origin, cookie, "start-min", "failed");
  assert.match(
    job.error?.message ?? "",
    /uses DSH 0\.0\.1-rc\.1, below the minimum 0\.2\.0-rc\.2 supported by this Spaces version\. Upgrade it in the space settings\./,
  );
});

test("a pinned version that is not installed rejects at start", async () => {
  const home = tempHome();
  writeSpace(home, "beta", {}, { dshVersion: "0.9.9" });
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-beta" },
    requestId: "start-missing",
  });
  const job = await waitJob(handle.origin, cookie, "start-missing", "failed");
  assert.match(
    job.error?.message ?? "",
    /DSH 0\.9\.9 for this space is not installed\. Install it from the space settings\./,
  );
});

test("an unpinned space is rejected at start instead of falling back to the host CLI", async () => {
  const home = tempHome();
  const handle = await startSupervisor(home);
  writeSpace(home, "ghost");
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-ghost" },
    requestId: "start-ghost",
  });
  const job = await waitJob(handle.origin, cookie, "start-ghost", "failed");
  assert.match(
    job.error?.message ?? "",
    /This space has no pinned DSH version\. Choose one in the space settings\./,
  );
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-missing" },
    requestId: "start-missing",
  });
  await waitJob(handle.origin, cookie, "start-missing", "failed");
  assert.equal((await handle.runtime.job("start-missing")).error?.code, "workbench/not-found");
});

test("space.runtime.set preview rejects protected, unmanaged, and downgrade targets", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", {}, { dshVersion: "0.9.9" });
  const handle = await startSupervisor(home, {
    createMaintenance: (ports) =>
      new WorkbenchMaintenanceService(ports, {
        packageSource: "official",
        pluginAdd: async () => undefined,
        log: () => undefined,
      }),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const preview = async (request: unknown) =>
    (await mutate(handle.origin, cookie, "preview", { request })).body;

  assert.equal((await preview({ kind: "runtime.install", version: "0.2.0-rc.2" })).error?.code, "workbench/unsupported");
  assert.equal((await preview({ kind: "space.runtime.set", spaceId: "web", version: "0.2.0-rc.2" })).error?.code, "workbench/not-found");
  assert.equal((await preview({ kind: "space.runtime.set", spaceId: "desktop", version: "0.2.0-rc.2" })).error?.code, "workbench/protected");
  const hub = await preview({ kind: "space.runtime.set", spaceId: "spaces-hub", version: "0.2.0-rc.2" });
  assert.equal(hub.ok, false);
  assert.equal(hub.error?.code, "workbench/forbidden");
  const downgrade = await preview({ kind: "space.runtime.set", spaceId: "space-alpha", version: "0.2.0-rc.2" });
  assert.equal(downgrade.ok, false);
  assert.equal(downgrade.error?.code, "workbench/invalid-input");
  assert.match(downgrade.error?.message ?? "", /Downgrading a space's DSH version is not allowed\./);
  const belowMin = await preview({ kind: "space.runtime.set", spaceId: "space-alpha", version: "0.0.1-rc.1" });
  assert.equal(belowMin.error?.code, "workbench/invalid-input");
  const range = await preview({ kind: "space.runtime.set", spaceId: "space-alpha", version: "latest" });
  assert.equal(range.error?.code, "workbench/invalid-input");
  const missing = await preview({ kind: "space.runtime.set", spaceId: "space-missing", version: "0.2.0-rc.2" });
  assert.equal(missing.error?.code, "workbench/not-found");

  const bridge = join(home, "profiles", "space-alpha", "node_modules", "@dsh-spaces", "view-bridge");
  mkdirSync(bridge, { recursive: true });
  writeFileSync(
    join(bridge, "package.json"),
    `${JSON.stringify({
      name: "@dsh-spaces/view-bridge",
      version: "0.2.0",
      peerDependencies: { "@deepseek-ai/dsh": "^9.0.0" },
    })}\n`,
  );
  const peers = await preview({ kind: "space.runtime.set", spaceId: "space-alpha", version: "0.9.9" });
  assert.equal(peers.error?.code, "workbench/invalid-input");
  assert.match(
    peers.error?.message ?? "",
    /These plugins do not support DSH 0\.9\.9: @dsh-spaces\/view-bridge \(@deepseek-ai\/dsh@\^9\.0\.0\)\. Remove or upgrade them first\./,
  );
});

test("space.runtime.set pins the new runtime and restarts a running space without installing official plugins", async () => {
  const home = tempHome();
  writeSpace(home, "alpha", {}, { dshVersion: "0.2.0-rc.2" });
  const runtimeRoot = join(home, "runtimes");
  const nextDir = join(runtimeRoot, "versions", "0.9.9", "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(nextDir, "lib"), { recursive: true });
  writeFileSync(join(nextDir, "lib", "bin.js"), "console.log('next');\n");
  writeFileSync(join(nextDir, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.9.9" })}\n`);
  const specs: string[] = [];
  const spawned: string[] = [];
  const handle = await startSupervisor(home, {
    runtimeRoot,
    processRuntime: {
      ...alignProcessRuntime([]),
      spawn: (args, options = {}) => {
        spawned.push(args[args.indexOf("--profile") + 1] ?? "");
        return spawnFixture("ok")(args, options);
      },
    },
    createMaintenance: (ports) =>
      new WorkbenchMaintenanceService(ports, {
        packageSource: "official",
        pluginAdd: async (_addedHome, _profile, spec) => {
          specs.push(spec);
        },
        log: () => undefined,
      }),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-alpha" },
    requestId: "start-alpha",
  });
  await waitJob(handle.origin, cookie, "start-alpha");
  const preview = await mutate(handle.origin, cookie, "preview", {
    request: { kind: "space.runtime.set", spaceId: "space-alpha", version: "0.9.9" },
  });
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body));
  const plan = preview.body.value as WorkbenchPlan;
  assert.ok(plan.changes.some((line) => /0\.2\.0-rc\.2/.test(line) && /0\.9\.9/.test(line)), plan.changes.join(" | "));
  assert.ok(plan.changes.some((line) => /Official plugins come from DSH 0\.9\.9 itself\./.test(line)), plan.changes.join(" | "));
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "plan.execute", planId: plan.id },
    requestId: "runtime-set",
  });
  const job = await waitJob(handle.origin, cookie, "runtime-set");
  assert.equal(job.status, "succeeded");
  const recorded = JSON.parse(
    readFileSync(join(home, ".dsh-spaces-control", "jobs", "runtime-set.json"), "utf8"),
  ) as { result?: { spaceId?: string; dshVersion?: string } };
  assert.equal(recorded.result?.spaceId, "space-alpha");
  assert.equal(recorded.result?.dshVersion, "0.9.9");
  const meta = JSON.parse(readFileSync(join(home, "hub", "spaces.json"), "utf8")) as {
    meta: Record<string, { dshVersion?: string }>;
  };
  assert.equal(meta.meta["space-alpha"]?.dshVersion, "0.9.9");
  assert.equal(specs.filter((spec) => spec.startsWith("@deepseek-ai/")).length, 0);
  assert.equal(spawned.filter((name) => name === "space-alpha").length, 2);
});

test("runtime.remove removes an unpinned installed runtime and refuses protected versions", async () => {
  const home = tempHome();
  writeProfile(home, "alpha");
  const runtimeRoot = join(home, "runtimes");
  const staleDir = join(runtimeRoot, "versions", "0.9.9");
  mkdirSync(join(staleDir, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  writeFileSync(join(staleDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "console.log('stale');\n");
  writeFileSync(
    join(staleDir, "node_modules", "@deepseek-ai", "dsh", "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.9.9" })}\n`,
  );
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(
    join(home, "hub", "spaces.json"),
    `${JSON.stringify({
      version: 1,
      order: ["alpha"],
      meta: { alpha: { displayName: "alpha", order: 1000, dshVersion: "0.2.0-rc.2" } },
    }, null, 2)}\n`,
  );
  const handle = await startSupervisor(home, {
    runtimeRoot,
    createMaintenance: (ports) =>
      new WorkbenchMaintenanceService(ports, {
        packageSource: "official",
        pluginAdd: async () => undefined,
        log: () => undefined,
      }),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const preview = async (request: unknown) =>
    (await mutate(handle.origin, cookie, "preview", { request })).body;

  const host = await preview({ kind: "runtime.remove", version: "0.2.0-rc.2" });
  assert.equal(host.error?.code, "workbench/invalid-input");
  const pinned = await preview({ kind: "runtime.remove", version: "0.9.9" });
  assert.equal(pinned.ok, true, JSON.stringify(pinned));
  const plan = pinned.value as WorkbenchPlan;
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "plan.execute", planId: plan.id },
    requestId: "runtime-remove",
  });
  const job = await waitJob(handle.origin, cookie, "runtime-remove");
  assert.equal(job.status, "succeeded");
  assert.equal(existsSync(staleDir), false);
  const missing = await preview({ kind: "runtime.remove", version: "0.9.9" });
  assert.equal(missing.error?.code, "workbench/invalid-input");
  assert.match(missing.error?.message ?? "", /not installed in the Spaces runtime store\./);
});

test("runtime.upgrade previews are rejected as unsupported", async () => {
  const home = tempHome();
  const handle = await startSupervisor(home);
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const preview = await mutate(handle.origin, cookie, "preview", {
    request: { kind: "runtime.upgrade", version: "0.9.9" },
  });
  assert.equal(preview.body.ok, false);
  assert.equal(preview.body.error?.code, "workbench/unsupported");
});

test("startup performs no official plugin installs on the manager", async () => {
  const home = tempHome();
  writeProfile(home, "spaces-hub", {
    dependencies: { "@dsh-spaces/plugin": "0.2.0" },
    dsh: { profile: { bundles: ["@dsh-spaces/plugin", "@dsh-spaces/view-bridge"] } },
  });
  writeManagerRecord(home);
  const payload = writePayload(mkdtempSync(join(tmpdir(), "dsh-official-payload-")), "official");
  installManagerModules(home, payload, payload.packageRoot);
  const artifacts = packPayloadArtifacts(payload, join(home, "artifacts"));
  const specs: string[] = [];
  const handle = await startSupervisor(home, {
    bin: writeFakeCliWithWebApp(home),
    componentPayloadRoot: payload.payloadRootLib,
    ...artifacts,
    dumpConfig: async (profile) => profile === "spaces-hub" ? alphaDump(profile) : dumpText(profile),
    pluginAdd: async (_addedHome, _profile, spec) => {
      specs.push(spec);
    },
  });
  const state = await handle.runtime.state();
  assert.equal(specs.filter((spec) => spec.startsWith("@deepseek-ai/")).length, 0);
  assert.equal(state.spaces.find((space) => space.id === state.managerId)?.status, "running", state.reasons.join(" | "));
});

test("bridge packages declare peer ranges covering the supported DSH minimum", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  for (const name of ["view-bridge", "llm-bridge", "browser"]) {
    const pkg = JSON.parse(
      readFileSync(join(root, "..", "..", "packages", name, "package.json"), "utf8"),
    ) as { peerDependencies?: Record<string, string> };
    for (const [dep, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!dep.startsWith("@deepseek-ai/dsh-")) continue;
      assert.ok(satisfies(SPACES_MIN_DSH_VERSION, range), `${name} peer ${dep}`);
    }
  }
});


function writeFakeRuntimeWorker(home: string, gate?: boolean): string {
  const workerFile = join(home, gate ? "fake-runtime-worker-gated.mjs" : "fake-runtime-worker.mjs");
  writeFileSync(workerFile, [
    'import { parentPort, workerData } from "node:worker_threads";',
    'import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const jobsDir = join(workerData.home, ".dsh-spaces-control", "jobs");',
    'const jobs = readdirSync(jobsDir)',
    '  .map((f) => JSON.parse(readFileSync(join(jobsDir, f), "utf8")))',
    '  .filter((j) => j.kind === "space.create" && j.status === "running")',
    '  .map((j) => ({ phase: j.phase, message: j.message }));',
    'mkdirSync(workerData.runtimeRoot, { recursive: true });',
    'writeFileSync(join(workerData.runtimeRoot, "seen.json"), JSON.stringify(jobs));',
    'const dir = join(workerData.runtimeRoot, "versions", workerData.version, "node_modules", "@deepseek-ai", "dsh");',
    'mkdirSync(join(dir, "lib"), { recursive: true });',
    'const bin = join(dir, "lib", "bin.js");',
    'writeFileSync(bin, "console.log(1);\\n");',
    'writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: workerData.version }));',
    ...(gate ? [
      'const gate = join(workerData.runtimeRoot, "install-gate");',
      'const deadline = Date.now() + 30000;',
      'while (!existsSync(gate) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));',
      'if (!existsSync(gate)) throw Error("install gate never released");',
    ] : []),
    'parentPort.postMessage({ ok: true, result: { bin, version: workerData.version, origin: "store" } });',
  ].join("\n"));
  return workerFile;
}

test("a create that installs a missing runtime reports the install phase and restores create", async () => {
  const home = tempHome();
  const runtimeRoot = join(home, "runtimes");
  const handle = await startSupervisor(home, {
    runtimeRoot,
    snapshotWorkerFile: writeFakeRuntimeWorker(home),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  const submittedResponse = await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.create", input: { name: "fresh-space", displayName: "Fresh", icon: "whale", modelSource: "main", baseVersion: "0.9.9" } },
    requestId: "create-install",
  });
  const submittedBody = submittedResponse.body as { ok?: boolean; value?: { subject?: { displayName: string; icon?: string }; status: string }; error?: { code: string; message: string } };
  assert.ok(submittedBody.ok, JSON.stringify(submittedBody.error));
  const submitted = submittedBody.value!;
  assert.deepEqual(submitted.subject, { displayName: "Fresh", icon: "whale" }, "an active create carries its subject and icon");
  assert.deepEqual((submitted as { affectedSpaceIds?: string[] }).affectedSpaceIds, ["space-fresh-space"],
    "an active create exposes its eventual space id for presentation projections");
  const done = await waitJob(handle.origin, cookie, "create-install");
  assert.equal(done.status, "succeeded");
  const record = (await api(handle.origin, cookie, "job", { id: "create-install" })).body.value as {
    phase: string;
    message: string;
    subject?: { displayName: string; icon?: string };
  };
  assert.equal(record.phase, "llm-policy", "the final record keeps the last create phase");
  assert.equal(record.message, "", "the final record does not keep the install message");
  assert.deepEqual(record.subject, { displayName: "Fresh" }, "a settled create keeps the name but drops the icon");
  const seen = JSON.parse(readFileSync(join(runtimeRoot, "seen.json"), "utf8")) as Array<{
    phase: string;
    message: string;
  }>;
  assert.deepEqual(seen, [{ phase: "install", message: "DSH 0.9.9" }]);
  const { spaceCreateStep } = await import("../../src/shared/space-host.ts");
  // The canonical phase order is monotonic by construction of the step table.
  const ordered = ["prepare", "install", "create", "view-bridge", "llm-bridge", "llm-policy"];
  const steps = ordered.map((phase) => spaceCreateStep(phase).index);
  assert.ok(steps.every((step, i) => i === 0 || step >= steps[i - 1]), `steps: ${steps.join(",")}`);
  // The live run ended on the last phase; earlier phases were captured above.
  assert.equal(record.phase, "llm-policy");
});

test("a space.start submitted mid-install with a pre-create revision", async () => {
  const home = tempHome();
  const runtimeRoot = join(home, "runtimes");
  writeSpace(home, "running-one", {}, { dshVersion: "0.2.0-rc.2" });
  const handle = await startSupervisor(home, {
    runtimeRoot,
    snapshotWorkerFile: writeFakeRuntimeWorker(home, true),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.create", input: { name: "gate-space", baseVersion: "0.9.9" } },
    requestId: "create-gate",
  });
  // Wait until the create is inside the install; the new space does not exist yet.
  let createJob = {} as { phase?: string };
  for (let i = 0; i < 200 && createJob.phase !== "install"; i++) {
    await new Promise((r) => setTimeout(r, 25));
    createJob = (await api(handle.origin, cookie, "job", { id: "create-gate" })).body.value as { phase?: string };
  }
  assert.equal(createJob.phase, "install", "the create must be inside the install for the context to be pre-create");
  const snapshot = (await api(handle.origin, cookie, "state", {})).body.value as {
    spaces: Array<{ id: string }>;
  };
  assert.equal(snapshot.spaces.some((space) => space.id === "space-gate-space" || space.id === "gate-space"), false,
    "the space being created is not listed yet");
  const start = (await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.start", spaceId: "space-running-one" },
    requestId: "start-behind-create",
  })).body.value as { status: string };
  assert.equal(start.status, "queued");
  writeFileSync(join(runtimeRoot, "install-gate"), "go");
  const finishedCreate = await waitJob(handle.origin, cookie, "create-gate");
  assert.equal(finishedCreate.status, "succeeded");
  // Premise confirmed: with the revision captured before the space existed,
  // the queued start fails the live-context check when it runs.
  const finishedStart = await waitJob(handle.origin, cookie, "start-behind-create", "failed");
  assert.equal((finishedStart.error as { code?: string } | undefined)?.code, "workbench/conflict");
});

test("a create on the host runtime installs that version into the store and pins it", async () => {
  const home = tempHome();
  const runtimeRoot = join(home, "runtimes");
  const handle = await startSupervisor(home, {
    runtimeRoot,
    snapshotWorkerFile: writeFakeRuntimeWorker(home),
  });
  const cookie = await bootstrap(handle.origin, handle.bootstrapUrl);
  await mutate(handle.origin, cookie, "submit", {
    command: { kind: "space.create", input: { name: "host-space" } },
    requestId: "create-host",
  });
  const done = await waitJob(handle.origin, cookie, "create-host");
  assert.equal(done.status, "succeeded");
  assert.equal(existsSync(join(runtimeRoot, "seen.json")), true, "the install worker ran for the host version");
  const registry = JSON.parse(readFileSync(join(home, "hub", "spaces.json"), "utf8")) as {
    meta: Record<string, { dshVersion?: string }>;
  };
  assert.equal(registry.meta["space-host-space"]?.dshVersion, "0.2.0-rc.2",
    "the space is pinned to the host version it was created at");
});
