import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MaintenanceGate } from "../src/core/application/maintenance-gate.ts";
import { RestoreSession } from "../src/core/application/restore-session.ts";
import {
  PatchForbiddenError,
  PatchVerifyError,
  applyIsolationPatch,
  assertDumpConfigIsolated,
  assertDumpPatched,
  configPathExpr,
  extractConfigField,
  extractRoot,
  isExpectedIsolationPath,
  isExpectedIsolationRoot,
  isolationExpr,
  patchTextLooksConfigIsolated,
  patchTextLooksIsolated,
} from "../src/core/domain/isolation.ts";
import {
  applyMetaPatch,
  applyWorkbenchReorder,
  assertValidProfileName,
  classifyProfile,
  compareScannedProfiles,
  completeWorkbenchOrder,
  defaultSpaceMeta,
  emptySpacesFile,
  normalizeSpacesFile,
  onboardingAction,
  packageHasWebApp,
} from "../src/core/domain/registry.ts";
import type { OperationLock } from "../src/core/ports/operation-lock.ts";
import type { DescribeRuntimePort, RestoreSessionSnapshots } from "../src/core/ports/restore.ts";
import type { SnapshotRuntime } from "../src/shared/snapshots.ts";
import { t } from "../src/shared/i18n/index.ts";

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core");

function coreSource(relative: string): string {
  return readFileSync(join(coreRoot, relative), "utf8");
}

test("core stays free of Node fs/process, Electron, React, and Cordis", () => {
  const files = [
    "domain/isolation.ts",
    "domain/registry.ts",
    "domain/llm-connections.ts",
    "domain/llm-resolution.ts",
    "application/maintenance-gate.ts",
    "application/restore-session.ts",
    "ports/operation-lock.ts",
    "ports/restore.ts",
    "ports/llm-store.ts",
  ];
  const forbidden = /from ["'](?:node:fs|node:process|electron|react|react\/jsx-runtime|cordis)/;
  for (const file of files) {
    assert.equal(forbidden.test(coreSource(file)), false, file);
  }
});

test("isolation expressions and dump verification stay host-independent", () => {
  assert.equal(isolationExpr("coding", "sessions"), "dshHomePath('hub/coding/sessions')");
  assert.equal(configPathExpr("coding", "settings.yaml"), "dshHomePath('hub/coding/settings.yaml')");
  assert.equal(
    isExpectedIsolationRoot("!!js dshHomePath('hub/coding/sessions')", "coding", "sessions"),
    true,
  );
  assert.equal(isExpectedIsolationRoot("dshHomePath('hub/coding/sessions')", "coding", "sessions"), false);
  assert.equal(
    isExpectedIsolationPath("!!js dshHomePath('hub/coding/settings.yaml')", "coding", "settings.yaml"),
    true,
  );
  assert.equal(patchTextLooksIsolated("hub/coding/sessions\nhub/coding/storages", "coding"), true);
  assert.equal(
    patchTextLooksConfigIsolated(
      "hub/coding/sessions\nhub/coding/storages\nhub/coding/settings.yaml\nhub/coding/.credentials.yaml",
      "coding",
    ),
    true,
  );

  const dump = `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;
  assert.equal(extractRoot(dump, "session-persistence-jsonl"), "!!js dshHomePath('hub/coding/sessions')");
  assert.doesNotThrow(() => assertDumpPatched(dump, "coding"));
  assert.throws(() => applyIsolationPatch("[]\n", "web", "patch"), PatchForbiddenError);
  const patched = applyIsolationPatch("- id: keep-me\n  config:\n    foo: 1\n", "coding", "patch");
  assert.match(patched, /hub\/coding\/sessions/);
  assert.match(patched, /hub\/coding\/storages/);
  assert.match(patched, /hub\/coding\/settings\.yaml/);
  assert.match(patched, /hub\/coding\/\.credentials\.yaml/);
  assert.equal(extractConfigField(patched, "settings", "path"), "!!js dshHomePath('hub/coding/settings.yaml')");
  assert.doesNotThrow(() => assertDumpConfigIsolated(patched, "coding"));
  assert.throws(
    () =>
      applyIsolationPatch(
        `- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
`,
        "coding",
        "patch",
      ),
    PatchVerifyError,
  );
});

test("registry domain validates names and orders workbench records", () => {
  assert.throws(() => assertValidProfileName("Web"), { message: t("errors.nameInvalid") });
  assert.throws(() => assertValidProfileName("web"), { message: t("errors.nameReserved", { name: "web" }) });
  assertValidProfileName("notes");
  assert.equal(classifyProfile("web", true), "root");
  assert.equal(classifyProfile("coding", true), "workbench");
  assert.equal(classifyProfile("headless", false), "hidden");
  assert.equal(onboardingAction("workbench", false), "convert-workbench");
  assert.equal(onboardingAction("workbench", true), "already-workbench");
  assert.equal(packageHasWebApp({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app"] } } }), true);
  assert.deepEqual(defaultSpaceMeta("web"), { displayName: "Home", order: -1 });

  const spaces = emptySpacesFile();
  applyMetaPatch(spaces, "coding", { displayName: "Code" });
  applyMetaPatch(spaces, "writing", { displayName: "Write" });
  applyWorkbenchReorder(spaces, completeWorkbenchOrder(["coding", "writing"], ["writing"]));
  assert.deepEqual(spaces.order, ["writing", "coding"]);

  const records = [
    { kind: "workbench" as const, name: "coding", meta: { displayName: "Code", order: 1 } },
    { kind: "root" as const, name: "web", meta: defaultSpaceMeta("web") },
    { kind: "workbench" as const, name: "writing", meta: { displayName: "Write", order: 0 } },
  ];
  records.sort((a, b) => compareScannedProfiles(a, b, spaces.order));
  assert.deepEqual(records.map((row) => row.name), ["web", "writing", "coding"]);
  assert.throws(() => normalizeSpacesFile({ version: 2, order: [], meta: {} } as never), {
    message: t("errors.unsupportedSpacesVersion", { version: "2" }),
  });
});

test("MaintenanceGate no-arg still acquires synchronously and drains mutations", async () => {
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
  const upgrade = gate.run("upgrade", async () => {
    order.push("upgrade");
    return "up";
  });
  assert.equal(gate.busy, true);
  assert.throws(() => gate.run("restore", async () => "no"), /already running \(upgrade\)/);
  assert.throws(() => gate.runMutation(async () => "late"), /while maintenance is running/);
  releaseMutation?.();
  assert.equal(await mutation, "mut");
  assert.equal(await upgrade, "up");
  assert.deepEqual(order, ["mutation-start", "mutation-end", "upgrade"]);
});

test("without a lock, admitted mutations for different spaces overlap", async () => {
  const gate = new MaintenanceGate();
  let releaseA: (() => void) | undefined;
  let releaseB: (() => void) | undefined;
  const a = gate.runMutation(
    () =>
      new Promise<string>((resolve) => {
        releaseA = () => resolve("a");
      }),
  );
  const b = gate.runMutation(
    () =>
      new Promise<string>((resolve) => {
        releaseB = () => resolve("b");
      }),
  );
  assert.equal(gate.mutations, 2);
  releaseB?.();
  releaseA?.();
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
});

test("optional OperationLock serializes admitted maintenance and mutations", async () => {
  const seen: string[] = [];
  let active = 0;
  let maxActive = 0;
  let chain = Promise.resolve();
  const lock: OperationLock = {
    run<T>(label: string, action: () => Promise<T>): Promise<T> {
      const next = chain.then(async () => {
        seen.push(`enter:${label}`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await action();
        } finally {
          active -= 1;
          seen.push(`leave:${label}`);
        }
      });
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
  const gate = new MaintenanceGate(lock);
  const first = gate.runMutation(async () => {
    await delay(20);
    return 1;
  });
  const second = gate.runMutation(async () => 2);
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.equal(await gate.run("upgrade", async () => "up"), "up");
  assert.equal(maxActive, 1);
  assert.ok(seen.includes("enter:mutation"));
  assert.ok(seen.includes("enter:upgrade"));
});

test("RestoreSession uses an injected runtime descriptor port", async () => {
  const described: string[] = [];
  const describeRuntime: DescribeRuntimePort = {
    describe(ref): SnapshotRuntime {
      if (!ref) throw new Error("missing");
      described.push(`${ref.version}:${ref.bin}`);
      return { root: "/runtime", version: ref.version, binRelative: "bin.js" };
    },
  };
  let pending: { snapshotId: string; runtimeVersion: string } | undefined;
  const restored: string[] = [];
  const snapshots: RestoreSessionSnapshots = {
    recover() {},
    restore(id, runtime) {
      restored.push(`${id}:${runtime?.version ?? "none"}`);
      pending = { snapshotId: id, runtimeVersion: runtime?.version ?? "1.0.0" };
    },
    pendingRestore() {
      return pending;
    },
    completeRestore() {
      pending = undefined;
    },
    runtimeBin() {
      return "/runtime/bin.js";
    },
  };
  let selected: string | undefined;
  const restore = new RestoreSession({
    snapshots,
    runtimes: {
      current: () => ({ bin: "/runtime/bin.js", version: "1.0.0" }),
      recordedRef: () => ({ bin: "/runtime/bin.js", version: "1.0.0" }),
      async selectExisting(ref) {
        selected = ref.bin;
      },
    },
    applyRestoredSettings() {},
    describeRuntime,
  });
  await restore.restoreSnapshot("snap-1");
  assert.deepEqual(restored, ["snap-1:1.0.0"]);
  assert.equal(selected, "/runtime/bin.js");
  assert.ok(described.length > 0);
  assert.doesNotThrow(() => restore.assertAvailable(false));
});
