import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FileLlmCatalogStore } from "../src/adapters/node/llm-catalog-store.ts";
import { FileLlmCredentialStore } from "../src/adapters/node/llm-credential-store.ts";
import { FileLlmPolicyStore } from "../src/adapters/node/llm-policy-store.ts";
import { GlobalLlmService } from "../src/core/application/global-llm-service.ts";
import { compileManagedRouteId, createConnectionId, type LlmSharedSnapshot } from "../src/core/domain/llm-connections.ts";
import { freezeSpaceSnapshot } from "../packages/llm-bridge/src/space-bridge.ts";
import { PINNED_DSH_PACKAGE_VERSION } from "./helpers/llm-official.ts";

const temps: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
const worker = join(dirname(fileURLToPath(import.meta.url)), "helpers/llm-space-worker.ts");
const SHARED_SECRET = "sk-shared-once";

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type MockHit = { auth?: string; url: string; model?: string };

function startMock(label: string): Promise<{ url: string; hits: MockHit[] }> {
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
      resolve({ url: `http://127.0.0.1:${address.port}/v1`, hits });
    });
  });
}

test("three processes stream one shared official route while an unjoined space stays local-only", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-llm-int-"));
  temps.push(root);
  const first = await startMock("shared-v1");
  const second = await startMock("shared-v2");
  const catalog = new FileLlmCatalogStore(root);
  const policies = new FileLlmPolicyStore(root);
  const credentials = new FileLlmCredentialStore(root);
  const service = new GlobalLlmService(catalog, policies, credentials, async () => ["web", "alpha", "beta"]);
  const saved = await service.saveConnectionWithCredential(
    {
      displayName: "shared-mock",
      providerConfig: {
        api: "openai-completions",
        baseURL: first.url,
        models: [{ id: "demo-large" }],
        retryPolicy: { mode: "normal", maxRetries: 0 },
      },
    },
    SHARED_SECRET,
    0,
  );
  const connectionId = Object.keys(saved.connections)[0] ?? createConnectionId();
  await service.updateSpacePolicy("alpha", { mode: "selected", connectionIds: [connectionId] }, 0);
  await service.updateSpacePolicy("beta", { mode: "all" }, 0);
  const snapshot: LlmSharedSnapshot = freezeSpaceSnapshot(
    await catalog.read(),
    await policies.read("alpha"),
    PINNED_DSH_PACKAGE_VERSION,
  );
  const betaSnapshot = freezeSpaceSnapshot(await catalog.read(), await policies.read("beta"), PINNED_DSH_PACKAGE_VERSION);
  const sharedCredentialsPath = join(root, ".dsh-spaces-control", "llm", "credentials.yaml");
  const unjoined = await spawnSpace(root, "unjoined", null, null);
  const alpha = await spawnSpace(root, "space-a", snapshot, sharedCredentialsPath);
  const beta = await spawnSpace(root, "space-b", betaSnapshot, sharedCredentialsPath);
  assert.equal(children.length, 3);

  const route = compileManagedRouteId(connectionId);
  const aText = await call(alpha, { op: "stream", provider: route, model: "demo-large" });
  const bText = await call(beta, { op: "stream", provider: route, model: "demo-large" });
  assert.equal(aText.ok, true, JSON.stringify(aText));
  assert.equal(bText.ok, true);
  assert.equal(aText.result.text, "hello-shared-v1");
  assert.equal(bText.result.text, "hello-shared-v1");
  assert.equal(first.hits.length, 2);
  assert.equal(first.hits.every((hit) => hit.auth === `Bearer ${SHARED_SECRET}`), true);
  assert.equal(first.hits.every((hit) => hit.model === "demo-large"), true);

  const unjoinedStream = await call(unjoined, { op: "stream", provider: route, model: "demo-large" });
  assert.equal(unjoinedStream.ok, false);

  await service.saveConnectionWithCredential(
    {
      id: connectionId,
      displayName: "shared-mock",
      providerConfig: {
        api: "openai-completions",
        baseURL: second.url,
        models: [{ id: "demo-large" }],
        retryPolicy: { mode: "normal", maxRetries: 0 },
      },
    },
    "sk-rotated-key",
    1,
  );
  const again = await call(alpha, { op: "stream", provider: route, model: "demo-large" });
  assert.equal(again.ok, true);
  assert.equal(again.result.text, "hello-shared-v1");
  assert.equal(second.hits.length, 0);
  assert.equal(first.hits.length, 3);
  assert.equal(children.length, 3);
});

async function spawnSpace(
  root: string,
  spaceId: string,
  snapshot: LlmSharedSnapshot | null,
  sharedCredentialsPath: string | null,
): Promise<{ port: number }> {
  const home = join(root, spaceId);
  mkdirSync(home, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      worker,
      JSON.stringify({
        spaceId,
        home,
        settingsPath: join(home, "settings.yaml"),
        credentialsPath: join(home, ".credentials.yaml"),
        snapshot,
        sharedHome: root,
        sharedCredentialsPath,
      }),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  return { port: await waitForPort(child) };
}

function waitForPort(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const fail = (error: Error) => {
      child.stderr?.off("data", onErr);
      child.stdout?.off("data", onOut);
      reject(error);
    };
    const onErr = (chunk: Buffer | string) => {
      buffer += String(chunk);
    };
    const onOut = (chunk: Buffer | string) => {
      buffer += String(chunk);
      const match = buffer.match(/LISTENING (\d+)/);
      if (match) {
        child.stderr?.off("data", onErr);
        child.stdout?.off("data", onOut);
        resolve(Number(match[1]));
      }
    };
    child.stderr?.on("data", onErr);
    child.stdout?.on("data", onOut);
    child.once("exit", (code) => fail(new Error(`worker exited ${code}: ${buffer}`)));
    child.once("error", fail);
  });
}

async function call(space: { port: number }, body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${space.port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as { ok: boolean; code?: string; result?: { text?: string } };
}
