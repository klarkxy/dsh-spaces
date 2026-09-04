import assert from "node:assert/strict";
import { test } from "node:test";
import type { PatchWriter } from "../src/main/patch-writer.ts";
import { ProcessManager } from "../src/main/process-manager.ts";

test("start shares one in-flight attempt for the same profile", async () => {
  let verifies = 0;
  const rejectVerify: Array<(reason: Error) => void> = [];
  const patchWriter = {
    verify: () => {
      verifies += 1;
      return new Promise<void>((_resolve, reject) => rejectVerify.push(reject));
    },
  } as Pick<PatchWriter, "verify"> as PatchWriter;
  const processes = new ProcessManager("unused-in-this-test", patchWriter);

  const first = processes.start("notes");
  const second = processes.start("notes");

  assert.equal(second, first);
  assert.equal(verifies, 1);

  rejectVerify[0](new Error("verification failed"));
  await assert.rejects(first, /verification failed/);
  await assert.rejects(second, /verification failed/);

  const retry = processes.start("notes");
  assert.notEqual(retry, first);
  assert.equal(verifies, 2);
  rejectVerify[1](new Error("retry failed"));
  await assert.rejects(retry, /retry failed/);
});
