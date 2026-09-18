import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { startWorkbenchHttp, type WorkbenchHttpRuntime } from "../src/adapters/node/workbench-http.ts";
import { OfficialLlmProbe, LLM_DISCOVERY_MAX_BYTES, LLM_DISCOVERY_MAX_MODELS } from "../src/adapters/node/llm-probe.ts";
import { FileLlmOperationStore, llmOperationsPath } from "../src/adapters/node/llm-operation-store.ts";
import { WorkbenchJobStore } from "../src/adapters/node/workbench-jobs.ts";
import { GlobalLlmHost } from "../src/core/application/global-llm-host.ts";
import { GlobalLlmService } from "../src/core/application/global-llm-service.ts";
import {
  LLM_ERROR,
  LlmConfigError,
  createConnectionId,
  emptyCatalog,
  parseCatalog,
  type GlobalLlmCatalog,
  type SpaceLlmPolicy,
} from "../src/core/domain/llm-connections.ts";
import type { LlmInstanceRecord, LlmOperationRecord, LlmOperationStore, LlmProbePort, LlmSpaceSettingsPort, SpaceDefaultModel } from "../src/core/ports/llm-runtime.ts";
import type { LlmLocalCandidate } from "../src/shared/llm-api.ts";
import type { LlmCatalogStore, LlmCredentialStore, LlmPolicyStore } from "../src/core/ports/llm-store.ts";
import { emptyPolicy } from "../src/core/domain/llm-connections.ts";

const temps: string[] = [];
const servers: Server[] = [];
const SECRET = "sk-live-global-never-in-jobs";

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-llm-api-"));
  temps.push(dir);
  return dir;
}

class MemoryCatalogStore implements LlmCatalogStore {
  constructor(private catalog: GlobalLlmCatalog = emptyCatalog()) {}
  async read(): Promise<GlobalLlmCatalog> {
    return this.catalog;
  }
  async write(next: GlobalLlmCatalog, expectedRevision: number): Promise<GlobalLlmCatalog> {
    if (this.catalog.revision !== expectedRevision) {
      throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "catalog revision moved");
    }
    this.catalog = parseCatalog(next);
    return this.catalog;
  }
}

class FailWriteCatalogStore implements LlmCatalogStore {
  constructor(private readonly inner: LlmCatalogStore) {}
  read() {
    return this.inner.read();
  }
  async write(): Promise<GlobalLlmCatalog> {
    throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "catalog publish failed");
  }
}

class MemoryPolicyStore implements LlmPolicyStore {
  private readonly files = new Map<string, SpaceLlmPolicy>();
  async read(spaceId: string): Promise<SpaceLlmPolicy> {
    return this.files.get(spaceId) ?? emptyPolicy();
  }
  async write(spaceId: string, next: SpaceLlmPolicy, expectedRevision: number): Promise<SpaceLlmPolicy> {
    const current = await this.read(spaceId);
    if (current.revision !== expectedRevision) {
      throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "policy revision moved");
    }
    this.files.set(spaceId, next);
    return next;
  }
}

class MemoryCredentialStore implements LlmCredentialStore {
  readonly records = new Map<string, string>();
  writes = 0;
  async writeRecord(input: { recordId: string; secret: string }) {
    this.writes += 1;
    if (this.records.has(input.recordId)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "credential records are immutable");
    }
    this.records.set(input.recordId, input.secret);
    return this.describe(input.recordId);
  }
  async readSecret(recordId: string) {
    return this.records.get(recordId);
  }
  async describe(recordId: string) {
    const configured = this.records.has(recordId);
    return { recordId, configured, writable: !configured, source: "spaces-global" as const };
  }
}

class MemoryOperationStore implements LlmOperationStore {
  readonly records = new Map<string, LlmOperationRecord>();
  async get(operationId: string) {
    return this.records.get(operationId);
  }
  async begin(operationId: string) {
    const existing = this.records.get(operationId);
    if (existing) return existing;
    const record: LlmOperationRecord = {
      operationId,
      status: "unknown",
      createdAt: "2026-09-18T00:00:00.000Z",
    };
    this.records.set(operationId, record);
    return record;
  }
  async commit(operationId: string, input: { catalogRevision: number; connectionId: string }) {
    const record: LlmOperationRecord = {
      operationId,
      status: "committed",
      catalogRevision: input.catalogRevision,
      connectionId: input.connectionId,
      createdAt: this.records.get(operationId)?.createdAt ?? "2026-09-18T00:00:00.000Z",
    };
    this.records.set(operationId, record);
    return record;
  }
  async markUnknown(operationId: string, input: { leftoverRecordId?: string } = {}) {
    const current = this.records.get(operationId) ?? {
      operationId,
      status: "unknown" as const,
      createdAt: "2026-09-18T00:00:00.000Z",
    };
    if (current.status === "committed") return current;
    const record = { ...current, status: "unknown" as const, leftoverRecordId: input.leftoverRecordId ?? current.leftoverRecordId };
    this.records.set(operationId, record);
    return record;
  }
}

class MemoryInstances {
  readonly rows = new Map<string, LlmInstanceRecord>();
  async list() {
    return [...this.rows.values()];
  }
  async get(spaceId: string) {
    return this.rows.get(spaceId);
  }
  async markApplied(spaceId: string, catalogRevision: number) {
    const current = this.rows.get(spaceId);
    if (current) this.rows.set(spaceId, { ...current, catalogRevision });
  }
  put(spaceId: string, patch: Partial<LlmInstanceRecord> = {}) {
    this.rows.set(spaceId, {
      spaceId,
      status: "running",
      generation: 1,
      catalogRevision: 0,
      policyRevision: 0,
      busy: false,
      ...patch,
    });
  }
}

class MemorySpaceSettings implements LlmSpaceSettingsPort {
  defaults = new Map<string, SpaceDefaultModel>();
  locals = new Map<string, LlmLocalCandidate[]>();
  providers = new Map<string, Record<string, unknown>>();
  secrets = new Map<string, string>();
  async readDefault(spaceId: string) {
    return this.defaults.get(spaceId) ?? null;
  }
  async writeDefault(spaceId: string, value: SpaceDefaultModel | null) {
    if (value === null) this.defaults.delete(spaceId);
    else this.defaults.set(spaceId, value);
  }
  async listLocal(spaceId: string) {
    return this.locals.get(spaceId) ?? [];
  }
  async readLocalProvider(_spaceId: string, routeId: string) {
    const config = this.providers.get(routeId);
    if (!config) throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "local connection was not found");
    return config;
  }
  async readCopyableSecret(_spaceId: string, routeId: string) {
    return this.secrets.get(routeId);
  }
}

function noneDraft(displayName = "共享接口") {
  return {
    displayName,
    providerConfig: {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:9/v1",
      models: [{ id: "demo-large" }],
    },
    auth: { kind: "none" as const },
  };
}

function hostOf(input: {
  spaces?: string[];
  writable?: boolean;
  catalog?: LlmCatalogStore;
  credentials?: MemoryCredentialStore;
  operations?: MemoryOperationStore;
  instances?: MemoryInstances;
  probe?: LlmProbePort;
  restart?: (spaceId: string) => Promise<void>;
}) {
  const credentials = input.credentials ?? new MemoryCredentialStore();
  const instances = input.instances ?? new MemoryInstances();
  const operations = input.operations ?? new MemoryOperationStore();
  const service = new GlobalLlmService(
    input.catalog ?? new MemoryCatalogStore(),
    new MemoryPolicyStore(),
    credentials,
    async () => input.spaces ?? ["alpha", "beta", "gamma"],
  );
  const restarted: string[] = [];
  const restart = input.restart ?? (async (spaceId: string) => {
    restarted.push(spaceId);
  });
  let created: GlobalLlmHost;
  created = new GlobalLlmHost({
    service,
    operations,
    instances,
    probe: input.probe ?? {
      discover: async () => ({ models: [{ id: "demo-large" }], truncated: false }),
      test: async ({ modelId }) => ({ ok: true as const, modelId }),
    },
    spaceSettings: new MemorySpaceSettings(),
    assertWritable: () => {
      if (input.writable === false) {
        throw new LlmConfigError(LLM_ERROR.WRITE_OWNER_REQUIRED, "Home write owner is required for this change");
      }
    },
    submitApply: async (command, requestId) => {
      await created.executeApply(command, restart);
      return {
        id: requestId,
        requestId,
        kind: "llm.apply",
        status: "succeeded",
        phase: "succeeded",
        message: "",
        affectedSpaceIds: command.spaceIds,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
        canCancel: false,
      };
    },
    readSecret: (recordId) => credentials.readSecret(recordId),
  });
  return { host: created, credentials, instances, operations, restarted, service };
}

async function startFakeApi(host: GlobalLlmHost, workspaceOrigin?: string) {
  const box = { origin: "http://127.0.0.1:0" };
  const bearer = "host-bearer";
  const runtime: WorkbenchHttpRuntime = {
    cookieName: () => "dsh-auth-test",
    sessionCookie: () => "sess",
    sessionEquals: (value) => value === "sess",
    consumeBootstrapToken: () => false,
    hostBearerEquals: (value) => value === bearer,
    supervisorOrigin: () => box.origin,
    managerOrigin: () => null,
    isWorkspaceOrigin: (origin) => origin === workspaceOrigin,
    dispatch: async (method, payload) => {
      if (method === "llm") return host.dispatch(payload);
      if (method === "llmCredential") return host.dispatchCredential(payload);
      throw Object.assign(new Error("Unknown workbench method."), { code: "workbench/not-found" });
    },
    entryPage: () => "<html></html>",
    viewEntry: async () => ({ status: 404, message: "missing" }),
    mintHandoff: () => "/bootstrap/x",
  };
  const http = await startWorkbenchHttp(runtime, 0);
  servers.push(http.server);
  box.origin = http.origin;
  return { origin: http.origin, bearer };
}

async function post(
  origin: string,
  method: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } }> {
  const response = await fetch(`${origin}/api/workbench/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as never };
}

test("read-only clients cannot write shared LLM state", async () => {
  const { host } = hostOf({ writable: false });
  await assert.rejects(
    () => host.dispatch({ method: "saveConnection", draft: noneDraft(), expectedRevision: 0 }),
    (error: unknown) => error instanceof LlmConfigError && error.code === LLM_ERROR.WRITE_OWNER_REQUIRED,
  );
  await assert.rejects(
    () =>
      host.dispatchCredential({
        method: "saveConnectionWithCredential",
        draft: { displayName: "x", providerConfig: noneDraft().providerConfig },
        secret: SECRET,
        expectedRevision: 0,
        operationId: "op-ro",
      }),
    (error: unknown) => error instanceof LlmConfigError && error.code === LLM_ERROR.WRITE_OWNER_REQUIRED,
  );
});

test("describe is redacted and stays available without write owner", async () => {
  const { host } = hostOf({ writable: false });
  const described = (await host.dispatch({ method: "describe" })) as { connections: unknown[]; capabilities: { keyless: boolean } };
  assert.equal(described.capabilities.keyless, false);
  assert.deepEqual(described.connections, []);
});

test("credential write records operation status and is not replayed", async () => {
  const { host, credentials, operations } = hostOf({ writable: true });
  const first = (await host.dispatchCredential({
    method: "saveConnectionWithCredential",
    draft: { displayName: "主力", providerConfig: noneDraft().providerConfig },
    secret: SECRET,
    expectedRevision: 0,
    operationId: "op-save-1",
  })) as { revision: number; connectionId?: string };
  assert.equal(first.revision, 1);
  assert.equal(credentials.writes, 1);
  assert.equal((await host.operationStatus("op-save-1")).status, "committed");
  const again = (await host.dispatchCredential({
    method: "saveConnectionWithCredential",
    draft: { displayName: "主力", providerConfig: noneDraft().providerConfig },
    secret: "sk-other-should-not-write",
    expectedRevision: 0,
    operationId: "op-save-1",
  })) as { revision: number };
  assert.equal(again.revision, 1);
  assert.equal(credentials.writes, 1);
  assert.equal(operations.records.get("op-save-1")?.status, "committed");
  assert.equal(JSON.stringify(operations.records.get("op-save-1")).includes(SECRET), false);
});

test("failed catalog publish after credential write stays unknown and is not replayed", async () => {
  const credentials = new MemoryCredentialStore();
  const { host } = hostOf({
    writable: true,
    credentials,
    catalog: new FailWriteCatalogStore(new MemoryCatalogStore()),
  });
  await assert.rejects(
    () =>
      host.dispatchCredential({
        method: "saveConnectionWithCredential",
        draft: { displayName: "主力", providerConfig: noneDraft().providerConfig },
        secret: SECRET,
        expectedRevision: 0,
        operationId: "op-unknown",
      }),
    (error: unknown) => error instanceof LlmConfigError && error.code === LLM_ERROR.REVISION_CONFLICT,
  );
  assert.equal(credentials.writes, 1);
  const status = await host.operationStatus("op-unknown");
  assert.equal(status.status, "unknown");
  assert.ok(status.leftoverRecordId);
  await assert.rejects(
    () =>
      host.dispatchCredential({
        method: "saveConnectionWithCredential",
        draft: { displayName: "主力", providerConfig: noneDraft().providerConfig },
        secret: SECRET,
        expectedRevision: 0,
        operationId: "op-unknown",
      }),
    (error: unknown) => error instanceof LlmConfigError && error.code === LLM_ERROR.RESULT_UNKNOWN,
  );
  assert.equal(credentials.writes, 1);
});

test("apply plan keeps A, stops at B, and leaves C unexecuted", async () => {
  const instances = new MemoryInstances();
  instances.put("alpha");
  instances.put("beta");
  instances.put("gamma");
  const ran: string[] = [];
  const { host } = hostOf({
    writable: true,
    instances,
    restart: async (spaceId) => {
      ran.push(spaceId);
      if (spaceId === "beta") throw new Error("beta restart failed");
    },
  });
  await host.dispatch({
    method: "saveConnection",
    draft: noneDraft(),
    expectedRevision: 0,
  });
  await assert.rejects(
    () =>
      host.dispatch({
        method: "applyPlan",
        spaceIds: ["alpha", "beta", "gamma"],
        catalogRevision: 1,
        requestId: "apply-1",
        observations: ["alpha", "beta", "gamma"].map((spaceId) => ({
          spaceId,
          status: "running" as const,
          generation: 1,
          catalogRevision: 0,
          busy: false,
        })),
      }),
    (error: unknown) =>
      error instanceof LlmConfigError &&
      error.code === LLM_ERROR.APPLY_FAILED &&
      error.details.spaceId === "beta" &&
      error.details.succeeded === 1 &&
      error.details.skipped === 1,
  );
  assert.deepEqual(ran, ["alpha", "beta"]);
  assert.equal(instances.rows.get("alpha")?.catalogRevision, 1);
  assert.equal(instances.rows.get("gamma")?.catalogRevision, 0);
});

test("busy or unknown spaces refuse apply before any restart", async () => {
  const busy = new MemoryInstances();
  busy.put("alpha");
  busy.put("beta", { busy: true });
  const ran: string[] = [];
  const { host: busyHost } = hostOf({
    writable: true,
    instances: busy,
    restart: async (spaceId) => {
      ran.push(spaceId);
    },
  });
  await busyHost.dispatch({ method: "saveConnection", draft: noneDraft(), expectedRevision: 0 });
  await assert.rejects(
    () =>
      busyHost.dispatch({
        method: "applyPlan",
        spaceIds: ["alpha", "beta"],
        catalogRevision: 1,
        requestId: "apply-busy",
        observations: [
          { spaceId: "alpha", status: "running", generation: 1, catalogRevision: 0, busy: false },
          { spaceId: "beta", status: "running", generation: 1, catalogRevision: 0, busy: true },
        ],
      }),
    (error: unknown) => error instanceof LlmConfigError && error.code === LLM_ERROR.SPACE_BUSY,
  );

  const unknown = new MemoryInstances();
  unknown.put("alpha");
  unknown.put("beta", { status: "unknown" });
  const { host: unknownHost } = hostOf({ writable: true, instances: unknown, restart: async (spaceId) => ran.push(spaceId) });
  await unknownHost.dispatch({ method: "saveConnection", draft: noneDraft(), expectedRevision: 0 });
  await assert.rejects(
    () =>
      unknownHost.dispatch({
        method: "applyPlan",
        spaceIds: ["alpha", "beta"],
        catalogRevision: 1,
        requestId: "apply-unknown",
        observations: [
          { spaceId: "alpha", status: "running", generation: 1, catalogRevision: 0, busy: false },
          { spaceId: "beta", status: "unknown", generation: 1, catalogRevision: 0, busy: false },
        ],
      }),
    (error: unknown) => error instanceof LlmConfigError && error.code === LLM_ERROR.APPLY_FAILED,
  );
  assert.deepEqual(ran, []);
});

test("HTTP maps a missing write owner to LLM_WRITE_OWNER_REQUIRED", async () => {
  const { host } = hostOf({ writable: false });
  const http = await startFakeApi(host);
  const denied = await post(
    http.origin,
    "llm",
    { method: "saveConnection", draft: noneDraft(), expectedRevision: 0 },
    { authorization: `Bearer ${http.bearer}`, origin: http.origin },
  );
  assert.equal(denied.body.ok, false);
  assert.equal(denied.body.error?.code, "LLM_WRITE_OWNER_REQUIRED");
});

test("workspace origins cannot call llm or llmCredential", async () => {
  const { host } = hostOf({ writable: true });
  const workspace = "http://127.0.0.1:39991";
  const http = await startFakeApi(host, workspace);
  const denied = await post(http.origin, "llm", { method: "describe" }, {
    cookie: "dsh-auth-test=sess",
    origin: workspace,
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error?.code, "workbench/forbidden");
  const secretDenied = await post(
    http.origin,
    "llmCredential",
    {
      method: "saveConnectionWithCredential",
      draft: { displayName: "x", providerConfig: noneDraft().providerConfig },
      secret: SECRET,
      expectedRevision: 0,
      operationId: "op-ws",
    },
    { cookie: "dsh-auth-test=sess", origin: workspace },
  );
  assert.equal(secretDenied.status, 403);
});

test("HTTP credential channel commits without putting the key on a job", async () => {
  const home = tempHome();
  const jobs = new WorkbenchJobStore({ home });
  const { host, credentials } = hostOf({ writable: true });
  const http = await startFakeApi(host);
  const saved = await post(
    http.origin,
    "llmCredential",
    {
      method: "saveConnectionWithCredential",
      draft: { displayName: "主力", providerConfig: noneDraft().providerConfig },
      secret: SECRET,
      expectedRevision: 0,
      operationId: "op-http-1",
    },
    { authorization: `Bearer ${http.bearer}`, origin: http.origin },
  );
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
  assert.equal(credentials.writes, 1);
  const status = await post(
    http.origin,
    "llm",
    { method: "operationStatus", operationId: "op-http-1" },
    { authorization: `Bearer ${http.bearer}`, origin: http.origin },
  );
  assert.equal((status.body.value as { status?: string }).status, "committed");
  const names = existsSync(jobs.jobsDir)
    ? readdirSync(jobs.jobsDir, { withFileTypes: true }).flatMap((entry) => (entry.isFile() ? [entry.name] : []))
    : [];
  assert.deepEqual(names, []);
});

test("StoredJob rejects secret fields and never persists them", async () => {
  const home = tempHome();
  const store = new WorkbenchJobStore({ home });
  const invalidJob = (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error && error.code === "workbench/invalid-input");
  await assert.rejects(
    () =>
      store.submit(
        { kind: "space.start", spaceId: "alpha", apiKey: SECRET } as never,
        "job-secret",
        async () => undefined,
      ),
    invalidJob,
  );
  await assert.rejects(
    () =>
      store.submit(
        {
          kind: "llm.apply",
          spaceIds: ["alpha"],
          catalogRevision: 1,
          observations: [{ spaceId: "alpha", status: "running", generation: 1, catalogRevision: 0, busy: false, token: SECRET }],
        } as never,
        "job-secret-2",
        async () => undefined,
      ),
    invalidJob,
  );
  const files = existsSync(store.jobsDir) ? readdirSync(store.jobsDir) : [];
  for (const name of files) {
    const text = readFileSync(join(store.jobsDir, name), "utf8");
    assert.equal(text.includes(SECRET), false);
  }
});

test("file operation records refuse secret keys", async () => {
  const home = tempHome();
  const store = new FileLlmOperationStore(home);
  await store.begin("op-file");
  await store.commit("op-file", { catalogRevision: 1, connectionId: createConnectionId() });
  const text = readFileSync(llmOperationsPath(home), "utf8");
  assert.equal(text.includes("sk-"), false);
  assert.equal(text.includes("hash"), false);
});

test("discovery refuses redirects, oversized bodies, and truncates at 1000 models", async () => {
  const probe = new OfficialLlmProbe();
  const redirect = createServer((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:9/steal" });
    res.end();
  });
  servers.push(redirect);
  const redirectUrl = await listen(redirect);
  await assert.rejects(
    () => probe.discover({ api: "openai-completions", baseURL: `${redirectUrl}/v1` }),
    (error: unknown) =>
      error instanceof LlmConfigError &&
      error.code === LLM_ERROR.DISCOVERY_FAILED &&
      /does not follow redirects/.test(error.message),
  );

  const oversized = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": String(LLM_DISCOVERY_MAX_BYTES + 10) });
    res.end("{}");
  });
  servers.push(oversized);
  const oversizedUrl = await listen(oversized);
  await assert.rejects(
    () => probe.discover({ api: "openai-completions", baseURL: `${oversizedUrl}/v1` }),
    (error: unknown) => error instanceof LlmConfigError && /size bound/.test((error as Error).message),
  );

  const models = Array.from({ length: LLM_DISCOVERY_MAX_MODELS + 5 }, (_, index) => ({ id: `m-${index}` }));
  const listing = createServer((req: IncomingMessage, res) => {
    assert.equal(req.headers.authorization, `Bearer ${SECRET}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: models }));
  });
  servers.push(listing);
  const listingUrl = await listen(listing);
  const found = await probe.discover({
    api: "openai-completions",
    baseURL: `${listingUrl}/v1`,
    apiKey: SECRET,
  });
  assert.equal(found.truncated, true);
  assert.equal(found.models.length, LLM_DISCOVERY_MAX_MODELS);
});

test("testConnection requires authorize and does not send chat history", async () => {
  const hits: Array<{ url?: string; body: string }> = [];
  const mock = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      hits.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "cmpl", choices: [{ message: { content: "ok" } }] }));
    });
  });
  servers.push(mock);
  const origin = await listen(mock);
  const credentials = new MemoryCredentialStore();
  const catalog = new MemoryCatalogStore();
  const service = new GlobalLlmService(catalog, new MemoryPolicyStore(), credentials, async () => ["alpha"]);
  const saved = await service.saveConnectionWithCredential(
    {
      displayName: "mock",
      providerConfig: {
        api: "openai-completions",
        baseURL: `${origin}/v1`,
        models: [{ id: "demo-large" }],
      },
    },
    SECRET,
    0,
  );
  const connectionId = Object.keys(saved.connections)[0];
  const { host } = hostOf({
    writable: true,
    catalog,
    credentials,
    probe: new OfficialLlmProbe(),
  });
  await assert.rejects(
    () =>
      host.dispatch({
        method: "testConnection",
        connectionId,
        modelId: "demo-large",
      } as never),
    /authorize|required field/,
  );
  const result = await host.dispatch({
    method: "testConnection",
    connectionId,
    modelId: "demo-large",
    authorize: true,
  });
  assert.deepEqual(result, { ok: true, modelId: "demo-large", billed: true });
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.url ?? "", /chat\/completions/);
  assert.match(hits[0]?.body ?? "", /"ping"/);
  assert.equal((hits[0]?.body ?? "").includes("user chat"), false);
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("listen"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
