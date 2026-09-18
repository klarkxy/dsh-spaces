import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { FileLlmCredentialStore } from "../src/adapters/node/llm-credential-store.ts";
import { llmControlDir, llmCredentialsPath } from "../src/adapters/node/llm-paths.ts";
import { compileManagedRecordKey, createConnectionId, LLM_ERROR } from "../src/core/domain/llm-connections.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("official credential records write owner-only files and refuse in-place replace", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-llm-cred-"));
  temps.push(home);
  const store = new FileLlmCredentialStore(home);
  const recordId = compileManagedRecordKey(createConnectionId(), 1);
  const secret = "sk-perm-test-aa";
  await store.writeRecord({ recordId, secret });
  const path = llmCredentialsPath(home);
  assert.equal(existsSync(path), true);
  assert.match(readFileSync(path, "utf8"), new RegExp(secret));
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    assert.equal(statSync(llmControlDir(home)).mode & 0o777, 0o700);
  }
  const official = readFileSync(join(process.cwd(), "node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js"), "utf8");
  assert.match(official, /mode: 384/);
  assert.match(official, /mode: 448/);
  assert.match(official, /POSIX only: Windows has no mode to inspect/);
  await assert.rejects(() => store.writeRecord({ recordId, secret: "sk-replaced-bb" }), {
    code: LLM_ERROR.CONFIG_INVALID,
  });
  assert.equal(await store.readSecret(recordId), secret);
});
