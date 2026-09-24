import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import {
  createWorkbenchHttpClient,
  WORKBENCH_HTTP_BODY_LIMIT,
  WORKBENCH_PRODUCT_SHARE_BODY_LIMIT,
  workbenchPost,
} from "../packages/plugin/src/host/workbench-http.ts";
import { WORKBENCH_PUBLIC_ERROR } from "../packages/plugin/src/host/remote-errors.ts";
import { workbenchStateSchema } from "../packages/plugin/src/host/workbench-schemas.ts";
import { createWorkbenchRemote } from "../packages/plugin/src/client/workbench-remote.ts";
import { MAX_WORKBENCH_SHARE_BASE64 } from "../src/shared/workbench-product.ts";
import type { SupervisorEndpoint } from "../packages/plugin/src/host/supervisor-endpoint.ts";
import type { WorkbenchMutationContext } from "../src/shared/workbench.ts";

const ORIGIN = "http://127.0.0.1:9";
const BEARER = "B".repeat(32);
const EPOCH = "ab".repeat(32);
const REVISION = "cd".repeat(32);
const SINCE = "2026-09-20T00:00:00.000Z";

const endpoint: SupervisorEndpoint = {
  origin: ORIGIN,
  bearer: BEARER,
  protocolVersion: 2,
  homeId: EPOCH,
  serviceEpoch: EPOCH,
};

const context: WorkbenchMutationContext = { serviceEpoch: EPOCH, expectedRevision: REVISION };

function jobValue(extra: Record<string, unknown> = {}) {
  return {
    id: "job1",
    requestId: "req1",
    kind: "space.start",
    status: "failed",
    phase: "done",
    message: "failed",
    affectedSpaceIds: ["notes"],
    createdAt: SINCE,
    updatedAt: SINCE,
    canCancel: false,
    ...extra,
  };
}

function stateValue(jobs: unknown[] = []) {
  return {
    protocolVersion: 2 as const,
    serviceEpoch: EPOCH,
    revision: REVISION,
    availability: "ready" as const,
    role: "manager" as const,
    managerId: "notes",
    owner: { kind: "web" as const, since: SINCE },
    writable: true,
    mode: "verified-full" as const,
    dshVersion: "0.1.5-rc.1",
    maintenance: false,
    reasons: [],
    spaces: [],
    jobs,
  };
}

function jsonOk(value: unknown) {
  return new Response(JSON.stringify({ ok: true, value }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("submit and preview POST bodies carry parsed context; product is forwarded", async () => {
  const bodies: Array<{ url: string; body: unknown }> = [];
  const api = createWorkbenchHttpClient({
    endpoint,
    fetch: async (url, init) => {
      bodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      if (String(url).endsWith("/product")) {
        return new Response(
          JSON.stringify({
            ok: true,
            value: {
              method: "settings",
              settings: { portStart: 1024, portEnd: 2048, packageSource: "official", catalogUrl: "" },
              clientDefaults: { locale: "system", theme: "system" },
              observation: context,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).endsWith("/preview")) {
        return new Response(
          JSON.stringify({
            ok: true,
            value: {
              id: "plan1",
              kind: "space.stop",
              title: "Stop",
              scope: "space",
              affectedSpaceIds: ["notes"],
              runningSpaceIds: [],
              changes: ["stop"],
              destructive: true,
              expiresAt: SINCE,
              serviceEpoch: EPOCH,
              stateRevision: REVISION,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, value: jobValue() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await api.submit({ kind: "space.start", spaceId: "notes" }, "req1", context);
  await api.preview({ kind: "space.stop", spaceId: "notes" }, context);
  const product = await api.product({ method: "settings" });
  assert.deepEqual(bodies[0], {
    url: `${ORIGIN}/api/workbench/submit`,
    body: { command: { kind: "space.start", spaceId: "notes" }, requestId: "req1", context },
  });
  assert.deepEqual(bodies[1], {
    url: `${ORIGIN}/api/workbench/preview`,
    body: { request: { kind: "space.stop", spaceId: "notes" }, context },
  });
  assert.deepEqual(bodies[2], {
    url: `${ORIGIN}/api/workbench/product`,
    body: { request: { method: "settings" } },
  });
  assert.equal(product.method, "settings");
});

test("missing context and unknown recovery commands are rejected without filling observations", async () => {
  let fetched = 0;
  const api = createWorkbenchHttpClient({
    endpoint,
    fetch: async () => {
      fetched += 1;
      return new Response("{}", { status: 500 });
    },
  });
  await assert.rejects(
    () => api.submit({ kind: "space.start", spaceId: "notes" }, "req1", undefined as never),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.code, "workbench/invalid-input");
      return true;
    },
  );
  await assert.rejects(
    () => api.preview({ kind: "space.stop", spaceId: "notes" }, undefined as never),
    (error: unknown) => error instanceof RemoteError && error.code === "workbench/invalid-input",
  );
  await assert.rejects(
    () => api.submit({ kind: "recovery.resume" } as never, "req1", context),
    (error: unknown) => error instanceof RemoteError && error.code === "workbench/invalid-input",
  );
  await assert.rejects(
    () => api.submit({ kind: "controller.acquire" } as never, "req1", context),
    (error: unknown) => error instanceof RemoteError && error.code === "workbench/invalid-input",
  );
  assert.equal(fetched, 0);
});

test("failed job result.product is preserved", async () => {
  const product = {
    kind: "settings.update" as const,
    settings: { portStart: 1024, portEnd: 2048, packageSource: "official" as const, catalogUrl: "" },
  };
  const api = createWorkbenchHttpClient({
    endpoint,
    fetch: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          value: jobValue({
            kind: "settings.update",
            result: { product },
            error: { code: "workbench/unavailable", message: "failed" },
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const job = await api.submit({ kind: "settings.update", settings: product.settings }, "req1", context);
  assert.equal(job.status, "failed");
  assert.deepEqual(job.result?.product, product);
});

test("failed job and state responses accept bounded public failure context", async () => {
  const generatedError = {
    code: "workbench/failed",
    message: "The job failed.",
    pluginAttribution: "unknown" as const,
  };
  const publicContext = {
    code: "workbench/failed",
    message: "The job failed.",
    spaceId: "notes",
    stage: "run",
    packageName: "example-plugin@1.2.3",
    pluginAttribution: "known" as const,
    exitCode: 1,
    signal: "SIGKILL",
  };
  const nullableContext = {
    code: "workbench/failed",
    message: "The job failed.",
    pluginAttribution: "unknown" as const,
    exitCode: null,
    signal: null,
  };
  const api = createWorkbenchHttpClient({
    endpoint,
    fetch: async (url) => {
      const path = String(url);
      if (path.endsWith("/job")) return jsonOk(jobValue({ error: generatedError }));
      if (path.endsWith("/state")) {
        return jsonOk(
          stateValue([
            jobValue({ error: publicContext }),
            jobValue({ id: "job2", requestId: "req2", error: nullableContext }),
          ]),
        );
      }
      return jsonOk({});
    },
  });
  const generated = await api.job("job1");
  assert.equal(generated.status, "failed");
  assert.deepEqual(generated.error, generatedError);
  const state = await api.state();
  assert.equal(state.jobs.length, 2);
  assert.deepEqual(state.jobs[0]?.error, publicContext);
  assert.deepEqual(state.jobs[1]?.error, nullableContext);
});

test("failed job and state responses reject unknown job error keys", async () => {
  const extraError = {
    code: "workbench/failed",
    message: "The job failed.",
    pluginAttribution: "unknown",
    stderr: "stderr-secret",
  };
  const jobApi = createWorkbenchHttpClient({
    endpoint,
    fetch: async () => jsonOk(jobValue({ error: extraError })),
  });
  await assert.rejects(
    () => jobApi.job("job1"),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.code, "workbench/unavailable");
      assert.equal(JSON.stringify(error).includes("stderr-secret"), false);
      return true;
    },
  );
  const stateApi = createWorkbenchHttpClient({
    endpoint,
    fetch: async () => jsonOk(stateValue([jobValue({ error: extraError })])),
  });
  await assert.rejects(
    () => stateApi.state(),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.code, "workbench/unavailable");
      assert.equal(JSON.stringify(error).includes("stderr-secret"), false);
      return true;
    },
  );
});

test("share.previewImport may exceed the ordinary JSON limit but not the 8MiB product bound", async () => {
  const overOrdinary = "A".repeat(WORKBENCH_HTTP_BODY_LIMIT + 16);
  assert.equal(overOrdinary.length % 4, 0);
  let fetched = 0;
  const api = createWorkbenchHttpClient({
    endpoint,
    fetch: async () => {
      fetched += 1;
      return new Response(JSON.stringify({ ok: true, value: {} }), { status: 200 });
    },
  });
  await assert.rejects(() => api.product({ method: "share.previewImport", archiveBase64: overOrdinary }));
  assert.equal(fetched, 1);

  const overProduct = "A".repeat(Math.ceil((WORKBENCH_PRODUCT_SHARE_BODY_LIMIT + 8) / 4) * 4);
  fetched = 0;
  await assert.rejects(
    () => api.product({ method: "share.previewImport", archiveBase64: overProduct }),
    (error: unknown) => error instanceof RemoteError && error.code === "workbench/invalid-input",
  );
  assert.equal(fetched, 0);
  assert.ok(MAX_WORKBENCH_SHARE_BASE64 < WORKBENCH_PRODUCT_SHARE_BODY_LIMIT);
});

test("ordinary methods still use the 2MiB bound", async () => {
  let fetched = 0;
  await assert.rejects(
    () =>
      workbenchPost(
        async () => {
          fetched += 1;
          return new Response("{}", { status: 200 });
        },
        ORIGIN,
        BEARER,
        "state",
        { pad: "A".repeat(WORKBENCH_HTTP_BODY_LIMIT) },
        workbenchStateSchema,
      ),
    (error: unknown) => error instanceof RemoteError && error.code === "workbench/invalid-input",
  );
  assert.equal(fetched, 0);
});

test("browser remote forwards context and product and does not invent observations", async () => {
  const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = [];
  const remote = createWorkbenchRemote({
    rpc: {
      call: async (_channel: string, endpoint: string, payload: { args: Record<string, unknown> }) => {
        calls.push({ endpoint, args: payload.args });
        if (endpoint === "workbench/product") {
          return {
            ok: true as const,
            value: {
              method: "library",
              items: [],
              observation: context,
            },
          };
        }
        return { ok: true as const, value: jobValue() };
      },
    },
  } as never);
  await remote.submit({ kind: "space.start", spaceId: "notes" }, "req1", context);
  await remote.preview({ kind: "space.stop", spaceId: "notes" }, context);
  await remote.product({ method: "library" });
  assert.deepEqual(calls[0], {
    endpoint: "workbench/submit",
    args: { command: { kind: "space.start", spaceId: "notes" }, requestId: "req1", context },
  });
  assert.deepEqual(calls[1], {
    endpoint: "workbench/preview",
    args: { request: { kind: "space.stop", spaceId: "notes" }, context },
  });
  assert.deepEqual(calls[2], {
    endpoint: "workbench/product",
    args: { request: { method: "library" } },
  });
});

test("LLM public errors pass through the Host client without leaking details", async () => {
  const identity = { parse: (value: unknown) => value };
  const postError = (error: unknown) =>
    workbenchPost(
      async () => new Response(JSON.stringify({ ok: false, error })),
      ORIGIN,
      BEARER,
      "llm",
      {},
      identity,
    );

  await assert.rejects(
    () =>
      postError({
        code: "LLM_REVISION_CONFLICT",
        message: "catalog revision moved",
        details: { expected: 0, actual: 1 },
      }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.code, "LLM_REVISION_CONFLICT");
      assert.equal(error.message, "catalog revision moved");
      assert.deepEqual(error.details, {});
      return true;
    },
  );
  await assert.rejects(
    () =>
      postError({
        code: "LLM_APPLY_FAILED",
        message: "observed space state no longer matches",
        details: { spaceId: "alpha" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.code, "LLM_APPLY_FAILED");
      assert.equal(error.message, "observed space state no longer matches");
      assert.deepEqual(error.details, {});
      return true;
    },
  );
  await assert.rejects(
    () =>
      postError({
        code: "workbench/conflict",
        message: "internal conflict diagnostic",
        details: { path: "C:\\\\secrets" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.code, "workbench/conflict");
      assert.equal(error.message, "internal conflict diagnostic");
      assert.deepEqual(error.details, {});
      assert.equal(JSON.stringify(error).includes("secrets"), false);
      return true;
    },
  );
  await assert.rejects(
    () =>
      postError({
        code: "LLM_NOT_A_PUBLIC_CODE",
        message: "sk-live-should-not-leak",
        details: { token: "sk-live-should-not-leak" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.code, "workbench/unavailable");
      assert.equal(error.message, WORKBENCH_PUBLIC_ERROR["workbench/unavailable"]);
      assert.deepEqual(error.details, {});
      assert.equal(JSON.stringify(error).includes("sk-live"), false);
      return true;
    },
  );
});
