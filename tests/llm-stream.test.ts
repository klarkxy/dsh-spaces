import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AddressInfo } from "node:net";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createUserMessage, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { FileLlmCatalogStore } from "../src/adapters/node/llm-catalog-store.ts";
import { FileLlmCredentialStore } from "../src/adapters/node/llm-credential-store.ts";
import { FileLlmPolicyStore } from "../src/adapters/node/llm-policy-store.ts";
import { GlobalLlmService } from "../src/core/application/global-llm-service.ts";
import {
  LLM_ERROR,
  compileManagedRouteId,
  compileManagedRecordKey,
  createConnectionId,
} from "../src/core/domain/llm-connections.ts";
import { attachOfficialLlm } from "../packages/llm-bridge/src/official-host.ts";
import { freezeSpaceSnapshot, openSpaceLlmBridge } from "../packages/llm-bridge/src/space-bridge.ts";
import { PINNED_DSH_PACKAGE_VERSION } from "./helpers/llm-official.ts";

const temps: string[] = [];
const servers: Server[] = [];
const SHARED_SECRET = "sk-shared-once";
const LOCAL_A = "sk-local-alpha";
const LOCAL_B = "sk-local-beta";

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-llm-stream-"));
  temps.push(dir);
  return dir;
}

type MockHit = { auth?: string; url: string; model?: string };

function startMockCompletions(label: string): Promise<{ url: string; hits: MockHit[]; server: Server }> {
  const hits: MockHit[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let model: string | undefined;
      try {
        model = raw ? (JSON.parse(raw) as { model?: string }).model : undefined;
      } catch {
        model = undefined;
      }
      hits.push({ auth: req.headers.authorization, url: req.url ?? "", model });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(
        `data: ${JSON.stringify({
          id: `cmpl-${label}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: `hello-${label}` } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: `cmpl-${label}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${address.port}/v1`, hits, server });
    });
  });
}

async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    if (chunk.type === "text-delta") text += chunk.text;
    if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
      const failure = chunk.reason.failure;
      throw Object.assign(new Error(failure.message), { code: failure.code, status: failure.status });
    }
  }
  return text;
}

function streamPing(ctx: { llm: { stream(options: object): AsyncIterable<StreamChunk> } }, provider: string, model: string) {
  return collectText(
    ctx.llm.stream({
      provider,
      model,
      messages: [
        createUserMessage({
          content: [{ type: "text", text: "ping" }],
          source: { kind: "user" },
        }),
      ],
    }),
  );
}

function providerConfig(baseURL: string) {
  return {
    api: "openai-completions",
    baseURL,
    models: [{ id: "demo-large" }],
    retryPolicy: { mode: "normal", maxRetries: 0 },
  };
}

test("A and B stream a shared official adapter route while local same-name models stay distinct", async () => {
  const home = tempHome();
  const sharedMock = await startMockCompletions("shared");
  const localAMock = await startMockCompletions("local-a");
  const localBMock = await startMockCompletions("local-b");
  const catalog = new FileLlmCatalogStore(home);
  const policies = new FileLlmPolicyStore(home);
  const credentials = new FileLlmCredentialStore(home);
  const service = new GlobalLlmService(catalog, policies, credentials, async () => ["web", "alpha", "beta"]);
  const saved = await service.saveConnectionWithCredential(
    {
      displayName: "shared-mock",
      providerConfig: providerConfig(sharedMock.url),
    },
    SHARED_SECRET,
    0,
  );
  const connectionId = Object.keys(saved.connections)[0];
  await service.updateSpacePolicy("alpha", { mode: "selected", connectionIds: [connectionId] }, 0);
  await service.updateSpacePolicy("beta", { mode: "all" }, 0);
  const snapshot = freezeSpaceSnapshot(await catalog.read(), await policies.read("alpha"), PINNED_DSH_PACKAGE_VERSION);
  const betaSnapshot = freezeSpaceSnapshot(await catalog.read(), await policies.read("beta"), PINNED_DSH_PACKAGE_VERSION);

  const alpha = await openSpaceLlmBridge({
    settingsPath: join(home, "hub", "alpha", "settings.yaml"),
    localCredentialsPath: join(home, "hub", "alpha", ".credentials.yaml"),
    dshHome: join(home, "hub", "alpha"),
    snapshot,
    shared: credentials,
  });
  const beta = await openSpaceLlmBridge({
    settingsPath: join(home, "hub", "beta", "settings.yaml"),
    localCredentialsPath: join(home, "hub", "beta", ".credentials.yaml"),
    dshHome: join(home, "hub", "beta"),
    snapshot: betaSnapshot,
    shared: credentials,
  });
  const web = await openSpaceLlmBridge({
    settingsPath: join(home, "settings.yaml"),
    localCredentialsPath: join(home, ".credentials.yaml"),
    dshHome: home,
    snapshot: null,
    shared: credentials,
  });

  try {
    await attachOfficialLlm(alpha.ctx, alpha.settings);
    await attachOfficialLlm(beta.ctx, beta.settings);
    await attachOfficialLlm(web.ctx, web.settings);
    await alpha.settings.update("llm-pi-ai", {
      providers: {
        "local-openai": {
          displayName: "alpha-local",
          ...providerConfig(localAMock.url),
          apiKeyEnv: "LOCAL_A_KEY",
        },
      },
    });
    await beta.settings.update("llm-pi-ai", {
      providers: {
        "local-openai": {
          displayName: "beta-local",
          ...providerConfig(localBMock.url),
          apiKeyEnv: "LOCAL_B_KEY",
        },
      },
    });
    await alpha.credentials.set(credentialRef("LOCAL_A_KEY"), LOCAL_A);
    await beta.credentials.set(credentialRef("LOCAL_B_KEY"), LOCAL_B);

    const route = compileManagedRouteId(connectionId);
    assert.equal(alpha.settings.bridgeStatus().source, "spaces-shared");
    assert.equal(web.settings.bridgeStatus().source, "local-only");
    assert.equal(
      alpha.ctx.llm.listProviders().some((item) => item.id === route),
      true,
    );
    assert.equal(
      web.ctx.llm.listProviders().some((item) => item.id === route),
      false,
    );

    const sharedA = await streamPing(alpha.ctx, route, "demo-large");
    const sharedB = await streamPing(beta.ctx, route, "demo-large");
    const localA = await streamPing(alpha.ctx, "local-openai", "demo-large");
    const localB = await streamPing(beta.ctx, "local-openai", "demo-large");
    assert.equal(sharedA, "hello-shared");
    assert.equal(sharedB, "hello-shared");
    assert.equal(localA, "hello-local-a");
    assert.equal(localB, "hello-local-b");
    assert.deepEqual(
      sharedMock.hits.map((hit) => hit.auth),
      ["Bearer sk-shared-once", "Bearer sk-shared-once"],
    );
    assert.deepEqual(
      localAMock.hits.map((hit) => hit.auth),
      ["Bearer sk-local-alpha"],
    );
    assert.deepEqual(
      localBMock.hits.map((hit) => hit.auth),
      ["Bearer sk-local-beta"],
    );
  } finally {
    await alpha.dispose();
    await beta.dispose();
    await web.dispose();
  }
});

test("frozen snapshot keeps the old endpoint; a hijacked Space does not take down the other", async () => {
  const home = tempHome();
  const first = await startMockCompletions("first");
  const second = await startMockCompletions("second");
  const catalog = new FileLlmCatalogStore(home);
  const policies = new FileLlmPolicyStore(home);
  const credentials = new FileLlmCredentialStore(home);
  const service = new GlobalLlmService(catalog, policies, credentials, async () => ["alpha", "beta"]);
  const saved = await service.saveConnectionWithCredential(
    {
      displayName: "frozen",
      providerConfig: providerConfig(first.url),
    },
    SHARED_SECRET,
    0,
  );
  const connectionId = Object.keys(saved.connections)[0];
  const route = compileManagedRouteId(connectionId);
  await service.updateSpacePolicy("alpha", { mode: "all" }, 0);
  await service.updateSpacePolicy("beta", { mode: "all" }, 0);
  const catalogState = await catalog.read();
  const snapshot = freezeSpaceSnapshot(catalogState, await policies.read("alpha"), PINNED_DSH_PACKAGE_VERSION);
  mkdirSync(join(home, "hub", "alpha"), { recursive: true });
  writeFileSync(
    join(home, "hub", "alpha", "settings.yaml"),
    `llm-pi-ai:\n  providers:\n    ${route}:\n      api: openai-completions\n      baseURL: ${second.url}\n`,
  );
  const alpha = await openSpaceLlmBridge({
    settingsPath: join(home, "hub", "alpha", "settings.yaml"),
    localCredentialsPath: join(home, "hub", "alpha", ".credentials.yaml"),
    dshHome: join(home, "hub", "alpha"),
    snapshot,
    shared: credentials,
  });
  const beta = await openSpaceLlmBridge({
    settingsPath: join(home, "hub", "beta", "settings.yaml"),
    localCredentialsPath: join(home, "hub", "beta", ".credentials.yaml"),
    dshHome: join(home, "hub", "beta"),
    snapshot: freezeSpaceSnapshot(catalogState, await policies.read("beta"), PINNED_DSH_PACKAGE_VERSION),
    shared: credentials,
  });
  try {
    await attachOfficialLlm(alpha.ctx, alpha.settings);
    await attachOfficialLlm(beta.ctx, beta.settings);
    assert.equal(alpha.settings.bridgeStatus().managedRouteConflict, true);
    await service.saveConnection(
      {
        id: connectionId,
        displayName: "frozen",
        providerConfig: providerConfig(second.url),
        auth: { kind: "api-key", credentialRecordId: compileManagedRecordKey(connectionId, 1) },
      },
      1,
    );
    await assert.rejects(async () => await streamPing(alpha.ctx, route, "demo-large"), {
      code: LLM_ERROR.MANAGED_ROUTE_CONFLICT,
    });
    assert.equal(await streamPing(beta.ctx, route, "demo-large"), "hello-first");
    assert.equal(second.hits.length, 0);
  } finally {
    await alpha.dispose();
    await beta.dispose();
  }
});

test("missing shared record does not use a same-name environment variable", async () => {
  const home = tempHome();
  const mock = await startMockCompletions("env");
  const connectionId = createConnectionId();
  const recordId = compileManagedRecordKey(connectionId, 1);
  const ref = `SPACES_LLM_${connectionId.replaceAll("-", "").toUpperCase()}_R1_API_KEY`;
  const previous = process.env[ref];
  process.env[ref] = SHARED_SECRET;
  const credentials = new FileLlmCredentialStore(home);
  const snapshot = freezeSpaceSnapshot(
    {
      schemaVersion: 1,
      revision: 1,
      connections: {
        [connectionId]: {
          id: connectionId,
          revision: 1,
          displayName: "env-trap",
          enabled: true,
          backend: "llm-pi-ai",
          providerConfig: providerConfig(mock.url),
          auth: { kind: "api-key", credentialRecordId: recordId },
          createdAt: "2026-09-18T00:00:00.000Z",
          updatedAt: "2026-09-18T00:00:00.000Z",
        },
      },
      defaultModel: null,
      retiredConnectionIds: [],
    },
    { schemaVersion: 1, revision: 1, shared: { mode: "all" } },
    PINNED_DSH_PACKAGE_VERSION,
  );
  const space = await openSpaceLlmBridge({
    settingsPath: join(home, "hub", "alpha", "settings.yaml"),
    localCredentialsPath: join(home, "hub", "alpha", ".credentials.yaml"),
    dshHome: join(home, "hub", "alpha"),
    snapshot,
    shared: credentials,
  });
  try {
    await attachOfficialLlm(space.ctx, space.settings);
    await assert.rejects(async () => await streamPing(space.ctx, compileManagedRouteId(connectionId), "demo-large"), {
      code: "MISSING_CREDENTIAL",
    });
    assert.equal(mock.hits.length, 0);
  } finally {
    if (previous === undefined) delete process.env[ref];
    else process.env[ref] = previous;
    await space.dispose();
  }
});

