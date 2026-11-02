import assert from "node:assert/strict";
import { test } from "node:test";
import { StartFailureError } from "../../src/adapters/node/runtime/start-failure.ts";
import { SupervisorStartup } from "../../src/adapters/node/supervisor/startup.ts";

const EPOCH = "a".repeat(64);

function view(managerId: string | null = "spaces-hub") {
  return { serviceEpoch: EPOCH, managerId };
}

test("startup moves from preparing to starting and ready only after the start is recorded", () => {
  const startup = new SupervisorStartup();
  assert.deepEqual(startup.snapshot(view(null)), {
    serviceEpoch: EPOCH,
    managerId: null,
    phase: "preparing",
    reasons: [],
    failure: null,
  });
  startup.ready();
  assert.equal(startup.snapshot(view()).phase, "preparing");
  startup.starting();
  const starting = startup.snapshot(view());
  assert.equal(starting.phase, "starting");
  assert.equal(starting.failure, null);
  startup.ready();
  const ready = startup.snapshot(view());
  assert.equal(ready.phase, "ready");
  assert.equal(ready.failure, null);
  assert.deepEqual(ready.reasons, []);
});

test("a failed startup stays latched and keeps the original cause", () => {
  const startup = new SupervisorStartup();
  startup.fail(new Error("registry header is damaged token=primary-secret"), "prepare", {
    reasons: ["Writable startup did not finish. The stable entry is still available."],
  });
  const first = startup.snapshot(view());
  assert.equal(first.phase, "failed");
  assert.match(first.failure?.primaryReason ?? "", /registry header is damaged/);
  assert.equal(first.failure?.instanceRetained, false);
  assert.equal(/primary-secret/.test(JSON.stringify(first)), false);
  assert.ok(first.reasons.some((reason) => reason.includes("stable entry")));
  startup.starting();
  startup.ready();
  startup.fail(new Error("second failure"), "start", { instanceRetained: true });
  assert.deepEqual(startup.snapshot(view()), first);
});

test("a snapshot is a sanitized copy and a read does not change the record", () => {
  const startup = new SupervisorStartup();
  startup.starting();
  startup.fail(new Error("endpoint refused token=primary-secret C:/secret/path"), "start", { instanceRetained: true });
  const first = startup.snapshot(view());
  first.phase = "ready";
  first.reasons.push("token=primary-secret");
  first.failure!.primaryReason = "C:/secret/path";
  first.failure!.instanceRetained = false;
  const again = startup.snapshot(view());
  assert.equal(again.phase, "failed");
  assert.equal(again.failure?.instanceRetained, true);
  assert.equal(/primary-secret|C:\/secret/.test(JSON.stringify(again)), false);
  assert.notEqual(again.failure, first.failure);
  const hidden = startup.snapshot({ serviceEpoch: "not-an-epoch", managerId: "../spaces" });
  assert.equal(hidden.serviceEpoch, "");
  assert.equal(hidden.managerId, null);
  assert.equal(hidden.phase, "failed");
  assert.deepEqual(startup.snapshot(view()), again);
});

test("manager start keeps primary and cleanup without slicing them into 400 characters", () => {
  const primary = `token=primary-secret C:/secret/path PRIMARY_START_FAILURE ${"long-reason ".repeat(40)}`;
  const cleanup = `token=cleanup-secret C:/hidden/path SECOND_STOP_FAILURE ${"cleanup-reason ".repeat(30)}`;
  const error = new StartFailureError({
    stage: "endpoint",
    cause: new Error(primary),
    cleanup: new Error(cleanup),
    instanceRetained: true,
  });
  assert.equal(error.message.slice(0, 400).includes(error.cleanupReason), false);

  const startup = new SupervisorStartup();
  startup.starting();
  startup.fail(error, "start", { instanceRetained: false });
  const status = startup.snapshot(view());
  assert.equal(status.phase, "failed");
  assert.equal(status.failure?.stage, "endpoint");
  assert.equal(status.failure?.primaryReason, error.primaryReason);
  assert.equal(status.failure?.cleanupReason, error.cleanupReason);
  assert.equal(status.failure?.instanceRetained, true);
  assert.ok((status.failure?.primaryReason.length ?? 0) <= 220);
  assert.ok((status.failure?.cleanupReason?.length ?? 0) <= 220);
  assert.ok(status.reasons.some((reason) => reason.includes(error.cleanupReason)));
  assert.match(status.failure?.primaryReason ?? "", /PRIMARY_START_FAILURE/);
  assert.match(status.failure?.cleanupReason ?? "", /SECOND_STOP_FAILURE/);
  assert.equal(/primary-secret|cleanup-secret|C:\/secret|C:\/hidden/.test(JSON.stringify(status)), false);

  const live = new SupervisorStartup();
  live.starting();
  live.fail(new Error("instance record could not be written token=primary-secret"), "start", { instanceRetained: true });
  assert.equal(live.snapshot(view()).failure?.instanceRetained, true);

  const replaced = new SupervisorStartup();
  replaced.starting();
  replaced.fail(new StartFailureError({
    stage: "api",
    cause: new Error("PRIMARY_START_FAILURE"),
    cleanup: new Error("SECOND_STOP_FAILURE"),
    instanceRetained: false,
  }), "start", { instanceRetained: true });
  const replacedStatus = replaced.snapshot(view());
  assert.equal(replacedStatus.failure?.instanceRetained, false);
  assert.match(replacedStatus.failure?.cleanupReason ?? "", /SECOND_STOP_FAILURE/);
});

test("a diagnostic note stays beside the latched cause and is not process cleanup", () => {
  const startup = new SupervisorStartup();
  startup.note(new Error("EPERM before the cause exists"));
  assert.equal(startup.snapshot(view()).phase, "preparing");
  startup.fail(new Error("CONTROLLED_BOOTSTRAP_FAILURE token=fixture-secret C:/private/file"), "bootstrap", {
    reasons: ["Manager initialization did not complete. Its local diagnostic record is available."],
  });
  startup.note(new Error("EPERM: operation not permitted, rename C:/private/diagnostic"));
  startup.fail(new Error("diagnostic write replaced the cause"), "prepare");
  const status = startup.snapshot(view());
  assert.equal(status.phase, "failed");
  assert.match(status.failure?.primaryReason ?? "", /CONTROLLED_BOOTSTRAP_FAILURE/);
  assert.equal(status.failure?.cleanupReason, undefined);
  assert.equal(status.failure?.instanceRetained, false);
  assert.ok(status.reasons.some((reason) => /EPERM|not permitted/i.test(reason)));
  assert.equal(status.reasons.some((reason) => reason.startsWith("Cleanup:")), false);
  assert.equal(/fixture-secret|C:\/private/.test(JSON.stringify(status)), false);
  assert.deepEqual(startup.snapshot(view()), status);
});
