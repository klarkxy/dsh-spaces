import assert from "node:assert/strict";
import { test } from "node:test";
import { createStartupProgress } from "../src/main/desktop-startup-progress.ts";

function harness(options: { now?: () => number } = {}) {
  const stages: Array<string | null> = [];
  const logs: string[] = [];
  let clock = 0;
  const progress = createStartupProgress({
    now: options.now ?? (() => (clock += 1000)),
    onAdvance: (stage) => stages.push(stage),
    onLog: (line) => logs.push(line),
  });
  return { progress, stages, logs, tick: (ms: number) => { clock += ms; } };
}

test("stages only advance within one flow and duplicates do not re-emit", () => {
  const { progress, stages } = harness();
  progress.beginConnect();
  assert.equal(progress.current(), null);
  progress.stage("attach");
  progress.stage("attach");
  progress.stage("prepare");
  progress.stage("connect");
  progress.stage("launch");
  progress.stage("attach");
  assert.deepEqual(stages, ["attach", "prepare", "connect"]);
  assert.equal(progress.current(), "connect");
});

test("a late stage cannot move backwards after ready", () => {
  const { progress, stages } = harness();
  progress.beginConnect();
  progress.stage("ready");
  progress.stage("connect");
  progress.stage("attach");
  assert.deepEqual(stages, ["ready"]);
  assert.equal(progress.current(), "ready");
});

test("a new open flow resets the stage and starts a fresh clock", () => {
  const { progress, stages, logs } = harness();
  progress.beginConnect();
  progress.stage("ready");
  progress.succeed();
  assert.equal(logs.length, 1);
  progress.beginConnect();
  assert.equal(progress.current(), null);
  progress.stage("attach");
  assert.deepEqual(stages, ["ready", "attach"]);
  progress.succeed();
  assert.equal(logs.length, 2, "the second flow logs its own completion");
  assert.deepEqual(stages, ["ready", "attach", "ready"]);
});

test("a start flow keeps the open clock across the continuation but clears the stage", () => {
  const { progress, stages, logs } = harness();
  progress.beginConnect();
  progress.stage("attach");
  progress.beginStart();
  assert.equal(progress.current(), null);
  progress.stage("prepare");
  progress.succeed();
  assert.match(logs[0] ?? "", /Startup completed in \d+ ms/);
  assert.deepEqual(stages, ["attach", "prepare", "ready"]);
});

test("prepare or launch mark the run as a cold start in the completion log", () => {
  const { progress, logs } = harness();
  progress.beginConnect();
  progress.stage("attach");
  progress.stage("prepare");
  progress.succeed();
  assert.match(logs[0] ?? "", /^Startup completed in \d+ ms \(cold start\)\.$/);

  const attached = harness();
  attached.progress.beginConnect();
  attached.progress.stage("attach");
  attached.progress.stage("connect");
  attached.progress.succeed();
  assert.match(attached.logs[0] ?? "", /^Startup completed in \d+ ms \(attached to existing service\)\.$/);
});

test("elapsed time runs from the first connect of the flow until ready", () => {
  let clock = 5_000;
  const { progress, logs } = harness({ now: () => clock });
  progress.beginConnect();
  clock = 7_000;
  progress.beginStart();
  clock = 10_434;
  progress.succeed();
  assert.deepEqual(logs, ["Startup completed in 5434 ms (attached to existing service)."]);
});

test("a failed flow logs nothing and a later ready without a clock logs nothing", () => {
  const { progress, stages, logs } = harness();
  progress.beginConnect();
  progress.stage("launch");
  progress.fail();
  progress.succeed();
  assert.deepEqual(logs, []);
  assert.deepEqual(stages, ["launch", "ready"], "ready still shows without a clock");
});

test("reset clears the clock for a stopped service so no completion is logged", () => {
  const { progress, stages, logs } = harness();
  progress.beginConnect();
  progress.stage("connect");
  progress.reset();
  assert.equal(progress.current(), null);
  progress.succeed();
  assert.deepEqual(stages, ["connect", "ready"]);
  assert.deepEqual(logs, []);
});
