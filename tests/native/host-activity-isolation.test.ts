import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_MANAGER_FILE,
} from "../../src/adapters/node/home/home-lease.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";
import { SpacesPlugin } from "../../packages/plugin/src/host/plugin.ts";
import { WorkbenchHostRuntime, type WorkbenchHostRuntimeOptions } from "../../packages/plugin/src/host/runtime.ts";

/**
 * Plugin-level regression of the host activity gate and state lifecycle.
 *
 * `tests/native/host-activity.test.ts` already pins the basic wiring matrix
 * (web trusted, notes untrusted, desktop trusted). This file complements it
 * with the identities that matrix does not exercise — the manager profile
 * and an unconfirmed invocation — plus the full live state transition
 * lifecycle and degraded-dimension independence end to end through the
 * plugin surface. Everything runs against throwaway temp Homes; nothing
 * touches a real profile, server or browser.
 */

const temps: string[] = [];
const contexts: Context[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try { await ctx.fiber.dispose(); } catch { /* isolation */ }
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeProfile(home: string, name: string): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `dsh-profile-${name}` })}\n`);
}

function writeManager(home: string, profileId: string): void {
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(
    join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE),
    `${JSON.stringify({ version: 1, profileId, createdAt: "2026-11-07T00:00:00.000Z" })}\n`,
  );
}

function writeCli(home: string): string {
  const pkg = join(home, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version: COMPATIBLE_DSH_CLI_VERSION })}\n`);
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "export {};\n");
  return bin;
}

function runtimeOptions(home: string, profile: string): WorkbenchHostRuntimeOptions {
  const bin = writeCli(home);
  return {
    home,
    allowRealHome: false,
    argv: [process.execPath, bin, "--profile", profile],
    env: { DSH_HOME: home },
    execPath: process.execPath,
    baseUrl: `${pathToFileURL(join(home, "profiles", profile)).href}/`,
    supervisorTimeoutMs: 2000,
    // Construction-time background launches must never spawn: report one plain
    // deterministic failure instead.
    bootstrap: async () => ({ connected: false, origin: null, reasons: ["test isolation: no spawn"] }),
  };
}

function pluginContext(): Context {
  const ctx = new Context();
  contexts.push(ctx);
  return ctx;
}

/** Mutable live-state doubles behind the exact service faces the sampler reads. */
interface LiveHostState {
  events: readonly { event: string; agentId: unknown }[];
  sessions: readonly unknown[];
  questionActive: unknown[];
  agents: readonly { status?: unknown }[];
}
function provideHostServices(ctx: Context, state: LiveHostState): void {
  ctx.provide("typertGateway", { getPendingRemoteEvents: () => state.events } as never);
  ctx.provide("sessions", { list: () => state.sessions } as never);
  ctx.provide("sessionProjections", { snapshot: () => ({ values: { userQuestions: { active: state.questionActive, settled: [] } } }) } as never);
  ctx.provide("agents", { list: () => state.agents } as never);
}

const idle: LiveHostState = { events: [], sessions: [], questionActive: [], agents: [] };

test("the trusted main host reports the full live state lifecycle and withdraws every state", async () => {
  const home = tempDir("dsh-glow-life-");
  writeProfile(home, "web");
  const ctx = pluginContext();
  const state: LiveHostState = { ...idle };
  provideHostServices(ctx, state);
  const plugin = new SpacesPlugin(ctx, {}, new WorkbenchHostRuntime(runtimeOptions(home, "web")));
  assert.equal(plugin.runtime.isTrustedMainHost, true);

  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "none", working: "idle" }, "a quiet main host reads quiet");

  state.agents = [{ status: "running" }];
  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "none", working: "busy" }, "a running agent lights the green half");

  state.events = [{ event: "approval/request", agentId: "s-1" }];
  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "required", working: "busy" }, "a pending approval lights the yellow half");

  state.events = [];
  state.sessions = [{ id: "s-1" }];
  state.questionActive = [{ callId: "c-1" }];
  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "required", working: "busy" }, "an answerable question card lights the yellow half");

  state.questionActive = [];
  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "none", working: "busy" }, "a settled card withdraws the yellow half");

  state.agents = [];
  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "none", working: "idle" }, "a finished turn withdraws the green half");

  state.agents = [{ status: "running" }];
  state.events = [{ event: "approval/request", agentId: "s-1" }];
  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "required", working: "busy" },
    "raw halves report together; the client owns yellow-first composition");
});

test("the manager profile never projects activity even when its own host reads busy", async () => {
  const home = tempDir("dsh-glow-manager-");
  writeProfile(home, "spaces-hub");
  writeManager(home, "spaces-hub");
  const ctx = pluginContext();
  const state: LiveHostState = { ...idle, agents: [{ status: "running" }], events: [{ event: "approval/request", agentId: "s-1" }] };
  provideHostServices(ctx, state);
  const plugin = new SpacesPlugin(ctx, {}, new WorkbenchHostRuntime(runtimeOptions(home, "spaces-hub")));
  assert.equal(plugin.runtime.identity.role, "manager");
  assert.equal(plugin.runtime.isTrustedMainHost, false);
  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "unknown", working: "unknown" },
    "the manager profile gets no sampler: unknown, never its own real state");
});

test("an unconfirmed invocation never projects activity", async () => {
  const home = tempDir("dsh-glow-foreign-");
  writeProfile(home, "web");
  writeProfile(home, "other");
  const ctx = pluginContext();
  const state: LiveHostState = { ...idle, agents: [{ status: "running" }] };
  provideHostServices(ctx, state);
  // The loader baseUrl points at a different profile than the invocation: the
  // identity cannot be confirmed, so no projection may exist at all.
  const options = runtimeOptions(home, "web");
  options.baseUrl = `${pathToFileURL(join(home, "profiles", "other")).href}/`;
  const plugin = new SpacesPlugin(ctx, {}, new WorkbenchHostRuntime(options));
  assert.equal(plugin.runtime.identity.confirmed, false);
  assert.equal(plugin.runtime.isTrustedMainHost, false);
  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "unknown", working: "unknown" });
});

test("on the trusted host one degraded dimension never masks the other end to end", async () => {
  const home = tempDir("dsh-glow-degraded-");
  writeProfile(home, "web");
  const ctx = pluginContext();
  // Only the agents face exists: working is knowable, attention is not.
  ctx.provide("agents", { list: () => [{ status: "running" }] } as never);
  const plugin = new SpacesPlugin(ctx, {}, new WorkbenchHostRuntime(runtimeOptions(home, "web")));
  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "unknown", working: "busy" },
    "missing attention services stay unknown while real work still reports");
});

test("a trusted host without any session services reports unknown, never none or idle by default", async () => {
  const home = tempDir("dsh-glow-unserved-");
  writeProfile(home, "web");
  const ctx = pluginContext();
  const plugin = new SpacesPlugin(ctx, {}, new WorkbenchHostRuntime(runtimeOptions(home, "web")));
  assert.equal(plugin.runtime.isTrustedMainHost, true);
  assert.deepEqual(await plugin.guide.hostActivity(), { attention: "unknown", working: "unknown" },
    "absent services are never guessed as a quiet host");
});
