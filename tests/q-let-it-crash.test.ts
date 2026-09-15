import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { main as doctorMain } from "../packages/doctor/src/index.ts";
import { WorkbenchJobStore } from "../src/adapters/node/workbench-jobs.ts";
import { runBatch } from "../src/shared/batch.ts";
import { formatWorkbenchFailure } from "../src/shared/workbench.ts";
import { importSpaceArchive, parseSpaceShare } from "../src/main/space-share.ts";
import { packZip } from "../src/main/space-share-zip.ts";
import { SPACE_SHARE_FORMAT_VERSION, SPACE_SHARE_KIND } from "../src/shared/space-share.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-q-"));
  temps.push(dir);
  mkdirSync(join(dir, "profiles"), { recursive: true });
  return dir;
}

test("E01 install failure names package and stage and does not retry", async () => {
  const text = formatWorkbenchFailure({
    spaceId: "coding",
    stage: "install",
    packageName: "dsh-outline@1.2.3",
    pluginAttribution: "known",
    reason: "cli exited 1",
    exitCode: 1,
  });
  assert.match(text, /空间 coding/);
  assert.match(text, /插件：dsh-outline@1.2.3/);
  assert.match(text, /退出码：1/);
  assert.equal(text.includes("latest"), false);
  assert.equal(/建议|恢复|重试/.test(text), false);
});

test("E06 leftover running jobs fail in place and are not replayed", async () => {
  const home = tempHome();
  const jobsDir = join(home, ".dsh-spaces-control", "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const body = {
    schemaVersion: 1,
    id: "job-left",
    requestId: "job-left",
    kind: "space.start",
    command: { kind: "space.start", spaceId: "coding" },
    commandCanonical: JSON.stringify({ kind: "space.start", spaceId: "coding" }),
    status: "running",
    phase: "start",
    message: "starting",
    affectedSpaceIds: ["coding"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canCancel: true,
  };
  writeFileSync(join(jobsDir, "job-left.json"), `${JSON.stringify(body)}\n`);
  const store = new WorkbenchJobStore({ home });
  const job = store.job("job-left");
  assert.equal(job.status, "failed");
  assert.match(job.error?.message ?? job.message, /interrupted|unconfirmed|failed/i);
  let ran = 0;
  await store.submit({ kind: "space.start", spaceId: "coding" }, "job-new", async () => {
    ran += 1;
  });
  await store.whenIdle();
  assert.equal(ran, 1);
  assert.equal(store.job("job-left").status, "failed");
});

test("E08 batch A kept, B failed, C not run", async () => {
  const ran: string[] = [];
  const result = await runBatch(["A", "B", "C"], async (item) => {
    ran.push(item);
    if (item === "B") throw new Error("boom");
  });
  assert.deepEqual(ran, ["A", "B"]);
  assert.deepEqual(result.succeeded, ["A"]);
  assert.equal(result.failed?.item, "B");
  assert.deepEqual(result.skipped, ["C"]);
});

test("E11 unreadable job bytes stay and do not look succeeded", () => {
  const home = tempHome();
  const jobsDir = join(home, ".dsh-spaces-control", "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const raw = "{\"schemaVersion\":99,\"status\":\"running\"";
  writeFileSync(join(jobsDir, "bad.json"), raw);
  const store = new WorkbenchJobStore({ home });
  const job = store.list().find((row) => row.id === "bad");
  assert.ok(job);
  assert.equal(job.status, "failed");
  assert.notEqual(job.status, "succeeded");
  assert.equal(readFileSync(join(jobsDir, "bad.json"), "utf8"), raw);
});

test("E14 import of an incompatible combo keeps the space and does not start it", async () => {
  const archive = packZip([
    {
      name: "manifest.json",
      data: Buffer.from(`${JSON.stringify({
        formatVersion: SPACE_SHARE_FORMAT_VERSION,
        kind: SPACE_SHARE_KIND,
        exportedAt: "2026-09-15T00:00:00.000Z",
        source: {},
        space: { displayName: "Combo" },
      })}\n`),
    },
    {
      name: "plugins.json",
      data: Buffer.from(`${JSON.stringify([
        { packageName: "good", resolvedVersion: "1.0.0", source: "npm", installSpec: "good@1.0.0" },
        { packageName: "bad", resolvedVersion: "1.0.0", source: "npm", installSpec: "bad@1.0.0" },
      ])}\n`),
    },
  ]);
  parseSpaceShare(archive);
  const created: string[] = [];
  const installed: string[] = [];
  const result = await importSpaceArchive(archive, {
    listSpaceIds: () => [],
    createSpace: async (input) => {
      created.push(input.name);
    },
    installPlugin: async (_id, spec) => {
      if (spec.startsWith("bad@")) throw new Error("incompatible");
      installed.push(spec);
    },
  });
  assert.equal(result.definition, "imported");
  assert.equal(result.plugins, "failed");
  assert.equal(result.start, "not-run");
  assert.equal(created.length, 1);
  assert.deepEqual(installed, ["good@1.0.0"]);
});

test("E15 doctor recover is unsupported and does not rewrite Home", async () => {
  const home = tempHome();
  const marker = join(home, "settings.yaml");
  writeFileSync(marker, "keep\n");
  const before = readFileSync(marker);
  const code = await doctorMain(["recover", "--home", home]);
  assert.equal(code, 7);
  assert.deepEqual(readFileSync(marker), before);
});

test("E16 doctor inspect does not clear leftover jobs", async () => {
  const home = tempHome();
  const jobsDir = join(home, ".dsh-spaces-control", "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const raw = `${JSON.stringify({
    schemaVersion: 1,
    id: "job-left",
    requestId: "job-left",
    kind: "space.start",
    command: { kind: "space.start", spaceId: "coding" },
    commandCanonical: "{}",
    status: "failed",
    phase: "start",
    message: "interrupted",
    affectedSpaceIds: ["coding"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canCancel: false,
  })}\n`;
  writeFileSync(join(jobsDir, "job-left.json"), raw);
  const code = await doctorMain(["doctor", "--home", home]);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(jobsDir, "job-left.json"), "utf8"), raw);
});
