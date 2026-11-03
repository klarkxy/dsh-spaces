import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/host-exit/parent.mts");
const spawnedParents: ChildProcess[] = [];

afterEach(() => {
  for (const parent of spawnedParents.splice(0)) {
    if (parent.exitCode === null && !parent.killed) {
      try { process.kill(parent.pid!); } catch { /* already gone */ }
    }
  }
});

function startParent(mode: "ipc" | "no-ipc", dir: string): { parent: ChildProcess; childPid: Promise<number> } {
  const parent = spawn(process.execPath, ["--import", "tsx", FIXTURE, mode === "ipc" ? "ipc" : "no-ipc"], {
    env: { ...process.env, HOST_EXIT_TMP: dir, HOST_EXIT_CWD: process.env.TEMP ?? dir },
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  spawnedParents.push(parent);
  const childPid = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("parent did not report a child pid")), 15_000);
    let buf = "";
    parent.stdout!.on("data", (chunk) => {
      buf += String(chunk);
      const match = buf.match(/child=(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    parent.once("error", reject);
  });
  return { parent, childPid };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

test("killing the host process disconnects the supervisor channel and the child exits", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "host-exit-ipc-"));
  const marker = join(dir, "marker.txt");
  try {
    const { parent, childPid } = startParent("ipc", dir);
    const pid = await childPid;
    const killedAt = Date.now();
    process.kill(parent.pid!);
    const sawMarker = await waitFor(() => existsSync(marker), 10_000);
    t.diagnostic(`disconnect->marker latency ${Date.now() - killedAt}ms`);
    assert.equal(sawMarker, true, "child wrote the disconnect marker within 10s");
    assert.equal(await waitFor(() => !processAlive(pid), 10_000), true, "child exited after disconnect");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("without an ipc channel requireHostChannel fails fast and no marker appears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-exit-noipc-"));
  const marker = join(dir, "marker.txt");
  try {
    const { childPid } = startParent("no-ipc", dir);
    const pid = await childPid;
    assert.equal(await waitFor(() => !processAlive(pid), 10_000), true, "child exits non-zero without a channel");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
