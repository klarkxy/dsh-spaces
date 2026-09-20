import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { HOME_CONTROL_DIR_NAME } from "../src/adapters/node/home-controller.ts";
import { WORKBENCH_JOBS_DIR_NAME } from "../src/adapters/node/workbench-jobs.ts";
import { readDurableJob, waitJob } from "../scripts/verify-component-update.mjs";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-wait-job-"));
  temps.push(dir);
  return dir;
}

function writeJob(root: string, requestId: string, status: string) {
  const dir = join(root, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const row = { id: requestId, requestId, kind: "workbench.prepare", status };
  writeFileSync(join(dir, `${requestId}.json`), `${JSON.stringify(row)}\n`);
  return row;
}

test("waitJob returns durable failed instead of treating unavailable as HTTP closed", async () => {
  const root = home();
  const requestId = "tamper-prepare";
  writeJob(root, requestId, "failed");
  const api = {
    async job() {
      throw Object.assign(new Error("schema"), { code: "workbench/unavailable" });
    },
  };
  const waited = await waitJob(root, api, { id: requestId }, requestId, "tampered prepare", 2_000);
  assert.equal(waited.proof, "durable");
  assert.equal(waited.job.status, "failed");
  assert.equal(waited.job.id, requestId);
  assert.equal(readDurableJob(root, requestId)?.status, "failed");
});

test("waitJob propagates non-unavailable API errors and does not fall back", async () => {
  const root = home();
  const requestId = "auth-denied";
  writeJob(root, requestId, "failed");
  const api = {
    async job() {
      throw Object.assign(new Error("forbidden"), { code: "workbench/forbidden" });
    },
  };
  await assert.rejects(
    () => waitJob(root, api, { id: requestId }, requestId, "denied job", 2_000),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "workbench/forbidden"),
  );
});
