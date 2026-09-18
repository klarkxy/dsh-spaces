import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import {
  compileManagedCredentialRef,
  compileManagedRecordKey,
  compileManagedRouteId,
  createConnectionId,
  type LlmSharedSnapshot,
} from "../src/core/domain/llm-connections.ts";
import { startLocalCredentials } from "./helpers/llm-official.ts";

const temps: string[] = [];
const children: ChildProcess[] = [];
const worker = join(dirname(fileURLToPath(import.meta.url)), "helpers/llm-space-worker.ts");

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("web stays unjoined while A and B consume one shared connection from separate processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-llm-multi-"));
  temps.push(root);
  const connectionId = createConnectionId();
  const recordId = compileManagedRecordKey(connectionId, 1);
  const snapshot: LlmSharedSnapshot = {
    catalogRevision: 2,
    policyRevision: 1,
    connections: [
      {
        id: connectionId,
        revision: 2,
        displayName: "shared-mock",
        enabled: true,
        backend: "llm-pi-ai",
        providerConfig: {
          api: "openai-completions",
          baseURL: "http://127.0.0.1:9/v1",
          models: [{ id: "demo-large" }, { id: "demo-small" }],
        },
        auth: { kind: "api-key", credentialRecordId: recordId },
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      },
    ],
    defaultModel: { connectionId, modelId: "demo-large" },
    adapterVersion: "0.1.5-rc.2",
  };
  const globalCreds = join(root, ".dsh-spaces-control", "llm", "credentials.yaml");
  mkdirSync(dirname(globalCreds), { recursive: true });
  const global = await startLocalCredentials(globalCreds, root);
  const [scope, id] = recordId.split("/");
  await global.credentials.modifyRecord(credentialKey(scope, id), async () => ({
    kind: "api-key",
    key: "sk-shared-once",
  }));

  const web = await spawnSpace(root, "web", null, null);
  const a = await spawnSpace(root, "space-a", snapshot, globalCreds);
  const b = await spawnSpace(root, "space-b", snapshot, globalCreds);

  await call(a, { op: "update-theme", color: "red" });
  await call(b, { op: "update-theme", color: "blue" });
  await call(web, { op: "update-theme", color: "web" });
  await call(a, { op: "update-default-model", provider: compileManagedRouteId(connectionId), model: "demo-small" });

  const aStatus = await call(a, { op: "status" });
  const bStatus = await call(b, { op: "status" });
  const webStatus = await call(web, { op: "status" });
  const route = compileManagedRouteId(connectionId);
  assert.equal(aStatus.result.theme.color, "red");
  assert.equal(bStatus.result.theme.color, "blue");
  assert.equal(webStatus.result.theme.color, "web");
  assert.equal(aStatus.result.llm.providers[route].baseURL, "http://127.0.0.1:9/v1");
  assert.equal(bStatus.result.llm.providers[route].baseURL, "http://127.0.0.1:9/v1");
  assert.equal(Boolean(webStatus.result.llm.providers?.[route]), false);
  assert.equal(aStatus.result.defaultModel.model, "demo-small");
  assert.equal(bStatus.result.defaultModel.model, "demo-large");

  const denied = await call(a, { op: "try-update-managed" });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "LLM_SHARED_CONNECTION_READ_ONLY");

  const resolved = await call(a, { op: "resolve-managed-credential" });
  assert.equal(resolved.result.value, "sk-shared-once");
  assert.equal(resolved.result.source, "spaces-global");
  const described = await call(b, { op: "describe-managed-credential" });
  assert.equal(described.result.writable, false);

  const aFiles = await call(a, { op: "files" });
  const bFiles = await call(b, { op: "files" });
  const webFiles = await call(web, { op: "files" });
  assert.match(aFiles.result.settings, /color: red/);
  assert.match(bFiles.result.settings, /color: blue/);
  assert.match(webFiles.result.settings, /color: web/);
  assert.doesNotMatch(aFiles.result.settings, /sk-shared-once|spaces-llm-/);
  assert.doesNotMatch(bFiles.result.settings, /sk-shared-once|spaces-llm-/);
  assert.doesNotMatch(aFiles.result.credentials, /sk-shared-once/);
  assert.doesNotMatch(bFiles.result.credentials, /sk-shared-once/);
  assert.doesNotMatch(webFiles.result.settings, /spaces-llm-/);
});

async function spawnSpace(
  root: string,
  spaceId: string,
  snapshot: LlmSharedSnapshot | null,
  sharedCredentialsPath: string | null,
): Promise<{ port: number; child: ChildProcess }> {
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
        sharedCredentialsPath,
      }),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  const port = await waitForPort(child);
  return { port, child };
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
  return (await response.json()) as { ok: boolean; code?: string; result?: any };
}
