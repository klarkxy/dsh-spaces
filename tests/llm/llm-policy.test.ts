import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { WorkbenchPublicError } from "../../src/adapters/node/supervisor/errors.ts";
import {
  llmPolicyPath,
  parseSpaceLlmPolicy,
  readSpaceLlmPolicy,
  writeSpaceLlmPolicy,
} from "../../src/adapters/node/llm/llm-policy-store.ts";
import { SupervisorSpaceCommands } from "../../src/adapters/node/supervisor/space-commands.ts";
import { HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock.ts";
import { ProfileRegistry } from "../../src/adapters/node/profile/profile-registry.ts";
import { apply as applySpaceBridge } from "../../packages/llm-bridge/src/plugin.ts";

const homes: string[] = [];
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });
const tempHome = () => { const dir = mkdtempSync(join(tmpdir(), "dsh-llm-policy-")); homes.push(dir); return dir; };

test("policy parses strictly: exact keys, schemaVersion 1 and boolean inheritMain", () => {
  assert.deepEqual(parseSpaceLlmPolicy({ schemaVersion: 1, inheritMain: true }), { inheritMain: true });
  assert.deepEqual(parseSpaceLlmPolicy({ schemaVersion: 1, inheritMain: false }), { inheritMain: false });
  for (const bad of [
    {},
    { schemaVersion: 1 },
    { schemaVersion: 2, inheritMain: true },
    { schemaVersion: "1", inheritMain: true },
    { schemaVersion: 1, inheritMain: "true" },
    { schemaVersion: 1, inheritMain: true, extra: 1 },
    { inheritMain: true },
    null,
    "x",
  ]) {
    assert.throws(() => parseSpaceLlmPolicy(bad));
  }
});

test("absent policy means no inheritance; invalid content throws and is left alone", () => {
  const home = tempHome();
  assert.deepEqual(readSpaceLlmPolicy(home, "space-x"), { inheritMain: false });
  const path = llmPolicyPath(home, "space-x");
  mkdirSync(join(home, "hub", "space-x"), { recursive: true });
  writeFileSync(path, "{broken");
  assert.throws(() => readSpaceLlmPolicy(home, "space-x"));
  assert.equal(readFileSync(path, "utf8"), "{broken");
});

test("write produces exactly the minimal policy once and refuses to overwrite", () => {
  const home = tempHome();
  writeSpaceLlmPolicy(home, "space-a", true);
  assert.equal(readFileSync(llmPolicyPath(home, "space-a"), "utf8"), `${JSON.stringify({ schemaVersion: 1, inheritMain: true }, null, 2)}\n`);
  assert.deepEqual(readSpaceLlmPolicy(home, "space-a"), { inheritMain: true });
  assert.throws(() => writeSpaceLlmPolicy(home, "../evil", true));
});

type JobCtx = { phase(name: string): void; message(text: string): void; cancellable(flag: boolean): void };
const jobCtx = (): JobCtx & { phases: string[] } => ({
  phases: [] as string[],
  phase(name: string) { this.phases.push(name); },
  message() {},
  cancellable() {},
});

function commandsHost(home: string, created: string[], bridged: string[]) {
  const spaces = { create: async (input: { name: string }, _recipe: unknown) => { const id = `space-${created.length + 1}`; created.push(input.name); return { id }; } };
  return {
    home,
    bases: { prepare: async () => ({ base: "web" }) },
    lock: new HomeOperationLock(home),
    registry: new ProfileRegistry(home),
    options: {},
    cli: () => null,
    spaces: () => spaces,
    requireSpace: (id: string) => id,
    protectSpecial: () => {},
    ensureViewBridge: async () => {},
    ensureLlmBridge: async (id: string) => { bridged.push(id); },
    hasComponent: () => false,
  };
}

test("createSpace modelSource main writes the inherit policy once; local writes none", async () => {
  const home = tempHome();
  const created: string[] = [], bridged: string[] = [];
  const host = commandsHost(home, created, bridged);
  const commands = new SupervisorSpaceCommands(host as never);
  const main = await commands.createSpace({ name: "main-model", modelSource: "main" }, jobCtx() as never);
  const local = await commands.createSpace({ name: "local-model", modelSource: "local" }, jobCtx() as never);
  const none = await commands.createSpace({ name: "no-choice" }, jobCtx() as never);
  assert.equal(readFileSync(llmPolicyPath(home, (main as { spaceId: string }).spaceId), "utf8"),
    `${JSON.stringify({ schemaVersion: 1, inheritMain: true }, null, 2)}\n`);
  assert.equal(existsSync(llmPolicyPath(home, (local as { spaceId: string }).spaceId)), false);
  assert.equal(existsSync(llmPolicyPath(home, (none as { spaceId: string }).spaceId)), false);
  assert.deepEqual(bridged, [(main as { spaceId: string }).spaceId]);
});

test("createSpace refuses during prepare when a required component is unavailable", async () => {
  const home = tempHome();
  const created: string[] = [], bridged: string[] = [];
  const host = {
    ...commandsHost(home, created, bridged),
    hasComponent: (component: string) => {
      throw new WorkbenchPublicError("workbench/unavailable",
        `The selected ${component} component is unavailable: the linked @dsh-spaces/${component} source directory is missing.`);
    },
  };
  const commands = new SupervisorSpaceCommands(host as never);
  const ctx = jobCtx();
  const failure = await commands.createSpace({ name: "blocked", modelSource: "main", icon: "whale" }, ctx as never)
    .then(() => undefined, (error: unknown) => error as WorkbenchPublicError);
  assert.equal(failure?.code, "workbench/unavailable");
  assert.match(String(failure?.message), /view-bridge/);
  assert.deepEqual(ctx.phases, ["prepare"], "the refusal happens in prepare, before the create phase");
  assert.deepEqual(created, [], "no space was created");
  assert.deepEqual(bridged, []);
  assert.equal(existsSync(llmPolicyPath(home, "space-blocked")), false, "no policy was written");
});

test("createSpace accepts a custom icon on the ordinary path", async () => {
  const home = tempHome();
  const created: string[] = [], bridged: string[] = [];
  const host = commandsHost(home, created, bridged);
  const commands = new SupervisorSpaceCommands(host as never);
  const icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const result = await commands.createSpace({ name: "custom", modelSource: "main", icon }, jobCtx() as never);
  assert.deepEqual(created, ["custom"]);
  assert.equal((result as { spaceId: string }).spaceId, "space-1");
  assert.equal(host.registry.readSpaces().meta["space-1"].icon, icon);
  assert.deepEqual(readSpaceLlmPolicy(home, "space-1"), { inheritMain: true });
  assert.deepEqual(bridged, ["space-1"]);
});

function ctxWithDefaults(override: Record<string, unknown> | undefined): Context {
  const ctx = new Context() as Context & { configEditor?: { configuration(): unknown } };
  ctx.configEditor = {
    configuration: () =>
      override === undefined
        ? []
        : [{ entry: { options: { id: "agent-default-model" } }, override }],
  };
  return ctx;
}

const thisArg = { entry: { options: { id: "agent-default-model" } } };

test("bridge projects spaces-main default only when inheriting and no persisted default", async () => {
  const env = { DSH_SPACES_LLM_INHERIT_MAIN: "1" } as NodeJS.ProcessEnv;
  const ctx = ctxWithDefaults(undefined);
  try {
    applySpaceBridge(ctx, undefined, env);
    const projected = ctx.waterfall(thisArg as never, "internal/config", {}, () => ({}));
    assert.deepEqual(projected, { provider: "spaces-main", model: "default" });
  } finally { await ctx.fiber.dispose(); }
});

test("a persisted space default is never overwritten by the inherit projection", async () => {
  const env = { DSH_SPACES_LLM_INHERIT_MAIN: "1" } as NodeJS.ProcessEnv;
  const persisted = { provider: "own", model: "m1" };
  const ctx = ctxWithDefaults(persisted);
  try {
    applySpaceBridge(ctx, undefined, env);
    const result = ctx.waterfall(thisArg as never, "internal/config", { provider: "own", model: "m1" }, () => ({ provider: "own", model: "m1" }));
    assert.deepEqual(result, persisted);
  } finally { await ctx.fiber.dispose(); }
});

test("without the inherit flag the projection leaves the default alone", async () => {
  const ctx = ctxWithDefaults(undefined);
  try {
    applySpaceBridge(ctx, undefined, {} as NodeJS.ProcessEnv);
    const result = ctx.waterfall(thisArg as never, "internal/config", {}, () => ({}));
    assert.deepEqual(result, {});
  } finally { await ctx.fiber.dispose(); }
});
