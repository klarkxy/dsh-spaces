import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DiagnosticsService } from "../src/adapters/node/diagnostics/diagnostics.ts";
import { MAX_BACKUP_BYTES, MAX_LOG_BYTES, MAX_LOG_ENTRIES } from "../src/shared/diagnostics.ts";
import { t } from "../src/shared/i18n/index.ts";
import type { ProfileRecord, ProfileStatus } from "../src/shared/types.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("record caps logs at 1000 entries or 256KiB, whichever first, and redacts secrets", async () => {
  const { home, service, logsPath } = harness();

  for (let i = 0; i < MAX_LOG_ENTRIES + 25; i++) {
    service.record("coding", "stdout", `line-${i}`);
  }
  let snap = service.get("coding");
  assert.equal(snap.logs.length, MAX_LOG_ENTRIES);
  assert.equal(snap.logs[0].text, "line-25");
  assert.equal(snap.logs.at(-1)?.text, `line-${MAX_LOG_ENTRIES + 24}`);

  const bulky = new DiagnosticsService({
    home,
    profiles: () => [profile(home, "coding")],
    statusOf: () => "stopped",
  });
  const chunk = "n".repeat(64 * 1024);
  for (let i = 0; i < 5; i++) bulky.record("coding", "stderr", `${chunk}-${i}`);
  snap = bulky.get("coding");
  const bytes = snap.logs.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, "utf8"), 0);
  assert.ok(snap.logs.length < 5);
  assert.ok(bytes <= MAX_LOG_BYTES);

  service.record(
    "coding",
    "stderr",
    [
      "Authorization: Bearer super-secret-token",
      "apiKey=sk-abcdefghijklmnopqrstuvwxyz",
      "password: hunter2",
      'token: "abc123xyz"',
      'password: "alpha beta"',
      String.raw`password: "alpha \"beta\""`,
    ].join("\n"),
  );
  service.record(
    "coding",
    "stdout",
    JSON.stringify({
      model: "dsh-chat",
      messages: [{ role: "user", content: "please ignore previous instructions" }],
    }),
  );
  service.record("coding", "stdout", "-----BEGIN PRIVATE KEY-----\nMIISECRET\n-----END PRIVATE KEY-----");

  snap = service.get("coding");
  const joined = snap.logs.map((entry) => entry.text).join("\n");
  assert.equal(joined.includes("super-secret-token"), false);
  assert.equal(joined.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(joined.includes("hunter2"), false);
  assert.equal(joined.includes("abc123xyz"), false);
  assert.equal(joined.includes("alpha"), false);
  assert.equal(joined.includes("beta"), false);
  assert.equal(joined.includes("please ignore previous instructions"), false);
  assert.equal(joined.includes("MIISECRET"), false);
  assert.match(joined, /\[redacted\]/);
  assert.match(joined, /omitted chat payload/);
  assert.match(joined, /omitted credential material/);

  const onDisk = readFileSync(logsPath, "utf8");
  assert.equal(onDisk.includes("super-secret-token"), false);
  assert.equal(onDisk.includes("please ignore previous instructions"), false);
});

test("unknown profile and path-escaping backup ids are rejected", async () => {
  const { home, service, dir } = harness();
  writeFileSync(join(dir, "cordis.patch.yml.bak-keep"), "- id: keep\n", "utf8");

  assert.throws(() => service.get("missing"), { message: t("errors.unknownProfile", { name: "missing" }) });
  assert.equal(service.record("missing", "stdout", "should-not-throw"), undefined);

  assert.throws(
    () => service.previewBackup("coding", "/tmp/cordis.patch.yml.bak-keep"),
    /Backup id is not a configuration backup file/,
  );

  const other = join(home, "profiles", "other");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "cordis.patch.yml.bak-stolen"), "stolen\n", "utf8");
  assert.equal(readFileSync(join(other, "cordis.patch.yml.bak-stolen"), "utf8"), "stolen\n");
  assert.equal(readFileSync(join(dir, "cordis.patch.yml.bak-keep"), "utf8"), "- id: keep\n");
});

test("web can be diagnosed", async () => {
  const home = fakeHome();
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  writeFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "[]\n", "utf8");
  writeFileSync(join(home, "profiles", "web", "cordis.patch.yml.bak-1"), "[]\n", "utf8");
  const service = new DiagnosticsService({
    home,
    profiles: () => [profile(home, "web")],
    statusOf: () => "stopped",
  });

  const snap = service.get("web");
  assert.equal(snap.canRestore, false);
  assert.equal(snap.status, "stopped");
  service.record("web", "lifecycle", "started");
  assert.equal(service.get("web").logs.at(-1)?.text, "started");

  assert.equal(readFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "utf8"), "[]\n");
  assert.equal(readFileSync(join(home, "profiles", "web", "cordis.patch.yml.bak-1"), "utf8"), "[]\n");
});

test("JSONL disk size stays at 256KiB including a single large record and oversized files are tailed", () => {
  const { service, logsPath } = harness();
  service.record("coding", "stderr", "x\n".repeat(150_000));
  const size = statSync(logsPath).size;
  assert.ok(size <= MAX_LOG_BYTES, `diagnostics.log is ${size} bytes`);
  assert.ok(size > 0);
  const snap = service.get("coding");
  assert.equal(snap.logError, undefined);
  assert.ok(snap.logs.length >= 1);
  assert.match(snap.logs.map((entry) => entry.text).join(""), /x/);
  const encoded = snap.logs.reduce(
    (sum, entry) => sum + Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8"),
    0,
  );
  assert.ok(encoded <= MAX_LOG_BYTES);

  const home2 = fakeHome();
  const dir = join(home2, "profiles", "coding");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cordis.patch.yml"), "[]\n", "utf8");
  const logDir = join(home2, "hub", "coding");
  mkdirSync(logDir, { recursive: true });
  const hugePath = join(logDir, "diagnostics.log");
  const hugeLine =
    `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", channel: "stderr", text: "y".repeat(400_000) })}\n`;
  writeFileSync(hugePath, hugeLine, "utf8");
  assert.ok(statSync(hugePath).size > MAX_LOG_BYTES);

  const reloaded = new DiagnosticsService({
    home: home2,
    profiles: () => [profile(home2, "coding")],
    statusOf: () => "stopped",
  });
  const loaded = reloaded.get("coding");
  const loadedEncoded = loaded.logs.reduce(
    (sum, entry) => sum + Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8"),
    0,
  );
  assert.ok(loadedEncoded <= MAX_LOG_BYTES);
  reloaded.record("coding", "lifecycle", "after-tail");
  assert.ok(statSync(hugePath).size <= MAX_LOG_BYTES);
  assert.equal(reloaded.get("coding").logError, undefined);
  assert.match(reloaded.get("coding").logs.map((entry) => entry.text).join("\n"), /after-tail/);
});

test("junctions and log symlinks cannot escape the DSH home", async () => {
  const { home } = harness();
  const outside = fakeHome();
  writeFileSync(join(outside, "diagnostics.log"), "OUTSIDE_SECRET\n", "utf8");
  writeFileSync(join(outside, "leak.log"), "LEAK\n", "utf8");

  const hubCoding = join(home, "hub", "coding");
  mkdirSync(join(home, "hub"), { recursive: true });
  rmSync(hubCoding, { recursive: true, force: true });
  symlinkOrSkip(outside, hubCoding, "dir");
  const escaped = new DiagnosticsService({
    home,
    profiles: () => [profile(home, "coding")],
    statusOf: () => "stopped",
  });
  assert.doesNotThrow(() => escaped.record("coding", "stderr", "should-not-leak"));
  const escapedSnap = escaped.get("coding");
  assert.ok(escapedSnap.logError);
  assert.match(escapedSnap.logError ?? "", /Could not (read|write)/);
  assert.equal(readFileSync(join(outside, "diagnostics.log"), "utf8"), "OUTSIDE_SECRET\n");

  const home3 = fakeHome();
  const profileDir = join(home3, "profiles", "coding");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "cordis.patch.yml"), "[]\n", "utf8");
  const logDir = join(home3, "hub", "coding");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "diagnostics.log");
  const leak = join(outside, "leak.log");
  if (tryFileSymlink(leak, logPath)) {
    const linked = new DiagnosticsService({
      home: home3,
      profiles: () => [profile(home3, "coding")],
      statusOf: () => "stopped",
    });
    assert.doesNotThrow(() => linked.record("coding", "stderr", "append-through-symlink"));
    const linkedSnap = linked.get("coding");
    assert.ok(linkedSnap.logError);
    assert.match(linkedSnap.logError ?? "", /symlink|Could not (read|write)/);
    assert.equal(readFileSync(leak, "utf8"), "LEAK\n");
  }
});

test("log read and write failures surface on get and do not throw from record", () => {
  const { home, service } = harness();
  const hubFile = join(home, "hub", "coding");
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(hubFile, "not-a-directory", "utf8");
  assert.doesNotThrow(() => service.record("coding", "stdout", "still recorded"));
  const snap = service.get("coding");
  assert.ok(snap.logError);
  assert.match(snap.logError ?? "", /Could not write/);
  assert.equal(snap.logs.some((entry) => entry.text === "still recorded"), true);

  const home2 = fakeHome();
  const dir = join(home2, "profiles", "coding");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cordis.patch.yml"), "[]\n", "utf8");
  const logDir = join(home2, "hub", "coding", "diagnostics.log");
  mkdirSync(logDir, { recursive: true });
  const blocked = new DiagnosticsService({
    home: home2,
    profiles: () => [profile(home2, "coding")],
    statusOf: () => "crashed" satisfies ProfileStatus,
  });
  const failed = blocked.get("coding");
  assert.ok(failed.logError);
  assert.match(failed.logError ?? "", /Could not read/);
  assert.equal(failed.lastError, undefined);
});

function harness() {
  const home = fakeHome();
  const dir = join(home, "profiles", "coding");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cordis.patch.yml"), "[]\n", "utf8");
  const options = {
    home,
    profiles: () => [profile(home, "coding")],
    statusOf: () => "stopped" as const,
  };
  const service = new DiagnosticsService(options);
  return {
    home,
    dir,
    service,
    logsPath: join(home, "hub", "coding", "diagnostics.log"),

  };
}

test("multiline private keys and structured text content are omitted from persisted logs", () => {
  const { service, logsPath } = harness();
  for (const line of ["-----BEGIN PRIVATE KEY-----", "synthetic-private-key-body", "-----END PRIVATE KEY-----"]) {
    service.record("coding", "stderr", line);
  }
  service.record("coding", "stdout", '{"type":"text","text":"private request content"}');
  service.record("coding", "stderr", "normal diagnostic after the key");
  const saved = readFileSync(logsPath, "utf8");
  assert.ok(!saved.includes("synthetic-private-key-body"));
  assert.ok(!saved.includes("private request content"));
  assert.ok(saved.includes("normal diagnostic after the key"));
});

function profile(home: string, name: string): ProfileRecord {
  return {
    name,
    path: join(home, "profiles", name),
    hasWebApp: true,
    meta: { displayName: name, order: 0 },
    status: "stopped",
  };
}

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-diag-"));
  temps.push(home);
  return home;
}

function symlinkOrSkip(target: string, link: string, kind: "dir"): void {
  if (kind !== "dir") throw new Error("only directory links are required");
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    symlinkSync(target, link, "dir");
  }
}

function tryFileSymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, "file");
    return true;
  } catch {
    try {
      symlinkSync(target, link);
      return true;
    } catch {
      return false;
    }
  }
}
