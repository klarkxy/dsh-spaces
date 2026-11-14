import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildRemoteClient } from "../../src/adapters/node/supervisor/child-remote.ts";
import type { WorkbenchJobContext, WorkbenchJobResult } from "../../src/adapters/node/maintenance/workbench-jobs.ts";
import { runLiveModelSync } from "../../src/adapters/node/llm/live-model-sync.ts";
import { summarizeSnapshot, type MainModelSnapshot, type PreparedMainModelSync } from "../../src/adapters/node/llm/main-model-sync.ts";
import { diagnosticOperation } from "../../src/adapters/node/diagnostics/operation-log.ts";
import type { DiagnosticLogger } from "../../src/adapters/node/diagnostics/rotating-log.ts";

function prepared(patch: Partial<MainModelSnapshot> = {}): PreparedMainModelSync {
  const snapshot: MainModelSnapshot = {
    providers: { gw: { baseURL: "http://127.0.0.1:9/v1", apiKeyEnv: "GW_KEY" } },
    deepseek: false,
    refs: { GW_KEY: "gw-secret" },
    records: {},
    skipped: [],
    missingCredentials: [],
    defaultModel: { provider: "gw", model: "gw-large", reasoningEffort: "high" },
    ...patch,
  };
  return { summary: summarizeSnapshot("web", snapshot), snapshot, apply: async () => summarizeSnapshot("web", snapshot) };
}

function context() {
  const messages: string[] = [];
  const results: WorkbenchJobResult[] = [];
  const ctx = {
    signal: new AbortController().signal,
    phase: () => undefined,
    message: (message: string) => { messages.push(message); },
    cancellable: () => undefined,
    result: (result: WorkbenchJobResult) => { results.push(result); },
  } as WorkbenchJobContext;
  return { ctx, messages, results };
}

function fixture(snapshot: MainModelSnapshot, options: { missingNamespaces?: boolean; badCredential?: string } = {}) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const settings: { writable: boolean; namespaces: Array<{ ns: string; value: any; revision: number }> } = {
    writable: true,
    namespaces: options.missingNamespaces ? [] : [
      { ns: "llm-pi-ai", value: { providers: { mine: { baseURL: "http://127.0.0.1:7/v1" } } }, revision: 1 },
      { ns: "llm-deepseek-api-key", value: {}, revision: 2 },
      { ns: "agent-default-model", value: { provider: "old", model: "old" }, revision: 3 },
    ],
  };
  const credentials = Object.fromEntries(Object.keys(snapshot.refs).map((ref) => [ref, { configured: false, writable: true }]));
  const merge = (left: any, right: any): any => {
    if (right === undefined) return left;
    if (left === undefined) return right;
    if (!left || typeof left !== "object" || Array.isArray(left) || !right || typeof right !== "object" || Array.isArray(right)) return right;
    return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => [key, merge(left[key], right[key])]));
  };
  const client = {
    call: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args });
      if (method === "settings/describe") return settings;
      if (method === "credentials/describe") {
        const refs = args.refs as string[];
        return Object.fromEntries(refs.map((ref) => [ref, credentials[ref] ?? { configured: false, writable: false }]));
      }
      if (method === "credentials/set") {
        const ref = String(args.ref);
        credentials[ref] = { configured: ref !== options.badCredential, writable: true };
        return undefined;
      }
      const ns = String(args.ns);
      const view = settings.namespaces.find((row) => row.ns === ns);
      if (!view) throw new Error(`missing ${ns}`);
      if (method === "settings/update") {
        view.value = merge(view.value, args.patch);
        view.revision++;
        return view;
      }
      if (method === "settings/mutate") {
        for (const op of args.ops as Array<{ path: string[]; value: unknown }>) {
          view.value.providers[op.path[1]!] = op.value;
        }
        view.revision++;
        return view;
      }
      if (method === "settings/replace") {
        view.value = args.section;
        view.revision++;
        return view;
      }
      throw new Error(`unexpected method ${method}`);
    },
  } as unknown as ChildRemoteClient;
  return { calls, client, settings, credentials };
}

test("running sync writes and reads back keys, routes, DeepSeek settings and the default", async () => {
  const input = prepared({
    deepseek: true,
    deepseekConfig: { apiKeyEnv: "DEEPSEEK_API_KEY" },
    refs: { GW_KEY: "gw-secret", DEEPSEEK_API_KEY: "deepseek-secret" },
  });
  const fx = fixture(input.snapshot);
  const { ctx, messages, results } = context();
  const result = await runLiveModelSync(fx.client, input, "space-a", ctx);
  assert.ok(result);
  assert.ok(result.steps?.every((step) => step.status === "done"));
  assert.equal(fx.settings.namespaces.find((row) => row.ns === "llm-pi-ai")?.value.providers.mine.baseURL, "http://127.0.0.1:7/v1");
  assert.equal(fx.settings.namespaces.find((row) => row.ns === "llm-pi-ai")?.value.providers.gw.baseURL, "http://127.0.0.1:9/v1");
  assert.ok(fx.calls.some((call) => call.method === "settings/replace" && call.args.ns === "agent-default-model" && call.args.expectedRevision === 3));
  assert.ok(fx.calls.some((call) => call.method === "settings/update" && call.args.ns === "llm-deepseek-api-key"));
  assert.equal(JSON.stringify(result).includes("gw-secret"), false);
  assert.equal(JSON.stringify(result).includes("deepseek-secret"), false);
  assert.equal(messages.join("\n").includes("gw-secret"), false);
  assert.equal(results.at(-1)?.steps?.every((step) => step.status === "done"), true);
});

test("a live readback failure records written, failed and not-run items without secrets", async () => {
  const input = prepared({
    refs: { GOOD: "good-secret", BAD: "bad-secret", LATER: "later-secret" },
  });
  const fx = fixture(input.snapshot, { badCredential: "BAD" });
  const { ctx, results } = context();
  let failure: Error | undefined;
  await assert.rejects(runLiveModelSync(fx.client, input, "space-a", ctx), (error) => {
    failure = error as Error;
    return true;
  });
  assert.match(failure?.message ?? "", /written: credential:GOOD/);
  assert.match(failure?.message ?? "", /not written: credential:BAD, credential:LATER, settings:llm-pi-ai, settings:agent-default-model/);
  assert.equal(failure?.message.includes("good-secret"), false);
  assert.equal(failure?.message.includes("bad-secret"), false);
  assert.equal(fx.calls.some((call) => call.method === "credentials/set" && call.args.ref === "LATER"), false);
  assert.deepEqual(results.at(-1)?.steps?.map((step) => step.status), ["done", "failed", "not-run", "not-run", "not-run"]);
});

test("a missing settings namespace refuses before any write", async () => {
  const input = prepared();
  const fx = fixture(input.snapshot, { missingNamespaces: true });
  const { ctx, results } = context();
  await assert.rejects(runLiveModelSync(fx.client, input, "space-a", ctx), /No model settings were written|no configurable model namespace/);
  assert.equal(fx.calls.some((call) => call.method === "credentials/set" || call.method === "settings/update" || call.method === "settings/replace"), false);
  assert.ok(results.at(-1)?.steps?.every((step) => step.status === "not-run"));
});

test("provider credential records fail before the running write path", async () => {
  const input = prepared({ records: { "llm-pi-ai/gw": { kind: "api-key", key: "record-secret" } } });
  const fx = fixture(input.snapshot);
  const { ctx } = context();
  await assert.rejects(runLiveModelSync(fx.client, input, "space-a", ctx), /running settings API cannot copy/);
  assert.equal(fx.calls.length, 0);
});

test("live sync replaces a same-named route and rejects a stale configuration readback", async () => {
  const input = prepared();
  const fx = fixture(input.snapshot);
  const value = fx.settings.namespaces.find(row => row.ns === "llm-pi-ai")!.value;
  value.providers.gw = { baseURL: "https://old.example/v1", headers: { stale: "old" } };
  await runLiveModelSync(fx.client, input, "space-a", context().ctx);
  assert.deepEqual(value.providers.gw, input.snapshot.providers.gw);
  assert.ok(value.providers.mine);
  const stale = fixture(input.snapshot);
  stale.settings.namespaces.find(row => row.ns === "llm-pi-ai")!.value.providers.gw = { baseURL: "https://old.example/v1" };
  const call = stale.client.call.bind(stale.client);
  stale.client.call = async (method, args, signal) => method === "settings/mutate" ? undefined : call(method, args, signal);
  await assert.rejects(runLiveModelSync(stale.client, input, "space-a", context().ctx), /did not read back model route gw/);
  assert.equal(stale.calls.some(row => row.method === "settings/replace"), false);
});

test("a provider refusal cannot put a raw model key in diagnostic logs", async () => {
  const input = prepared();
  const errors: unknown[] = [];
  const log = {
    debug: () => true, info: () => true,
    error: (_event: string, _message: string, error: unknown) => { errors.push(error); return true; },
  } as unknown as DiagnosticLogger;
  const client = { call: async () => { throw new Error(`refused ${input.snapshot.refs.GW_KEY}`); } } as unknown as ChildRemoteClient;
  await assert.rejects(diagnosticOperation(log, "models.sync", {}, () => runLiveModelSync(client, input, "space-a", context().ctx)), /refused/);
  assert.equal(errors.length, 1);
  assert.equal(String(errors[0]).includes("gw-secret"), false);
});
