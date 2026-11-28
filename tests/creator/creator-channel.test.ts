import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  CREATOR_CHANNEL_PREFIX,
  type CreatorIssueResult,
  type CreatorPlan,
} from "../../src/shared/creator.ts";
import { parseInstallSpec } from "@deepseek-ai/dsh-plugin-manager";
import { SupervisorCreator, type SupervisorCreatorPorts } from "../../src/adapters/node/supervisor/creator.ts";
import { SupervisorLifecycle } from "../../src/adapters/node/supervisor/lifecycle.ts";
import { SupervisorSpaces } from "../../src/adapters/node/supervisor/spaces.ts";
import { SpaceRunRegistry } from "../../src/adapters/node/supervisor/space-runs.ts";
import { HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock.ts";
import { ProfileRegistry } from "../../src/adapters/node/profile/profile-registry.ts";
import { WorkbenchJobStore } from "../../src/adapters/node/maintenance/workbench-jobs.ts";
import { WorkbenchPublicError } from "../../src/adapters/node/supervisor/errors.ts";
import type { WorkbenchJob } from "../../src/shared/workbench.ts";
import type { SpaceBaseCreation } from "../../src/adapters/node/supervisor/base-creation.ts";
import type { NodeSpacesService } from "../../src/adapters/node/products/spaces-service.ts";

const temps: string[] = [];
const listeners: Server[] = [];
const HOST_BEARER = "a".repeat(64);

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-creator-"));
  temps.push(home);
  return home;
}

function writeProfile(home: string, name: string, extraBundles: string[] = []): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    private: true,
    dependencies: {
      "@deepseek-ai/dsh-web-app": "0.1.5-rc.1",
      ...Object.fromEntries(extraBundles.map((name) => [name, "0.0.0"])),
    },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app", ...extraBundles] } },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeSpace(home: string, name: string): string {
  const id = `space-${name}`;
  writeProfile(home, id);
  const spacesPath = join(home, "hub", "spaces.json");
  const spaces = existsSync(spacesPath)
    ? (JSON.parse(readFileSync(spacesPath, "utf8")) as { version: 1; order: string[]; meta: Record<string, Record<string, unknown>> })
    : { version: 1 as const, order: [] as string[], meta: {} };
  spaces.meta[id] = { displayName: name, order: spaces.order.length + 1000, createdAt: "2025-01-01T00:00:00.000Z" };
  if (!spaces.order.includes(id)) spaces.order.push(id);
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(spacesPath, `${JSON.stringify(spaces, null, 2)}\n`);
  return id;
}

/** pnpm persists git resolutions in pnpm-lock.yaml, not the dep specifier. */
function writeGitLockEntry(h: string, p: string, name: string, spec: string): void {
  const body = spec.replace(/^github:/, "https://github.com/").replace(/^git\+/, "");
  const [repoPart, fragment = ""] = body.split("#");
  const repo = repoPart!.replace(/\.git$/, "");
  const segments = fragment.split("&").filter(Boolean);
  const commit = segments.find((part) => !part.startsWith("path:") && !part.startsWith("semver:")) ?? "";
  const path = segments.find((part) => part.startsWith("path:"))?.slice(5);
  const resolution = `{commit: '${commit}', repo: '${repo}', type: git${path ? `, path: ${JSON.stringify(path)}` : ""}}`;
  const depPath = `git+${repo}#${commit}${path ? `&path:${path}` : ""}`;
  writeFileSync(
    join(h, "profiles", p, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      ${name}:\n        specifier: '${spec}'\n        version: '${depPath}'\n\nsnapshots:\n  ${name}@${depPath}:\n    resolution: ${resolution}\n`,
  );
}

/** A codeload (public-repo) lockfile form for the same pinned source. */
function writeCodeloadLockEntry(h: string, p: string, name: string, spec: string): void {
  const body = spec.replace(/^github:/, "https://github.com/").replace(/^git\+/, "");
  const [repoPart, fragment = ""] = body.split("#");
  const segments = fragment.split("&").filter(Boolean);
  const commit = segments.find((part) => !part.startsWith("path:") && !part.startsWith("semver:")) ?? "";
  const path = segments.find((part) => part.startsWith("path:"))?.slice(5);
  const repoPath = repoPart!.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const tarball = `https://codeload.github.com/${repoPath}/tar.gz/${commit}`;
  const depPath = `${tarball}${path ? `#path:${path}` : ""}`;
  writeFileSync(
    join(h, "profiles", p, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      ${name}:\n        specifier: '${spec}'\n        version: '${depPath}'\n\nsnapshots:\n  ${name}@${depPath}:\n    resolution: {tarball: '${tarball}'}\n`,
  );
}

function registerBundle(h: string, p: string, name: string, spec: string): void {
  const pkgPath = join(h, "profiles", p, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: spec };
  pkg.dsh = pkg.dsh ?? { profile: {} };
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = [...new Set([...(pkg.dsh.profile.bundles ?? []), name])];
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

interface PortsFixture {
  home: string;
  creator: SupervisorCreator;
  ports: SupervisorCreatorPorts;
  jobs: WorkbenchJobStore;
  lifecycle: SupervisorLifecycle;
  registry: ProfileRegistry;
  runs: SpaceRunRegistry;
  installCalls: string[];
  started: string[];
  created: string[];
  origin: string;
}

function makePorts(home: string, options: {
  origin?: string;
  now?: () => Date;
  ownerAlive?: () => boolean;
  pluginAdd?: SupervisorCreatorPorts["pluginAdd"];
  epoch?: string;
  revision?: () => string;
  hasComponent?: SupervisorCreatorPorts["hasComponent"];
  startSpace?: SupervisorCreatorPorts["startSpace"];
} = {}): PortsFixture {
  const lifecycle = new SupervisorLifecycle(() => {});
  let ownerAlive = true;
  const ownerFn = options.ownerAlive ?? (() => ownerAlive);
  lifecycle.handle = {
    owner: {
      kind: "web",
      pid: process.pid,
      nonce: "n".repeat(32),
      startedAt: new Date().toISOString(),
      endpoint: "http://127.0.0.1:1",
    },
    release: async () => { ownerAlive = false; },
  } as never;
  const lock = new HomeOperationLock(home);
  const registry = new ProfileRegistry(home);
  const runs = new SpaceRunRegistry();
  const jobs = new WorkbenchJobStore({ home });
  const origin = options.origin ?? "http://127.0.0.1:4100";
  const installCalls: string[] = [];
  const started: string[] = [];
  const created: string[] = [];
  const inventory = new SupervisorSpaces({
    home, registry, lifecycle, runs,
    processes: () => undefined,
    managerId: () => "hub",
  });
  const pluginAdd = options.pluginAdd ?? (async (addedHome: string, profile: string, spec: string) => {
    installCalls.push(`${profile} <- ${spec}`);
    if (spec.startsWith("github:") || spec.startsWith("git+")) {
      // Install under the expected package name, recording the verbatim spec
      // the way pnpm records the dependency source, plus the authoritative
      // lockfile resolution pnpm persists for git deps.
      const packageName = /[#&]path:\/?([^&#]+)/.exec(spec)?.[1]?.split("/").pop()
        ?? spec.split("#")[0]!.split("/").pop()!;
      const dir = join(addedHome, "profiles", profile, "node_modules", ...packageName.split("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: packageName, version: "0.0.0" })}\n`);
      registerBundle(addedHome, profile, packageName, spec);
      writeGitLockEntry(addedHome, profile, packageName, spec);
      return;
    }
    const official = spec.match(/^(@?[a-z0-9-]+(?:\/[a-z0-9-]+)?)@([^@]+)$/);
    if (official) {
      const dir = join(addedHome, "profiles", profile, "node_modules", ...official[1]!.split("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: official[1], version: official[2] })}\n`);
      registerBundle(addedHome, profile, official[1]!, spec);
      return;
    }
    throw new Error(`unsupported spec ${spec}`);
  });
  const bases = {
    prepare: async (_base: string, _requested: string | undefined, onInstall?: (v: string) => void) => ({
      base: "web",
      baseVersion: "0.2.0-rc.2",
      runtimeVersion: "0.2.0-rc.2",
      runCli: async () => ({ code: 0, stdout: "", stderr: "" }),
      onInstallUsed: onInstall,
    }),
  } as unknown as SpaceBaseCreation;
  const spaces = {
    create: async (input: { name: string; displayName?: string }) => {
      const id = `space-${input.name}`;
      writeProfile(home, id);
      writeSpaceFromProfile(home, id, input.displayName ?? input.name);
      created.push(id);
      return { id };
    },
  } as unknown as NodeSpacesService;
  const epoch = options.epoch ?? "e".repeat(64);
  const ports: SupervisorCreatorPorts = {
    home,
    origin: () => origin,
    now: options.now ?? (() => new Date()),
    fetch: globalThis.fetch.bind(globalThis),
    lifecycle,
    lock,
    registry,
    runs,
    jobs: () => jobs,
    managerId: () => "hub",
    cli: () => ({ bin: join(home, "cli", "lib", "bin.js"), version: "0.2.0-rc.2" }),
    spaces: () => spaces,
    bases,
    hostBearerEquals: (value) => value === HOST_BEARER,
    assertOwner: () => {
      if (!ownerFn()) throw new WorkbenchPublicError("workbench/read-only");
    },
    currentServiceEpoch: () => epoch,
    stateRevision: options.revision ?? (() => "rev-1"),
    registeredSpaceIds: () => inventory.listSpaces().map((row) => row.id),
    maintenance: () => false,
    hasComponent: options.hasComponent ?? (() => false),
    ensureViewBridge: async () => undefined,
    syncMainModels: async () => ({ mainProfile: "web", routes: [], deepseek: false, credentials: [], skipped: [], missingCredentials: [] }),
    installedRuntimeBin: () => join(home, "cli", "lib", "bin.js"),
    startSpace: options.startSpace ?? (async (spaceId) => { started.push(spaceId); return { spaceId }; }),
    pluginAdd,
    observeChildWork: (action) => action(),
    setActiveJob: () => undefined,
  };
  return { home, creator: new SupervisorCreator(ports), ports, jobs, lifecycle, registry, runs, installCalls, started, created, origin };
}

function writeSpaceFromProfile(home: string, id: string, displayName: string): void {
  const spacesPath = join(home, "hub", "spaces.json");
  const spaces = existsSync(spacesPath)
    ? (JSON.parse(readFileSync(spacesPath, "utf8")) as { version: 1; order: string[]; meta: Record<string, Record<string, unknown>> })
    : { version: 1 as const, order: [] as string[], meta: {} };
  spaces.meta[id] = { displayName, order: spaces.order.length + 1000, createdAt: "2025-01-01T00:00:00.000Z" };
  if (!spaces.order.includes(id)) spaces.order.push(id);
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(spacesPath, `${JSON.stringify(spaces, null, 2)}\n`);
}

interface IdentityServer {
  origin: string;
  bearer: string;
  close(): Promise<void>;
}

interface IdentityControl {
  bearer?: string;
  mode?: "proof" | "hold" | "status";
  status?: number;
  release?: () => void;
}

async function startIdentityServer(expected: { home: string; profile: string; wrong?: { home?: string; profile?: string } }, control: IdentityControl = {}): Promise<IdentityServer> {
  const bearer = "c".repeat(64);
  const server = createServer((req, res) => {
    const fail = (status: number) => { res.writeHead(status); res.end(); };
    if (req.method !== "POST" || req.headers.authorization !== `Bearer ${control.bearer ?? bearer}`) return fail(401);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString()) as { nonce?: unknown };
        if (req.url !== "/identity") return fail(404);
        if (control.mode === "hold") {
          control.release = () => { res.writeHead(control.status ?? 500); res.end(); };
          return;
        }
        if (control.mode === "status") return fail(control.status ?? 500);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          nonce: input.nonce,
          home: expected.wrong?.home ?? resolve(expected.home),
          profile: expected.wrong?.profile ?? expected.profile,
        }));
      } catch {
        fail(400);
      }
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); accept(); });
  });
  listeners.push(server);
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    bearer,
    close: () => new Promise<void>((accept) => server.close(() => accept())),
  };
}

interface CallResult {
  status: number;
  body: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
}

async function serve(fx: PortsFixture): Promise<() => Promise<void>> {
  const server = createServer((req, res) => { void fx.creator.handle(req, res); });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); accept(); });
  });
  listeners.push(server);
  const port = (server.address() as { port: number }).port;
  (fx.ports as { origin: () => string }).origin = () => `http://127.0.0.1:${port}`;
  return () => new Promise<void>((accept) => server.close(() => accept()));
}

async function call(fx: PortsFixture, op: string, bearer: string, body: unknown): Promise<CallResult> {
  const response = await fetch(`${fx.ports.origin()}${CREATOR_CHANNEL_PREFIX}${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: CallResult["body"] = {};
  try {
    parsed = JSON.parse(text) as CallResult["body"];
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed };
}

async function issue(fx: PortsFixture, listener: IdentityServer, profile = "web"): Promise<CreatorIssueResult> {
  const result = await call(fx, "issue", HOST_BEARER, {
    origin: listener.origin,
    bearer: listener.bearer,
    home: fx.home,
    profile,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body.value as CreatorIssueResult;
}

async function jobSettled(fx: PortsFixture, scope: string, jobId: string, timeoutMs = 15_000): Promise<WorkbenchJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await call(fx, "job", scope, { jobId });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true, JSON.stringify(result.body));
    const job = result.body.value as WorkbenchJob;
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    assert.ok(Date.now() < deadline, `job ${jobId} did not settle: ${job.phase} ${job.message}`);
    await delay(30);
  }
}

afterEach(async () => {
  for (const listener of listeners.splice(0)) {
    await new Promise<void>((accept) => listener.close(() => accept()));
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue requires the host bearer and mints a scope that gates business ops", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });

  for (const op of ["context", "createPreview", "createExecute", "job"]) {
    const body = op === "createExecute" ? { planId: "p", requestId: "r" } : op === "job" ? { jobId: "j" } : op === "createPreview" ? { input: { name: "x" } } : {};
    const denied = await call(fx, op, HOST_BEARER, body);
    assert.equal(denied.status, 401, `${op} must reject the host bearer`);
    const forged = await call(fx, op, "f".repeat(64), body);
    assert.equal(forged.status, 401, `${op} must reject an unknown token`);
  }
  const forgedIssue = await call(fx, "issue", "f".repeat(64), {
    origin: listener.origin, bearer: listener.bearer, home: fx.home, profile: "web",
  });
  assert.equal(forgedIssue.status, 401);

  const issued = await issue(fx, listener);
  assert.match(issued.scopes.creator ?? "", /^[a-f0-9]{64}$/);
  assert.match(issued.scopes.control ?? "", /^[a-f0-9]{64}$/);
  assert.notEqual(issued.scopes.control, issued.scopes.creator);
  assert.equal(issued.serviceEpoch, "e".repeat(64));
  const scope = issued.scopes.creator!;

  const second = await call(fx, "issue", HOST_BEARER, {
    origin: listener.origin, bearer: listener.bearer, home: fx.home, profile: "web",
  });
  assert.equal(second.body.ok, false);
  assert.equal(second.body.error?.code, "creator/conflict");

  const context = await call(fx, "context", scope, {});
  assert.equal(context.body.ok, true, JSON.stringify(context.body));
  const value = context.body.value as { writable: boolean; serviceEpoch: string; createBusy: boolean };
  assert.equal(value.serviceEpoch, "e".repeat(64));
  assert.equal(value.writable, true);
  assert.equal(value.createBusy, false);

  const unregisterScope = await call(fx, "unregister", scope, { registrationId: issued.registrationId });
  assert.equal(unregisterScope.status, 401);
  const unregisterWrongId = await call(fx, "unregister", HOST_BEARER, { registrationId: "reg-other" });
  assert.equal(unregisterWrongId.body.ok, false);
  assert.equal(unregisterWrongId.body.error?.code, "creator/unregistered");
  const unregister = await call(fx, "unregister", HOST_BEARER, { registrationId: issued.registrationId });
  assert.equal(unregister.body.ok, true);
  const stale = await call(fx, "context", scope, {});
  assert.equal(stale.status, 401);
});

test("issue refuses non-main profiles, identity mismatches and foreign homes", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "child");
  writeProfile(home, "space-stopped");
  const fx = makePorts(home);
  fx.runs.spawned.set("space-live", { pid: 1, startedAt: new Date().toISOString() });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });

  for (const profile of ["space-child", "space-stopped", "space-live", "hub", "web-missing"]) {
    const denied = await call(fx, "issue", HOST_BEARER, {
      origin: listener.origin, bearer: listener.bearer, home: fx.home, profile,
    });
    assert.equal(denied.body.ok, false, profile);
    assert.equal(denied.body.error?.code, "creator/invalid-input", profile);
  }

  const wrong = await startIdentityServer({ home, profile: "web", wrong: { profile: "space-child" } });
  const mismatch = await call(fx, "issue", HOST_BEARER, {
    origin: wrong.origin, bearer: wrong.bearer, home: fx.home, profile: "web",
  });
  assert.equal(mismatch.body.ok, false);
  assert.equal(mismatch.body.error?.code, "creator/unavailable");

  const foreignHome = await call(fx, "issue", HOST_BEARER, {
    origin: listener.origin, bearer: listener.bearer, home: "H:\\elsewhere", profile: "web",
  });
  assert.equal(foreignHome.body.ok, false);
  assert.equal(foreignHome.body.error?.code, "creator/invalid-input");

  const wrongBearer = await startIdentityServer({ home, profile: "web", wrong: {} });
  const listenerBad = createServer((req, res) => { res.writeHead(401); res.end(); });
  await new Promise<void>((accept) => listenerBad.listen(0, "127.0.0.1", accept));
  listeners.push(listenerBad);
  const bad = await call(fx, "issue", HOST_BEARER, {
    origin: `http://127.0.0.1:${(listenerBad.address() as { port: number }).port}`,
    bearer: wrongBearer.bearer,
    home: fx.home,
    profile: "web",
  });
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.error?.code, "creator/unavailable");
});

test("preview freezes a bound plan and execute runs the single composed job", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;

  const preview = await call(fx, "createPreview", scope, {
    input: {
      name: "factory",
      displayName: "Factory",
      icon: "hammer",
      modelSource: "local",
      startAfterCreate: true,
      plugins: [
        { npm: { packageName: "dsh-plugin-a", version: "1.2.3" } },
        { github: { owner: "klarkxy", repo: "dsh-plugins", commit: "a".repeat(40), path: "plugins/dsh-b", packageName: "dsh-b" } },
      ],
    },
  });
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body));
  const plan = preview.body.value as CreatorPlan;
  assert.equal(plan.kind, "creator.create");
  assert.equal(plan.serviceEpoch, "e".repeat(64));
  // An omitted baseVersion is pinned to the bound CLI version at preview time.
  assert.equal(plan.input.baseVersion, "0.2.0-rc.2");
  assert.equal(plan.input.modelSource, "local");
  assert.deepEqual(plan.steps.map((step) => step.step), ["prepare", "create", "plugin", "plugin", "start", "result"]);

  const execution = await call(fx, "createExecute", scope, { planId: plan.id, requestId: "req-factory-1" });
  assert.equal(execution.body.ok, true, JSON.stringify(execution.body));
  const job = execution.body.value as WorkbenchJob;
  assert.equal(job.kind, "creator.create");
  assert.equal(job.requestId, "req-factory-1");
  assert.deepEqual(job.affectedSpaceIds, ["space-factory"]);
  assert.equal(job.subject?.displayName, "Factory");

  const finished = await jobSettled(fx, scope, job.id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished.error));
  assert.equal(finished.result?.spaceId, "space-factory");
  const steps = finished.result?.steps ?? [];
  assert.deepEqual(steps.map((row) => [row.step, row.status]), [
    ["prepare", "done"], ["create", "done"], ["plugin", "done"], ["plugin", "done"], ["start", "done"], ["result", "done"],
  ]);
  assert.equal(steps[2]?.packageName, "dsh-plugin-a");
  assert.equal(steps[2]?.detail, "dsh-plugin-a@1.2.3");
  assert.equal(steps[3]?.packageName, "dsh-b");
  assert.equal(steps[3]?.detail, `klarkxy/dsh-plugins/plugins/dsh-b#${"a".repeat(40)}`);
  // A local-source space keeps its own models: no sync ran and no policy file exists.
  assert.equal(existsSync(join(home, "hub", "space-factory", "llm-policy.json")), false);
  assert.deepEqual(fx.created, ["space-factory"]);
  assert.deepEqual(fx.started, ["space-factory"]);
  assert.deepEqual(fx.installCalls, [
    "space-factory <- dsh-plugin-a@1.2.3",
    `space-factory <- github:klarkxy/dsh-plugins#${"a".repeat(40)}&path:/plugins/dsh-b`,
  ]);

  const replay = await call(fx, "createExecute", scope, { planId: plan.id, requestId: "req-factory-1" });
  assert.equal(replay.body.ok, true);
  assert.equal((replay.body.value as WorkbenchJob).id, finished.id);
  const clash = await call(fx, "createExecute", scope, { planId: "deadbeef-other-plan", requestId: "req-factory-1" });
  assert.equal(clash.body.ok, false);
  assert.equal(clash.body.error?.code, "creator/request-conflict");

  const consumed = await call(fx, "createExecute", scope, { planId: plan.id, requestId: "req-factory-2" });
  assert.equal(consumed.body.ok, false);
  assert.equal(consumed.body.error?.code, "creator/plan-consumed");

  const other = await call(fx, "job", scope, { jobId: "req-unknown" });
  assert.equal(other.body.ok, false);
  assert.equal(other.body.error?.code, "creator/not-found");
});

for (const missing of ["view-bridge"]) test(`preview rejects a missing linked ${missing} and never submits a job`, async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home, {
    hasComponent: (component) => {
      if (component === missing) {
        throw new WorkbenchPublicError("workbench/unavailable",
          `The selected ${missing} component is unavailable: the linked @dsh-spaces/${missing} source directory is missing.`);
      }
      return true;
    },
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;

  const preview = await call(fx, "createPreview", scope, { input: { name: "broken", icon: "whale", modelSource: "main" } });
  assert.equal(preview.body.ok, false, JSON.stringify(preview.body));
  assert.equal(preview.body.error?.code, "creator/unavailable");
  assert.ok(preview.body.error?.message?.includes(missing));
  assert.deepEqual(fx.jobs.list(), [], "no job was submitted");
  assert.deepEqual(fx.created, []);
});

test("a component that disappears between preview and execute fails the job at prepare", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  let viewBroken = false;
  const fx = makePorts(home, {
    hasComponent: (component) => {
      if (component === "view-bridge" && viewBroken) {
        throw new WorkbenchPublicError("workbench/unavailable",
          "The selected view-bridge component is unavailable: the linked @dsh-spaces/view-bridge source directory is missing.");
      }
      return true;
    },
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;

  const preview = await call(fx, "createPreview", scope, { input: { name: "fading", modelSource: "main" } });
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body));
  const plan = preview.body.value as CreatorPlan;
  assert.deepEqual(plan.steps.map((step) => step.step), ["prepare", "create", "view-bridge", "models-sync", "result"]);

  viewBroken = true;
  const execution = await call(fx, "createExecute", scope, { planId: plan.id, requestId: "req-fading-1" });
  assert.equal(execution.body.ok, true, JSON.stringify(execution.body));
  const finished = await jobSettled(fx, scope, (execution.body.value as WorkbenchJob).id);
  assert.equal(finished.status, "failed");
  const steps = finished.result?.steps ?? [];
  assert.deepEqual(steps.map((row) => [row.step, row.status]), [
    ["prepare", "failed"], ["create", "not-run"], ["view-bridge", "not-run"], ["models-sync", "not-run"], ["result", "not-run"],
  ]);
  assert.deepEqual(fx.created, [], "no profile was created");
  assert.equal(existsSync(join(home, "hub", "space-fading", "llm-policy.json")), false);
});

test("expired, stale-revision and foreign plans are refused; failures record partial progress", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  let now = Date.now();
  let revision = "rev-1";
  const fx = makePorts(home, {
    now: () => new Date(now),
    revision: () => revision,
    pluginAdd: async (_h, _p, spec) => {
      if (spec === "dsh-plugin-bad@1.0.0") throw new Error("install exploded");
    },
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;

  // Foreign plan ids are invisible.
  const foreign = await call(fx, "createExecute", scope, { planId: "00000000-0000-0000-0000-000000000000", requestId: "req-x" });
  assert.equal(foreign.body.ok, false);
  assert.equal(foreign.body.error?.code, "creator/not-found");

  const preview = await call(fx, "createPreview", scope, {
    input: { name: "half", plugins: [{ npm: { packageName: "dsh-plugin-bad", version: "1.0.0" } }] },
  });
  assert.equal(preview.body.ok, true);
  const plan = preview.body.value as CreatorPlan;

  // A changed state revision invalidates the preview before submission.
  revision = "rev-2";
  const stale = await call(fx, "createExecute", scope, { planId: plan.id, requestId: "req-stale" });
  assert.equal(stale.body.ok, false);
  assert.equal(stale.body.error?.code, "creator/request-conflict");
  revision = "rev-1";

  const execution = await call(fx, "createExecute", scope, { planId: plan.id, requestId: "req-half" });
  assert.equal(execution.body.ok, true);
  const finished = await jobSettled(fx, scope, (execution.body.value as WorkbenchJob).id);
  assert.equal(finished.status, "failed");
  const steps = finished.result?.steps ?? [];
  const byKind = Object.fromEntries(steps.map((row) => [row.step, row.status]));
  assert.equal(byKind["prepare"], "done");
  assert.equal(byKind["create"], "done");
  assert.equal(byKind["plugin"], "failed");
  assert.equal(byKind["result"], "not-run");
  assert.equal(steps.find((row) => row.step === "plugin")?.packageName, "dsh-plugin-bad");

  // An expired plan is refused at admission; the running job is unaffected.
  const next = await call(fx, "createPreview", scope, { input: { name: "late" } });
  assert.equal(next.body.ok, true);
  const latePlan = next.body.value as CreatorPlan;
  now += 6 * 60_000;
  const expired = await call(fx, "createExecute", scope, { planId: latePlan.id, requestId: "req-late" });
  assert.equal(expired.body.ok, false);
  assert.equal(expired.body.error?.code, "creator/plan-expired");
});

test("approved builds are written to the profile allowBuilds policy before install", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;
  const preview = await call(fx, "createPreview", scope, {
    input: {
      name: "builds",
      plugins: [{
        npm: {
          packageName: "dsh-plugin-build",
          version: "2.0.0",
          approvedBuilds: ["dsh-plugin-build", "dep@1.2.3"],
        },
      }],
    },
  });
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body));
  const execution = await call(fx, "createExecute", scope, {
    planId: (preview.body.value as CreatorPlan).id,
    requestId: "req-builds",
  });
  assert.equal(execution.body.ok, true);
  const finished = await jobSettled(fx, scope, (execution.body.value as WorkbenchJob).id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished.error));
  const policy = readFileSync(join(home, "profiles", "space-builds", "pnpm-workspace.yaml"), "utf8");
  assert.match(policy, /dangerouslyAllowAllBuilds: false/);
  assert.match(policy, /allowBuilds:/);
  assert.match(policy, /dsh-plugin-build: true/);
  assert.match(policy, /dep@1\.2\.3: true/);
});

test("a build-blocked install reports the exact pending allowBuilds keys", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home, {
    pluginAdd: async () => {
      throw new Error(
        `dsh plugin add failed (exit 1): ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED\n` +
        `allowBuilds:\n  github.com/org/dep: true\n`,
      );
    },
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;
  const preview = await call(fx, "createPreview", scope, {
    input: {
      name: "blocked",
      plugins: [{ github: { owner: "org", repo: "dep", commit: "b".repeat(40), packageName: "dep" } }],
    },
  });
  assert.equal(preview.body.ok, true);
  const execution = await call(fx, "createExecute", scope, {
    planId: (preview.body.value as CreatorPlan).id,
    requestId: "req-blocked",
  });
  assert.equal(execution.body.ok, true);
  const finished = await jobSettled(fx, scope, (execution.body.value as WorkbenchJob).id);
  assert.equal(finished.status, "failed");
  assert.match(finished.error?.message ?? "", /Pending builds awaiting approval: github\.com\/org\/dep/);
  const step = (finished.result?.steps ?? []).find((row) => row.step === "plugin");
  assert.equal(step?.status, "failed");
  assert.equal(step?.detail, `org/dep#${"b".repeat(40)}`);
});

test("the git subdirectory spec is the official pnpm form the rc1 parser accepts", async () => {
  // pnpm's git resolver (resolving/git-resolver parseGitParams) splits the
  // fragment on "&": every non-"path:"/non-"semver:" segment is the ref. The
  // only subdirectory form it understands is #<commit>&path:/<sub>.
  const emitted = `github:klarkxy/dsh-plugins#${"a".repeat(40)}&path:/plugins/dsh-b`;
  const parsed = parseInstallSpec(emitted);
  assert.equal(parsed.kind, "git");
  if (parsed.kind === "git") assert.equal(parsed.host, "github.com");

  // Mirror pnpm parseGitParams to prove the fragment decomposes to the pinned
  // commit plus the pinned subdirectory rather than a garbage ref.
  const committish = decodeURIComponent(new URL(`git+https://example.com/o/r.git${emitted.slice(emitted.indexOf("#"))}`).hash.slice(1));
  const segments = committish.split("&");
  const path = segments.find((part) => part.startsWith("path:"))?.slice(5);
  const ref = segments.find((part) => !part.startsWith("path:") && !part.startsWith("semver:"));
  assert.equal(path, "/plugins/dsh-b");
  assert.equal(ref, "a".repeat(40));
});

test("git readback verifies the pinned commit and subdirectory, not only the package name", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home, {
    pluginAdd: async (addedHome, profile, spec) => {
      // Simulate an install that resolved to a different commit: the recorded
      // dependency and lockfile carry the wrong pin and read-back must refuse it.
      const wrong = spec.replace("a".repeat(40), "b".repeat(40));
      const dir = join(addedHome, "profiles", profile, "node_modules", "dep");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "dep", version: "0.0.0" })}\n`);
      registerBundle(addedHome, profile, "dep", wrong);
      writeGitLockEntry(addedHome, profile, "dep", wrong);
    },
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;
  const preview = await call(fx, "createPreview", scope, {
    input: {
      name: "pin",
      plugins: [{ github: { owner: "org", repo: "dep", commit: "a".repeat(40), packageName: "dep" } }],
    },
  });
  assert.equal(preview.body.ok, true);
  const execution = await call(fx, "createExecute", scope, {
    planId: (preview.body.value as CreatorPlan).id,
    requestId: "req-pin",
  });
  assert.equal(execution.body.ok, true);
  const finished = await jobSettled(fx, scope, (execution.body.value as WorkbenchJob).id);
  assert.equal(finished.status, "failed");
  assert.match(finished.error?.message ?? "", /pinned source/);
});

test("git readback rejects a wrong repo with the same sha", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home, {
    pluginAdd: async (addedHome, profile, spec) => {
      const wrong = spec.replace("org/dep", "other/mirror");
      const dir = join(addedHome, "profiles", profile, "node_modules", "dep");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "dep", version: "0.0.0" })}\n`);
      registerBundle(addedHome, profile, "dep", wrong);
      writeGitLockEntry(addedHome, profile, "dep", wrong);
    },
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;
  const preview = await call(fx, "createPreview", scope, {
    input: { name: "mirror", plugins: [{ github: { owner: "org", repo: "dep", commit: "a".repeat(40), packageName: "dep" } }] },
  });
  assert.equal(preview.body.ok, true);
  const execution = await call(fx, "createExecute", scope, { planId: (preview.body.value as CreatorPlan).id, requestId: "req-mirror" });
  assert.equal(execution.body.ok, true);
  const finished = await jobSettled(fx, scope, (execution.body.value as WorkbenchJob).id);
  assert.equal(finished.status, "failed");
  assert.match(finished.error?.message ?? "", /pinned source/);
});

test("git readback rejects a subdirectory prefix that is not the pinned path", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home, {
    pluginAdd: async (addedHome, profile, spec) => {
      const wrong = spec.replace("path:/plugins/dsh-b", "path:/plugins/dsh-b-extra");
      const dir = join(addedHome, "profiles", profile, "node_modules", "dsh-b");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "dsh-b", version: "0.0.0" })}\n`);
      registerBundle(addedHome, profile, "dsh-b", wrong);
      writeGitLockEntry(addedHome, profile, "dsh-b", wrong);
    },
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;
  const preview = await call(fx, "createPreview", scope, {
    input: { name: "subdir", plugins: [{ github: { owner: "org", repo: "mono", commit: "a".repeat(40), path: "plugins/dsh-b", packageName: "dsh-b" } }] },
  });
  assert.equal(preview.body.ok, true);
  const execution = await call(fx, "createExecute", scope, { planId: (preview.body.value as CreatorPlan).id, requestId: "req-subdir" });
  assert.equal(execution.body.ok, true);
  const finished = await jobSettled(fx, scope, (execution.body.value as WorkbenchJob).id);
  assert.equal(finished.status, "failed");
  assert.match(finished.error?.message ?? "", /pinned source/);
});

test("git readback accepts the codeload lockfile form and a bare recorded spec", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home, {
    pluginAdd: async (addedHome, profile, spec) => {
      // Public-repo install: package.json records a bare repo URL while the
      // lockfile carries the codeload tarball resolution pnpm produces.
      const bare = spec.replace(/^(github:[^#]+|git\+[^#]+)#.*$/, "git+https://github.com/org/mono.git");
      const dir = join(addedHome, "profiles", profile, "node_modules", "dsh-b");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "dsh-b", version: "0.0.0" })}\n`);
      registerBundle(addedHome, profile, "dsh-b", bare);
      writeCodeloadLockEntry(addedHome, profile, "dsh-b", spec);
    },
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;
  const preview = await call(fx, "createPreview", scope, {
    input: {
      name: "public",
      plugins: [{ github: { owner: "org", repo: "mono", commit: "a".repeat(40), path: "plugins/dsh-b", packageName: "dsh-b" } }],
    },
  });
  assert.equal(preview.body.ok, true);
  const execution = await call(fx, "createExecute", scope, { planId: (preview.body.value as CreatorPlan).id, requestId: "req-public" });
  assert.equal(execution.body.ok, true);
  const finished = await jobSettled(fx, scope, (execution.body.value as WorkbenchJob).id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished.error));
  const step = (finished.result?.steps ?? []).find((row) => row.step === "plugin");
  assert.equal(step?.status, "done");
});

test("git readback accepts an ssh-repo lockfile resolution for a private repo", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home, {
    pluginAdd: async (addedHome, profile, spec) => {
      // Private-repo install: bare recorded spec, ssh-form lockfile resolution.
      const bare = "git+https://github.com/org/dep.git";
      const dir = join(addedHome, "profiles", profile, "node_modules", "dep");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "dep", version: "0.0.0" })}\n`);
      registerBundle(addedHome, profile, "dep", bare);
      const commit = "a".repeat(40);
      writeFileSync(
        join(addedHome, "profiles", profile, "pnpm-lock.yaml"),
        `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      dep:\n        specifier: '${bare}'\n        version: 'git@github.com:org/dep.git#${commit}'\n\nsnapshots:\n  dep@git@github.com:org/dep.git#${commit}:\n    resolution: {commit: '${commit}', repo: 'git@github.com:org/dep.git', type: git}\n`,
      );
    },
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;
  const preview = await call(fx, "createPreview", scope, {
    input: { name: "private", plugins: [{ github: { owner: "org", repo: "dep", commit: "a".repeat(40), packageName: "dep" } }] },
  });
  assert.equal(preview.body.ok, true);
  const execution = await call(fx, "createExecute", scope, { planId: (preview.body.value as CreatorPlan).id, requestId: "req-private" });
  assert.equal(execution.body.ok, true);
  const finished = await jobSettled(fx, scope, (execution.body.value as WorkbenchJob).id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished.error));
});

test("a registration bound to the previous epoch loses every scoped op and its plans", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  let epoch = "e".repeat(64);
  const fx = makePorts(home, { epoch });
  (fx.ports as { currentServiceEpoch: () => string }).currentServiceEpoch = () => epoch;
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.creator!;
  const preview = await call(fx, "createPreview", scope, { input: { name: "turn" } });
  assert.equal(preview.body.ok, true);

  epoch = "f".repeat(64);
  const staleContext = await call(fx, "context", scope, {});
  assert.equal(staleContext.status, 401);
  const staleExecute = await call(fx, "createExecute", scope, { planId: (preview.body.value as CreatorPlan).id, requestId: "req-turn" });
  assert.equal(staleExecute.status, 401);
});

test("a closed previous identity listener allows a dead-host reclaim", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  const events: string[] = [];
  (fx.ports as { diagnosticLog?: unknown }).diagnosticLog = {
    info: (event: string) => events.push(event),
    error: () => undefined,
  };
  await serve(fx);
  const firstListener = await startIdentityServer({ home, profile: "web" });
  const first = await issue(fx, firstListener);
  await firstListener.close();
  const secondListener = await startIdentityServer({ home, profile: "web" });
  const second = await issue(fx, secondListener);
  assert.notEqual(second.registrationId, first.registrationId);
  const stale = await call(fx, "context", first.scopes.creator!, {});
  assert.equal(stale.status, 401);
  assert.equal(events.includes("creator.reclaimed-dead-host"), true);
});

test("a live previous identity listener keeps the registration conflict", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const firstListener = await startIdentityServer({ home, profile: "web" });
  await issue(fx, firstListener);
  const secondListener = await startIdentityServer({ home, profile: "web" });
  const denied = await call(fx, "issue", HOST_BEARER, {
    origin: secondListener.origin,
    bearer: secondListener.bearer,
    home: fx.home,
    profile: "web",
  });
  assert.equal(denied.body.error?.code, "creator/conflict");
});

test("a previous origin that rejects the old bearer is reclaimed as dead", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const control: IdentityControl = {};
  const firstListener = await startIdentityServer({ home, profile: "web" }, control);
  const first = await issue(fx, firstListener);
  control.bearer = "d".repeat(64);
  const secondListener = await startIdentityServer({ home, profile: "web" });
  const second = await issue(fx, secondListener);
  assert.notEqual(second.registrationId, first.registrationId);
});

test("a hanging previous identity probe remains a conflict", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const control: IdentityControl = {};
  const firstListener = await startIdentityServer({ home, profile: "web" }, control);
  await issue(fx, firstListener);
  control.mode = "hold";
  const secondListener = await startIdentityServer({ home, profile: "web" });
  const started = Date.now();
  const denied = await call(fx, "issue", HOST_BEARER, {
    origin: secondListener.origin,
    bearer: secondListener.bearer,
    home: fx.home,
    profile: "web",
  });
  assert.equal(denied.body.error?.code, "creator/conflict");
  assert.ok(Date.now() - started >= 1_400, "the hung probe must wait for its bounded timeout");
});

test("unregister retires shared registration state through the cleanup hook", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const retired: string[] = [];
  fx.ports.onRegistrationRetired = (registrationId) => retired.push(registrationId);
  const result = await call(fx, "unregister", HOST_BEARER, { registrationId: issued.registrationId });
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  assert.deepEqual(retired, [issued.registrationId]);
});

test("an unregister during the previous-host probe does not become a false conflict", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const control: IdentityControl = { status: 500 };
  const firstListener = await startIdentityServer({ home, profile: "web" }, control);
  const first = await issue(fx, firstListener);
  control.mode = "hold";
  let probeSeen = false;
  const secondListener = await startIdentityServer({ home, profile: "web" });
  const secondPromise = call(fx, "issue", HOST_BEARER, {
    origin: secondListener.origin,
    bearer: secondListener.bearer,
    home: fx.home,
    profile: "web",
  });
  for (let i = 0; i < 100 && !control.release; i += 1) await delay(10);
  probeSeen = Boolean(control.release);
  assert.equal(probeSeen, true, "the reclaim probe reached the previous identity listener");
  const unregistered = await call(fx, "unregister", HOST_BEARER, { registrationId: first.registrationId });
  assert.equal(unregistered.body.ok, true, JSON.stringify(unregistered.body));
  control.release!();
  const second = await secondPromise;
  assert.equal(second.body.ok, true, JSON.stringify(second.body));
  assert.notEqual((second.body.value as CreatorIssueResult).registrationId, first.registrationId);
});

test("a previous identity server error remains a conflict instead of a reclaim", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const control: IdentityControl = {};
  const firstListener = await startIdentityServer({ home, profile: "web" }, control);
  await issue(fx, firstListener);
  control.mode = "status";
  control.status = 500;
  const secondListener = await startIdentityServer({ home, profile: "web" });
  const denied = await call(fx, "issue", HOST_BEARER, {
    origin: secondListener.origin,
    bearer: secondListener.bearer,
    home: fx.home,
    profile: "web",
  });
  assert.equal(denied.body.error?.code, "creator/conflict");
});
