import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consumeCleanStopSpaces, writeCleanStopSpaces, CLEAN_STOP_SPACES_FILE, type CleanStopSpacesRecord } from "../../src/adapters/node/supervisor/clean-stop-ledger.ts";

function root(): { home: string; controlDir: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "dsh-clean-stop-ledger-"));
  const controlDir = join(home, ".dsh-spaces-control");
  mkdirSync(controlDir, { recursive: true });
  return { home, controlDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function record(ids: string[] = ["space-alpha"]): CleanStopSpacesRecord {
  return {
    schemaVersion: 1,
    previousServiceEpoch: "a".repeat(64),
    reason: "signal",
    recordedAt: "2026-01-01T00:00:00.000Z",
    runningSpaceIds: ids,
  };
}

test("write and consume return the record and delete the ledger", () => {
  const { controlDir, cleanup } = root();
  try {
    writeCleanStopSpaces(controlDir, record(["space-alpha", "space-beta"]));
    assert.deepEqual(consumeCleanStopSpaces(controlDir), record(["space-alpha", "space-beta"]));
    assert.equal(existsSync(join(controlDir, CLEAN_STOP_SPACES_FILE)), false);
  } finally { cleanup(); }
});

test("consume returns null when the ledger is missing", () => {
  const { controlDir, cleanup } = root();
  try {
    assert.equal(consumeCleanStopSpaces(controlDir), null);
  } finally { cleanup(); }
});

test("invalid JSON is rejected and left unchanged", () => {
  const { controlDir, cleanup } = root();
  try {
    const path = join(controlDir, CLEAN_STOP_SPACES_FILE);
    writeFileSync(path, "{not json");
    assert.throws(() => consumeCleanStopSpaces(controlDir), /JSON is invalid/);
    assert.equal(readFileSync(path, "utf8"), "{not json");
  } finally { cleanup(); }
});

test("an invalid schema is rejected and left unchanged", () => {
  const { controlDir, cleanup } = root();
  try {
    const path = join(controlDir, CLEAN_STOP_SPACES_FILE);
    writeFileSync(path, JSON.stringify({ ...record(), runningSpaceIds: ["not-a-space-id"] }));
    assert.throws(() => consumeCleanStopSpaces(controlDir), /schema is invalid/);
    assert.equal(existsSync(path), true);
  } finally { cleanup(); }
});

test("a ledger path alias is rejected and left unchanged", () => {
  const { home, controlDir, cleanup } = root();
  try {
    const target = join(home, "ledger-target");
    mkdirSync(target);
    const path = join(controlDir, CLEAN_STOP_SPACES_FILE);
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => consumeCleanStopSpaces(controlDir), /not a regular file/);
    assert.equal(existsSync(path), true);
  } finally { cleanup(); }
});
