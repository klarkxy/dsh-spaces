import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CooperativeChildren } from "../src/adapters/node/cooperative-children.ts";
import { observeMaintenanceChild, ownsObservedChild, withChildObservation } from "../src/main/owned-process-record.ts";
import { inspectControlResidue } from "../src/adapters/desktop/control-residue.ts";
import { runProcess } from "../src/main/toolchain.ts";

test("package-manager child identity is journaled in its async Home scope and removed on exit", async () => {
  const home = mkdtempSync(join(tmpdir(), "spaces-observed-cli-"));
  const directory = join(home, ".dsh-spaces-control", "instances");
  let observed = false;
  try {
    const result = await withChildObservation(() => observeMaintenanceChild(home, () => assert.fail("journal failure")),
      () => runProcess(process.execPath, ["-e", "console.log('ready'); setTimeout(()=>{},100)"], {
        timeoutMs: 5000,
        onLine: line => {
          if (line !== "ready") return;
          const records = readdirSync(directory).map(name => JSON.parse(readFileSync(join(directory, name), "utf8")));
          assert.equal(records.length, 1);
          assert.equal(records[0].kind, "maintenance");
          assert.ok(records[0].pid > 0);
          observed = true;
        },
      }));
    assert.equal(result.code, 0);
    assert.equal(observed, true);
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("private stop request runs the child's asynchronous shutdown before exit", async () => {
  const children = new CooperativeChildren();
  const child = children.spawn(["-e", `
    process.on('SIGTERM', async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      process.stdout.write('disposed');
      process.exit(0);
    });
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `], { windowsHide: true });
  let output = "";
  child.stdout!.on("data", data => { output += data.toString(); });
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    while (!output.includes("ready")) await once(child.stdout!, "data");
    const exited = once(child, "exit");
    await children.stop(child.pid!);
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(output, "readydisposed");
    await assert.rejects(children.stop(child.pid!), /no cooperative stop channel/);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
});

test("stop requested during boot waits for DSH to register its shutdown handler", async () => {
  const children = new CooperativeChildren();
  const child = children.spawn(["-e", `
    process.stdout.write('booting');
    setTimeout(() => process.on('SIGTERM', () => {
      process.stdout.write('disposed'); process.exit(0);
    }), 250);
    setInterval(() => {}, 1000);
  `], { windowsHide: true });
  let output = "";
  child.stdout!.on("data", data => { output += data.toString(); });
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    while (!output.includes("booting")) await once(child.stdout!, "data");
    const exited = once(child, "exit");
    await children.stop(child.pid!);
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(output, "bootingdisposed");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
});

test("desktop-owned child identity is persisted until its confirmed exit", async () => {
  const home = mkdtempSync(join(tmpdir(), "spaces-child-ledger-"));
  const children = new CooperativeChildren({ journalHome: home });
  const child = children.spawn(["-e", "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready');setInterval(()=>{},1000);", "--", "--profile", "coding", "--port", "34222"], { windowsHide: true });
  const file = join(home, ".dsh-spaces-control", "instances", "coding.json");
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(record.pid, child.pid);
    assert.equal(record.spaceId, "coding");
    assert.equal(record.origin, "http://127.0.0.1:34222");
    assert.equal(children.ownsRecord(record), true);
    assert.equal(children.ownsRecord({ ...record, generation: record.generation + 1 }), false);
    assert.ok(inspectControlResidue(home).length);
    assert.deepEqual(inspectControlResidue(home, row => children.ownsRecord(row)), []);
    await once(child.stdout!, "data");
    const exited = once(child, "exit");
    await children.stop(child.pid!);
    await exited;
    assert.equal(existsSync(file), false);
    assert.equal(children.ownsRecord(record), false);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    rmSync(home, { recursive: true, force: true });
  }
});

test("maintenance spawn intent is durable before attach and removed only after exit", async () => {
  const home = mkdtempSync(join(tmpdir(), "spaces-maintenance-child-"));
  const observation = observeMaintenanceChild(home, () => assert.fail("journal IO failed"));
  const directory = join(home, ".dsh-spaces-control", "instances");
  const file = join(directory, readdirSync(directory)[0]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).phase, "spawning");
  const children = new CooperativeChildren();
  const child = children.spawn(["-e", "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready');setInterval(()=>{},1000);"], { windowsHide: true });
  observation.attach(child);
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(record.kind, "maintenance");
    assert.equal(record.pid, child.pid);
    assert.equal(ownsObservedChild(home, record), true);
    assert.equal(ownsObservedChild(home, { ...record, pid: record.pid + 1 }), false);
    await once(child.stdout!, "data");
    const exited = once(child, "exit");
    await children.stop(child.pid!);
    await exited;
    assert.equal(existsSync(file), false);
    const notSpawned = observeMaintenanceChild(home, () => assert.fail("journal IO failed"));
    notSpawned.cancel();
    assert.equal(readdirSync(directory).length, 0);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    rmSync(home, { recursive: true, force: true });
  }
});
