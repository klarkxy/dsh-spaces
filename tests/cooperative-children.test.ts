import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CooperativeChildren } from "../src/adapters/node/cooperative-children.ts";
import { observeMaintenanceChild, ownsObservedChild, withChildObservation } from "../src/adapters/node/owned-process-record.ts";
import {
  CONTROL_INSTANCES_DIR_NAME,
  CONTROL_JOBS_DIR_NAME,
  HOME_MUTATION_JOURNAL,
  inspectControlResidue,
} from "../src/adapters/node/control-residue.ts";
import { HOME_CONTROL_DIR_NAME } from "../src/adapters/node/home-controller.ts";
import { runProcess } from "../src/adapters/node/toolchain.ts";

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

test("truncated and unfinished jobs are residue and their original bytes stay", () => {
  const home = mkdtempSync(join(tmpdir(), "spaces-residue-jobs-"));
  try {
    const jobs = join(home, HOME_CONTROL_DIR_NAME, CONTROL_JOBS_DIR_NAME);
    mkdirSync(jobs, { recursive: true });
    const truncated = join(jobs, "cut.json");
    const queued = join(jobs, "left.json");
    const truncatedBytes = "{\"schemaVersion\":1,\"status\":\"queued\"";
    const queuedBytes = `${JSON.stringify({ schemaVersion: 1, status: "queued" })}\n`;
    writeFileSync(truncated, truncatedBytes);
    writeFileSync(queued, queuedBytes);
    const reasons = inspectControlResidue(home);
    assert.ok(reasons.some((row) => /truncated|unreadable/i.test(row)));
    assert.ok(reasons.some((row) => /interrupted workbench jobs/i.test(row)));
    assert.equal(readFileSync(truncated, "utf8"), truncatedBytes);
    assert.equal(readFileSync(queued, "utf8"), queuedBytes);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("stale dead instance records do not count as residue; live leftovers still do", () => {
  const home = mkdtempSync(join(tmpdir(), "spaces-residue-dead-"));
  try {
    const instances = join(home, HOME_CONTROL_DIR_NAME, CONTROL_INSTANCES_DIR_NAME);
    mkdirSync(instances, { recursive: true });
    const record = JSON.stringify({
      version: 1,
      spaceId: "notes",
      pid: 9,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const file = join(instances, "notes.json");
    writeFileSync(file, record);
    assert.deepEqual(inspectControlResidue(home, undefined, () => "dead"), []);
    assert.equal(readFileSync(file, "utf8"), record);
    const live = inspectControlResidue(home, undefined, () => "alive");
    assert.ok(live.some((row) => /leftover instance/i.test(row)));
    assert.equal(readFileSync(file, "utf8"), record);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("mutation journal is reported as residue and is not rewritten", () => {
  const home = mkdtempSync(join(tmpdir(), "spaces-residue-journal-"));
  try {
    const journal = join(home, HOME_MUTATION_JOURNAL);
    const original = '{"op":"create","spaceId":"unfinished"}';
    writeFileSync(journal, original);
    const reasons = inspectControlResidue(home);
    assert.ok(reasons.some((row) => /unfinished evidence/i.test(row)));
    assert.equal(readFileSync(journal, "utf8"), original);
    assert.equal(existsSync(journal), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
