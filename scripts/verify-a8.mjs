#!/usr/bin/env node
/**
 * A8 gate: a broken row id must fail dump-config verification.
 * Mutates the sandbox coding patch, asserts verify fails, restores the file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = resolve(process.env.DSH_SPACES_HOME || join(REPO, ".sandbox", "dsh-home"));
const REAL = join(homedir(), ".dsh");
const PATCH = join(HOME, "profiles", "coding", "cordis.patch.yml");

if (resolve(HOME).toLowerCase() === resolve(REAL).toLowerCase()) {
  throw new Error("refusing real ~/.dsh");
}

function dshBin() {
  const explicit = process.env.DSH_TEST_BIN || process.env.DSH_TEST_CLI_BIN;
  if (explicit) {
    const bin = resolve(explicit);
    if (!existsSync(bin)) throw new Error("Explicit DSH test CLI is missing");
    return bin;
  }
  const win = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
    : "";
  if (win && existsSync(win)) return win;
  const probe = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true });
  const root = (probe.stdout || "").trim();
  const candidate = join(root, "@deepseek-ai", "dsh", "lib", "bin.js");
  if (existsSync(candidate)) return candidate;
  throw new Error("dsh CLI not found");
}

function dump() {
  const result = spawnSync(
    process.execPath,
    [dshBin(), "--profile", "coding", "--dump-config"],
    { env: { ...process.env, DSH_HOME: HOME }, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "dump-config failed");
  }
  return result.stdout;
}

const { assertDumpPatched, PatchVerifyError } = await import(pathToFileURL(join(REPO, "src", "core", "domain", "isolation.ts")).href);
const original = readFileSync(PATCH, "utf8");
const brokenPatch = original.replaceAll("session-persistence-jsonl", "session-persistence-jsonl-BROKEN");
assert.notEqual(brokenPatch, original, "A8 fixture must contain the session persistence row");
// Establish the positive control before changing this isolated fixture.
assertDumpPatched(dump(), "coding");
try {
  writeFileSync(PATCH, brokenPatch);
  assert.throws(() => assertDumpPatched(dump(), "coding"), PatchVerifyError,
    "The production verifier must reject the malformed isolation row");
  console.log("PASS  production assertDumpPatched rejected the malformed row id");
  console.log("A8 GATE: PASS");
} finally {
  writeFileSync(PATCH, original);
}
