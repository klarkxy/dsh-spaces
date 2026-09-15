import assert from "node:assert/strict";
import { test } from "node:test";
import { runBatch } from "../src/shared/batch.ts";

test("runBatch keeps A, fails B, and does not run C", async () => {
  const ran: string[] = [];
  const result = await runBatch(["A", "B", "C"], async (item) => {
    ran.push(item);
    if (item === "B") throw new Error("B failed");
  });
  assert.deepEqual(ran, ["A", "B"]);
  assert.deepEqual(result.succeeded, ["A"]);
  assert.equal(result.failed?.item, "B");
  assert.equal(result.failed?.error, "B failed");
  assert.deepEqual(result.skipped, ["C"]);
});
