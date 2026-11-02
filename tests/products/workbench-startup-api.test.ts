import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import type { SupervisorEndpoint } from "../../src/adapters/node/home/supervisor-endpoint.ts";
import { WORKBENCH_API, WORKBENCH_API_METHODS } from "../../src/shared/workbench.ts";
import { createWorkbenchRemote } from "../../packages/plugin/src/client/workbench-remote.ts";
import { WORKBENCH_API_CODECS } from "../../packages/plugin/src/host/workbench-api.ts";
import { createWorkbenchHttpClient, WORKBENCH_HTTP_METHODS } from "../../packages/plugin/src/host/workbench-http.ts";
import { WorkbenchManagerHost } from "../../packages/plugin/src/host/workbench-manager.ts";
import type { WorkbenchHostRuntime } from "../../packages/plugin/src/host/runtime.ts";
import { workbenchStartupStatusSchema } from "../../packages/plugin/src/host/workbench-schemas.ts";
import { TYPERT } from "../../packages/plugin/src/typert.host.ts";
import type { WorkbenchStartupStatus } from "../../packages/plugin/src/types.ts";

const EPOCH = "ab".repeat(32);
const ORIGIN = "http://127.0.0.1:9";
const BEARER = "B".repeat(32);

const endpoint: SupervisorEndpoint = {
  origin: ORIGIN,
  bearer: BEARER,
  protocolVersion: 2,
  homeId: EPOCH,
  serviceEpoch: EPOCH,
};

const preparing: WorkbenchStartupStatus = {
  serviceEpoch: "",
  managerId: null,
  phase: "preparing",
  reasons: [],
  failure: null,
};

const failed: WorkbenchStartupStatus = {
  serviceEpoch: EPOCH,
  managerId: "spaces-hub",
  phase: "failed",
  reasons: ["PRIMARY_START_FAILURE", "Cleanup: SECOND_STOP_FAILURE"],
  failure: {
    stage: "start",
    primaryReason: "PRIMARY_START_FAILURE",
    cleanupReason: "SECOND_STOP_FAILURE",
    instanceRetained: true,
  },
};

test("startupStatus is a readonly optional canonical method", () => {
  assert.equal(WORKBENCH_API.startupStatus.optional, true);
  assert.equal(WORKBENCH_API.startupStatus.args.length, 0);
  const methods = WORKBENCH_API_METHODS as readonly string[];
  assert.equal(methods[methods.indexOf("state") + 1], "startupStatus");
  assert.deepEqual(WORKBENCH_HTTP_METHODS, WORKBENCH_API_METHODS);
  assert.deepEqual(WORKBENCH_API_CODECS.startupStatus.params, {});
  assert.equal(
    WORKBENCH_API_CODECS.startupStatus.result.typeSymbol,
    "@dsh-spaces/plugin/types#WorkbenchStartupStatus",
  );
  const names = TYPERT.invocations.map((row) => `${row.namespace}/${row.method}`);
  assert.equal(names[names.indexOf("workbench/state") + 1], "workbench/startupStatus");
  const row = TYPERT.invocations.find((item) => item.method === "startupStatus");
  assert.equal(row?.parameters.length, 0);
});

test("startup status codec accepts published bounds and rejects extras", () => {
  assert.deepEqual(workbenchStartupStatusSchema.parse(preparing), preparing);
  assert.deepEqual(workbenchStartupStatusSchema.parse(failed), failed);
  const rejected = [
    { ...failed, paths: ["C:/secret"] },
    { ...failed, cause: { message: "raw" } },
    { ...failed, failure: { ...failed.failure, cause: new Error("raw") } },
    { ...failed, failure: { ...failed.failure, stage: "s".repeat(65) } },
    { ...failed, failure: { ...failed.failure, primaryReason: "p".repeat(221) } },
    { ...failed, failure: { ...failed.failure, cleanupReason: "c".repeat(221) } },
    { ...failed, phase: "crashed" },
    { ...failed, managerId: "../web" },
    { ...failed, serviceEpoch: "abc" },
    { ...failed, reasons: ["x".repeat(501)] },
    { ...failed, reasons: Array.from({ length: 33 }, (_unused, index) => `reason-${index}`) },
    { serviceEpoch: "", managerId: null, phase: "preparing", reasons: [] },
  ];
  for (const value of rejected) {
    assert.equal(workbenchStartupStatusSchema.safeParse(value).success, false, JSON.stringify(value));
  }
});

test("host client calls startupStatus with no arguments", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = createWorkbenchHttpClient({
    endpoint,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, value: preparing }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const startupStatus = api.startupStatus;
  if (!startupStatus) throw new Error("startupStatus is missing");
  assert.deepEqual(await startupStatus(), preparing);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${ORIGIN}/api/workbench/startupStatus`);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.body, "{}");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${BEARER}`);
});

test("host client rejects a startup status that carries a raw field", async () => {
  const api = createWorkbenchHttpClient({
    endpoint,
    fetch: async () => new Response(JSON.stringify({ ok: true, value: { ...failed, paths: ["C:/secret"] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  const startupStatus = api.startupStatus;
  if (!startupStatus) throw new Error("startupStatus is missing");
  await assert.rejects(
    () => startupStatus(),
    (error: unknown) => error instanceof RemoteError && error.code === "workbench/unavailable",
  );
});

test("browser remote calls startupStatus with an empty payload", async () => {
  const calls: Array<{ channel: string; endpoint: string; args: unknown }> = [];
  const remote = createWorkbenchRemote({
    rpc: {
      call: async (channel: string, endpointName: string, payload: { args: unknown }) => {
        calls.push({ channel, endpoint: endpointName, args: payload.args });
        return { ok: true as const, value: failed };
      },
    },
  } as never);
  const startupStatus = remote.startupStatus;
  if (!startupStatus) throw new Error("startupStatus is missing");
  assert.deepEqual(await startupStatus(), failed);
  assert.deepEqual(calls, [{ channel: "/api", endpoint: "workbench/startupStatus", args: {} }]);
});

test("manager startupStatus stays unsupported when the connected api omits it", async () => {
  const calls: string[] = [];
  const runtime = {
    async managerApi() {
      calls.push("managerApi");
      return {
        async state() {
          calls.push("state");
          throw new Error("must not read state");
        },
      };
    },
  } as unknown as WorkbenchHostRuntime;
  const host = new WorkbenchManagerHost(new Context(), runtime);
  await assert.rejects(
    () => host.startupStatus(),
    (error: unknown) => error instanceof RemoteError && error.code === "workbench/unsupported",
  );
  assert.deepEqual(calls, ["managerApi"]);
});

test("manager startupStatus returns the connected observation", async () => {
  const calls: string[] = [];
  const runtime = {
    async managerApi() {
      calls.push("managerApi");
      return {
        async startupStatus() {
          calls.push("startupStatus");
          return failed;
        },
      };
    },
  } as unknown as WorkbenchHostRuntime;
  const host = new WorkbenchManagerHost(new Context(), runtime);
  assert.deepEqual(await host.startupStatus(), failed);
  assert.deepEqual(calls, ["managerApi", "startupStatus"]);
});
