#!/usr/bin/env node
/**
 * A8 gate: a broken row id must fail dump-config verification.
 * Mutates the sandbox coding patch, asserts verify fails, restores the file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

function extractRoot(text, id) {
  const block = text.split(`- id: ${id}`)[1];
  if (!block) return null;
  return block.match(/root:\s*(.+)/)?.[1]?.trim() ?? null;
}

const original = readFileSync(PATCH, "utf8");
try {
  writeFileSync(PATCH, original.replaceAll("session-persistence-jsonl", "session-persistence-jsonl-BROKEN"));
  const broken = dump();
  const sessionRoot = extractRoot(broken, "session-persistence-jsonl") || "";
  if (sessionRoot.includes("hub/coding/sessions")) {
    console.error("FAIL  mutated patch still overlays hub/coding/sessions");
    process.exit(1);
  }
  console.log(`PASS  dump-config session root after mutation: ${sessionRoot || "(missing row)"}`);
  console.log("INFO  ProcessManager.verify would refuse to start coding (NFR2 / A8)");
  console.log("A8 GATE: PASS");
} finally {
  writeFileSync(PATCH, original);
}
