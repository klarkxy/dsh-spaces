import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runProcess } from "../src/main/toolchain.ts";

test("command timeout waits for the parent and grandchild to exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "spaces-command-timeout-"));
  const file = join(root, "pids.json");
  const script = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
require('node:fs').writeFileSync(process.env.DSH_TEST_PIDS,JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`;
  try {
    await assert.rejects(runProcess(process.execPath, ["-e", script], { timeoutMs: 1500, env: { ...process.env, DSH_TEST_PIDS: file } }), /timed out/);
    const ids = JSON.parse(readFileSync(file, "utf8")) as number[];
    for (const pid of ids) assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
