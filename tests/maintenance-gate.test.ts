import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MaintenanceGate } from "../src/core/application/maintenance-gate.ts";

test("run acquires synchronously and rejects a parallel holder", async () => {
  const gate = new MaintenanceGate();
  let released = false;
  const first = gate.run("upgrade", async () => {
    await delay(40);
    released = true;
    return "ok";
  });
  assert.equal(gate.busy, true);
  assert.equal(gate.current, "upgrade");
  assert.throws(() => gate.run("restore", async () => "no"), /already running \(upgrade\)/);
  assert.throws(() => gate.runMutation(async () => "no"), /while maintenance is running/);
  assert.equal(await first, "ok");
  assert.equal(released, true);
  assert.equal(gate.busy, false);
  assert.equal(gate.current, undefined);
});

test("failed maintenance releases so a later run can start", async () => {
  const gate = new MaintenanceGate();
  await assert.rejects(gate.run("upgrade", async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(gate.busy, false);
  assert.equal(await gate.run("restore", async () => "next"), "next");
});

test("admitted mutations drain before maintenance; later mutations are rejected", async () => {
  const gate = new MaintenanceGate();
  const order: string[] = [];
  let releaseMutation: (() => void) | undefined;
  const mutation = gate.runMutation(
    () =>
      new Promise<string>((resolveMutation) => {
        order.push("mutation-start");
        releaseMutation = () => {
          order.push("mutation-end");
          resolveMutation("mut");
        };
      }),
  );
  assert.equal(gate.mutations, 1);
  const upgrade = gate.run("upgrade", async () => {
    order.push("upgrade");
    return "up";
  });
  assert.equal(gate.busy, true);
  assert.throws(() => gate.runMutation(async () => "late"), /while maintenance is running/);
  await delay(20);
  assert.equal(order.includes("upgrade"), false);
  releaseMutation?.();
  assert.equal(await mutation, "mut");
  assert.equal(await upgrade, "up");
  assert.deepEqual(order, ["mutation-start", "mutation-end", "upgrade"]);
  assert.equal(gate.mutations, 0);
});

test("idle waits until maintenance and mutations finish", async () => {
  const gate = new MaintenanceGate();
  let idleDone = false;
  const mutation = gate.runMutation(async () => {
    await delay(30);
    return 1;
  });
  const work = gate.run("quit-prep", async () => {
    await delay(20);
    return 2;
  });
  const idle = gate.idle().then(() => {
    idleDone = true;
  });
  await delay(5);
  assert.equal(idleDone, false);
  await Promise.all([mutation, work, idle]);
  assert.equal(idleDone, true);
  await gate.idle();
});

test("onChange sees busy, current, and mutation counts", async () => {
  const gate = new MaintenanceGate();
  const seen: string[] = [];
  const stop = gate.onChange((status) => {
    seen.push(`${status.busy ? status.current : "idle"}:${status.mutations}`);
  });
  await gate.runMutation(async () => 1);
  await gate.run("upgrade", async () => 1);
  stop();
  assert.ok(seen.includes("idle:1"));
  assert.ok(seen.includes("upgrade:0"));
  assert.equal(seen.at(-1), "idle:0");
});
