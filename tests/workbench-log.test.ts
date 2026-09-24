import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { WorkbenchLog, WORKBENCH_LOG_FILE, WORKBENCH_LOG_MAX_ENTRIES } from "../src/adapters/node/workbench-log.ts";
import { WORKBENCH_CONTROL_DIR_NAME } from "../src/adapters/node/workbench-jobs.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-workbench-log-"));
  temps.push(dir);
  return dir;
}

function logFile(dir: string): string {
  return join(dir, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_LOG_FILE);
}

test("workbench log redacts secrets and paths and keeps the code", () => {
  const dir = home();
  const log = new WorkbenchLog(dir, () => new Date("2026-09-22T00:00:00.000Z"));
  const entry = log.append({
    level: "error",
    area: "http",
    event: "product.catalog",
    code: "workbench/failed",
    message: "cache unreadable token=supersecret C:\\Users\\secret\\catalog.json",
  });
  assert.equal(entry.message.includes("supersecret"), false);
  assert.equal(entry.message.includes("C:\\"), false);
  assert.match(entry.message, /cache unreadable/);
  assert.equal(entry.code, "workbench/failed");
  const stored = readFileSync(logFile(dir), "utf8");
  assert.equal(stored.includes("supersecret"), false);
  assert.equal(stored.includes("C:\\"), false);
  const read = log.read();
  assert.equal(read.logError, null);
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0]?.event, "product.catalog");
});

test("workbench log keeps a bounded tail and drops the oldest lines", () => {
  const dir = home();
  let tick = 0;
  const log = new WorkbenchLog(dir, () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
  for (let i = 0; i < WORKBENCH_LOG_MAX_ENTRIES + 3; i += 1) {
    log.append({ level: "info", area: "http", event: "state", message: `line ${i}` });
  }
  const read = log.read();
  assert.equal(read.logError, null);
  assert.equal(read.entries.length, WORKBENCH_LOG_MAX_ENTRIES);
  assert.equal(read.entries[0]?.message, "line 3");
  assert.equal(read.entries.at(-1)?.message, `line ${WORKBENCH_LOG_MAX_ENTRIES + 2}`);
});

test("a damaged workbench log is reported and left unchanged", () => {
  const dir = home();
  const log = new WorkbenchLog(dir, () => new Date("2026-09-22T00:00:00.000Z"));
  log.append({ level: "warn", area: "maintenance", event: "snapshot.create", message: "first" });
  const path = logFile(dir);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, `${original}{"nope":true}\n`);
  const read = log.read();
  assert.equal(read.entries.length, 1);
  assert.match(read.logError ?? "", /was not rewritten/);
  assert.throws(() => log.append({ level: "error", area: "http", event: "state", message: "later" }), /was not rewritten/);
  assert.equal(readFileSync(path, "utf8"), `${original}{"nope":true}\n`);
});

test("a symlinked workbench log is not followed", () => {
  const dir = home();
  const outside = mkdtempSync(join(tmpdir(), "dsh-workbench-log-outside-"));
  temps.push(outside);
  const target = join(outside, "secret.jsonl");
  writeFileSync(target, "token=keep\n");
  const path = logFile(dir);
  mkdirSync(join(dir, WORKBENCH_CONTROL_DIR_NAME), { recursive: true });
  try {
    symlinkSync(target, path);
  } catch {
    return;
  }
  const log = new WorkbenchLog(dir);
  const read = log.read();
  assert.match(read.logError ?? "", /not a regular file/);
  assert.throws(() => log.append({ level: "error", area: "client", event: "request", message: "nope" }));
  assert.equal(readFileSync(target, "utf8"), "token=keep\n");
});
