import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { SnapshotStore } from "../src/main/snapshot-store.ts";
import {
  RESTORE_STAGE_DIR,
  SNAPSHOT_ID_RE,
  type RestoreJournal,
  type SnapshotRuntime,
} from "../src/shared/snapshots.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmTree(dir);
});

test("round-trip restore keeps a before-restore snapshot and drops later managed items", () => {
  const { home, root, store, runtime } = harness();
  seedHome(home, {
    profiles: ["web", "coding"],
    settings: "old-settings\n",
    session: "old-session\n",
  });
  writeFileSync(join(home, ".credentials.yaml"), "secret-key\n");
  writeFileSync(join(home, ".anonymous-user-id"), "machine-1\n");
  writeFileSync(join(home, "notes.txt"), "keep-me\n");

  const original = store.create(runtime, "upgrade");
  assert.equal(original.reason, "upgrade");
  assert.deepEqual(original.profiles, ["coding", "web"]);
  assert.equal(original.presence.profiles, true);
  assert.equal(original.presence["settings.yaml"], true);
  assert.equal(original.presence.sessions, true);
  assert.equal(original.presence.hub, false);
  assert.equal(store.list().length, 1);
  assert.equal(readFileSync(store.runtimeBin(original.id), "utf8"), "cli\n");
  assert.equal(existsSync(join(root, original.id, "data", ".credentials.yaml")), false);
  assert.equal(existsSync(join(root, original.id, "data", ".anonymous-user-id")), false);

  mkdirSync(join(home, "profiles", "notes"), { recursive: true });
  writeFileSync(join(home, "profiles", "notes", "cordis.patch.yml"), "new-profile\n");
  writeFileSync(join(home, "settings.yaml"), "new-settings\n");
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(join(home, "hub", "spaces.json"), '{"version":1}\n');
  writeFileSync(join(home, "sessions", "chat.jsonl"), "new-session\n");

  const { restored, beforeRestore } = store.restore(original.id, runtime);
  assert.equal(restored.id, original.id);
  assert.equal(beforeRestore.reason, "before-restore");
  assert.ok(beforeRestore.profiles.includes("notes"));
  assert.equal(beforeRestore.presence.hub, true);
  assert.equal(existsSync(join(home, "profiles", "notes")), false);
  assert.equal(existsSync(join(home, "hub")), false);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "old-settings\n");
  assert.equal(readFileSync(join(home, "sessions", "chat.jsonl"), "utf8"), "old-session\n");
  assert.equal(readFileSync(join(home, "profiles", "coding", "cordis.patch.yml"), "utf8"), "coding\n");
  assert.equal(readFileSync(join(home, ".credentials.yaml"), "utf8"), "secret-key\n");
  assert.equal(readFileSync(join(home, ".anonymous-user-id"), "utf8"), "machine-1\n");
  assert.equal(readFileSync(join(home, "notes.txt"), "utf8"), "keep-me\n");

  const pending = store.pendingRestore();
  assert.ok(pending);
  assert.equal(pending?.snapshotId, original.id);
  assert.equal(pending?.beforeRestoreId, beforeRestore.id);
  assert.throws(() => store.create(runtime), /pending/);
  assert.throws(() => store.delete(original.id), /pending/);
  assert.throws(() => store.restore(original.id, runtime), /pending/);

  store.completeRestore();
  assert.equal(store.pendingRestore(), undefined);
  assert.equal(existsSync(join(home, RESTORE_STAGE_DIR)), false);
  assert.equal(store.list().length, 2);
});

test("home mismatch and path-escaping ids are rejected", () => {
  const { home, store, runtime, root } = harness();
  seedHome(home, { profiles: ["web"], settings: "a\n" });
  const snap = store.create(runtime);
  const otherHome = fakeDir("dsh-home-");
  mkdirSync(join(otherHome, "profiles", "web"), { recursive: true });
  const other = new SnapshotStore({ home: otherHome, root });
  assert.throws(() => other.restore(snap.id, runtime), /different DSH home/);
  assert.throws(() => store.preview(`../${snap.id}`), /not a snapshot directory/);
  assert.throws(() => store.preview(`${snap.id}/../${snap.id}`), /not a snapshot directory/);
  assert.throws(() => store.delete(join(root, snap.id)), /not a snapshot directory/);
  assert.throws(() => store.preview(`/tmp/${snap.id}`), /not a snapshot directory/);
  assert.equal(store.list().length, 1);
});

test("nested snapshot root, in-use delete, and create failure leave home unchanged", () => {
  const home = fakeDir("dsh-home-");
  seedHome(home, { profiles: ["web"], settings: "keep\n" });
  assert.throws(() => new SnapshotStore({ home, root: join(home, "snapshots") }), /nested paths/);

  const nestedRuntime = fakeDir("dsh-rt-");
  writeFileSync(join(nestedRuntime, "bin.js"), "cli\n");
  const insideRuntime = join(nestedRuntime, "snaps");
  mkdirSync(insideRuntime);
  assert.throws(
    () =>
      new SnapshotStore({ home, root: insideRuntime }).create({
        version: "1",
        root: nestedRuntime,
        binRelative: "bin.js",
      }),
    /nested paths/,
  );

  const root = fakeDir("dsh-snaps-");
  const runtimeDir = fakeDir("dsh-rt-");
  writeFileSync(join(runtimeDir, "bin.js"), "cli\n");
  const runtime: SnapshotRuntime = { version: "1.0.0", root: runtimeDir, binRelative: "bin.js" };
  let usedId = "";
  const used = new SnapshotStore({ home, root, inUse: (id) => id === usedId });
  const snap = used.create(runtime);
  usedId = snap.id;
  assert.throws(() => used.delete(snap.id), /in use/);
  assert.equal(used.list().length, 1);

  const failRoot = fakeDir("dsh-snaps-");
  const failing = new SnapshotStore({
    home,
    root: failRoot,
    inject: (op) => {
      if (op === "create:publish") throw new Error("disk full");
    },
  });
  assert.throws(() => failing.create(runtime), /disk full/);
  assert.equal(failing.list().length, 0);
  assert.equal(
    readdirSync(failRoot).every((name) => !name.startsWith(".tmp-")),
    true,
  );
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "keep\n");
});

test("internal links are rewritten and external links are refused", () => {
  const { home, root, store } = harness();
  seedHome(home, { profiles: ["coding"] });
  const runtimeDir = fakeDir("dsh-rt-");
  writeFileSync(join(runtimeDir, "bin.js"), "cli\n");
  mkdirSync(join(runtimeDir, ".pnpm", "pkg@1", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(runtimeDir, ".pnpm", "pkg@1", "node_modules", "pkg", "index.js"), "pkg\n");
  mkdirSync(join(runtimeDir, "node_modules"));
  linkDir(join(runtimeDir, ".pnpm", "pkg@1", "node_modules", "pkg"), join(runtimeDir, "node_modules", "pkg"));

  mkdirSync(join(home, "profiles", "coding", "node_modules", ".pnpm"), { recursive: true });
  writeFileSync(join(home, "profiles", "coding", "node_modules", ".pnpm", "store.txt"), "dep\n");
  linkDir(
    join(home, "profiles", "coding", "node_modules", ".pnpm"),
    join(home, "profiles", "coding", "node_modules", "linked"),
  );

  const runtime: SnapshotRuntime = { version: "0.1.0", root: runtimeDir, binRelative: "bin.js" };
  const snap = store.create(runtime);
  const snapRuntime = join(root, snap.id, "runtime");
  const snapTarget = resolveLink(join(snapRuntime, "node_modules", "pkg"));
  assert.ok(isInsidePath(snapRuntime, snapTarget), snapTarget);
  assert.equal(isInsidePath(runtimeDir, snapTarget) && !isInsidePath(snapRuntime, snapTarget), false);
  assert.equal(readFileSync(join(snapTarget, "index.js"), "utf8"), "pkg\n");

  const profileTarget = resolveLink(join(root, snap.id, "data", "profiles", "coding", "node_modules", "linked"));
  assert.ok(isInsidePath(join(root, snap.id, "data", "profiles"), profileTarget));

  const outside = fakeDir("dsh-out-");
  writeFileSync(join(outside, "x.txt"), "nope\n");
  const badRuntime = fakeDir("dsh-rt-");
  writeFileSync(join(badRuntime, "bin.js"), "cli\n");
  mkdirSync(join(badRuntime, "node_modules"));
  linkDir(outside, join(badRuntime, "node_modules", "escape"));
  const before = store.list().length;
  assert.throws(
    () => store.create({ version: "0.1.0", root: badRuntime, binRelative: "bin.js" }),
    /External link/,
  );
  assert.equal(store.list().length, before);
  assert.equal(
    readdirSync(root).some((name) => name.startsWith(".tmp-")),
    false,
  );
});

test("recover rolls back an unfinished swap and keeps pending after a finished one", () => {
  const { home, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "old\n", session: "old-session" });
  const root = fakeDir("dsh-snaps-");
  const crashing = new SnapshotStore({
    home,
    root,
    inject: (op, detail) => {
      if (op === "restore:swap" && detail === "sessions") throw new Error("power loss");
    },
  });
  const snap = crashing.create(runtime);
  writeFileSync(join(home, "settings.yaml"), "new\n");
  writeFileSync(join(home, "sessions", "chat.jsonl"), "new-session\n");
  assert.throws(() => crashing.restore(snap.id, runtime), /power loss/);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "new\n");
  assert.equal(readFileSync(join(home, "sessions", "chat.jsonl"), "utf8"), "new-session\n");
  assert.equal(existsSync(join(home, RESTORE_STAGE_DIR)), false);
  assert.equal(crashing.pendingRestore(), undefined);

  seedHome(home, { profiles: ["web"], settings: "live\n", session: "live-session" });
  const crashed = new SnapshotStore({ home, root });
  const target = crashed.create(runtime);
  const stage = join(home, RESTORE_STAGE_DIR);
  mkdirSync(join(stage, "backup"), { recursive: true });
  mkdirSync(join(stage, "incoming"), { recursive: true });
  renameSync(join(home, "settings.yaml"), join(stage, "backup", "settings.yaml"));
  writeFileSync(join(home, "settings.yaml"), "from-snap\n");
  const journal: RestoreJournal = {
    phase: "swapping",
    snapshotId: target.id,
    beforeRestoreId: target.id,
    originalPresence: {
      profiles: true,
      sessions: true,
      storages: false,
      hub: false,
      "settings.yaml": true,
      "cordis.patch.yml": false,
    },
    runtimeVersion: "1.0.0",
    binRelative: "bin.js",
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(stage, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "from-snap\n");
  assert.equal(crashed.recover(), undefined);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "live\n");
  assert.equal(existsSync(join(home, RESTORE_STAGE_DIR)), false);

  const finished = new SnapshotStore({ home, root });
  const restored = finished.create(runtime, "keep");
  mkdirSync(join(home, RESTORE_STAGE_DIR), { recursive: true });
  writeFileSync(
    join(home, RESTORE_STAGE_DIR, "journal.json"),
    `${JSON.stringify({ ...journal, snapshotId: restored.id, beforeRestoreId: restored.id, phase: "swapped" }, null, 2)}\n`,
  );
  const pending = finished.recover();
  assert.ok(pending);
  assert.equal(pending?.snapshotId, restored.id);
  assert.equal(finished.pendingRestore()?.snapshotId, restored.id);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "live\n");
  finished.completeRestore();
});

test("restore does not use the network and refuses a missing runtime binary", () => {
  const { home, store, runtime } = harness();
  seedHome(home, { profiles: ["web"] });
  const snap = store.create(runtime);
  assert.ok(existsSync(store.runtimeBin(snap.id)));
  const { restored } = store.restore(snap.id, runtime);
  assert.equal(restored.id, snap.id);
  store.completeRestore();
  assert.throws(() => store.create({ ...runtime, binRelative: "missing.js" }), /does not exist/);
  assert.throws(() => store.create({ ...runtime, binRelative: "../bin.js" }), /escapes/);
});

test("create and restore accept the published snapshot runtime without copying the store", () => {
  const { home, root, store, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "v1\n" });
  const first = store.create(runtime, "install");
  writeFileSync(join(home, "settings.yaml"), "v2\n");
  const { restored, beforeRestore } = store.restore(first.id, runtime);
  store.completeRestore();

  const selected: SnapshotRuntime = {
    version: restored.runtimeVersion,
    root: store.runtimeRoot(restored.id),
    binRelative: restored.binRelative,
  };
  assert.equal(readFileSync(store.runtimeBin(restored.id), "utf8"), "cli\n");

  const fromSnap = store.create(selected, "upgrade");
  assert.equal(existsSync(join(root, fromSnap.id, "runtime", first.id)), false);
  assert.equal(existsSync(join(root, fromSnap.id, "runtime", "data")), false);
  assert.equal(existsSync(join(root, fromSnap.id, "data", first.id)), false);
  assert.equal(readFileSync(store.runtimeBin(fromSnap.id), "utf8"), "cli\n");
  const published = readdirSync(root).filter((name) => SNAPSHOT_ID_RE.test(name));
  assert.equal(published.length, 3);
  for (const id of published) {
    assert.equal(existsSync(join(root, id, first.id)), false);
  }

  writeFileSync(join(home, "settings.yaml"), "v3\n");
  const second = store.restore(first.id, selected);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "v1\n");
  assert.equal(second.restored.id, first.id);
  assert.notEqual(second.beforeRestore.id, beforeRestore.id);
  store.completeRestore();

  assert.throws(
    () => store.create({ version: "1", root, binRelative: "bin.js" }),
    /nested paths/,
  );
  assert.throws(
    () => store.create({ version: "1", root: join(root, first.id), binRelative: "runtime/bin.js" }),
    /nested paths/,
  );
});

test("retarget failure does not publish a snapshot; post-rename inject keeps a valid one", () => {
  const { home, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "keep\n" });
  const failRoot = fakeDir("dsh-snaps-");
  const retargetFail = new SnapshotStore({
    home,
    root: failRoot,
    inject: (op) => {
      if (op === "create:retarget") throw new Error("retarget failed");
    },
  });
  assert.throws(() => retargetFail.create(runtime), /retarget failed/);
  assert.equal(retargetFail.list().length, 0);
  assert.equal(
    readdirSync(failRoot).every((name) => !SNAPSHOT_ID_RE.test(name) && !name.startsWith(".tmp-")),
    true,
  );

  const publishRoot = fakeDir("dsh-snaps-");
  const afterRename = new SnapshotStore({
    home,
    root: publishRoot,
    inject: (op) => {
      if (op === "create:published") throw new Error("crash after rename");
    },
  });
  assert.throws(() => afterRename.create(runtime), /crash after rename/);
  assert.equal(afterRename.list().length, 1);
  assert.ok(existsSync(afterRename.runtimeBin(afterRename.list()[0].id)));
});

test("windows-style internal junctions restore and survive consecutive restore", () => {
  const { home, store, runtime } = harness();
  seedHome(home, { profiles: ["coding"], settings: "old\n" });
  mkdirSync(join(home, "profiles", "coding", ".pnpm", "pkg@1"), { recursive: true });
  writeFileSync(join(home, "profiles", "coding", ".pnpm", "pkg@1", "index.js"), "pkg-v1\n");
  mkdirSync(join(home, "profiles", "coding", "node_modules"), { recursive: true });
  linkDir(
    join(home, "profiles", "coding", ".pnpm", "pkg@1"),
    join(home, "profiles", "coding", "node_modules", "pkg"),
  );
  const original = store.create(runtime);
  writeFileSync(join(home, "profiles", "coding", ".pnpm", "pkg@1", "index.js"), "pkg-v2\n");
  writeFileSync(join(home, "settings.yaml"), "new\n");

  const first = store.restore(original.id, runtime);
  store.completeRestore();
  const restoredLink = join(home, "profiles", "coding", "node_modules", "pkg");
  const restoredTarget = resolveLink(restoredLink);
  assert.ok(isInsidePath(join(home, "profiles", "coding"), restoredTarget), restoredTarget);
  assert.equal(readFileSync(join(restoredTarget, "index.js"), "utf8"), "pkg-v1\n");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "old\n");

  writeFileSync(join(home, "settings.yaml"), "again\n");
  const selected: SnapshotRuntime = {
    version: first.restored.runtimeVersion,
    root: store.runtimeRoot(first.restored.id),
    binRelative: first.restored.binRelative,
  };
  store.restore(original.id, selected);
  store.completeRestore();
  assert.equal(readFileSync(join(resolveLink(restoredLink), "index.js"), "utf8"), "pkg-v1\n");
  assert.ok(isInsidePath(join(home, "profiles"), resolveLink(restoredLink)));
});

test("linked managed paths cannot escape the home; outside files stay put", () => {
  const { home, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "keep\n" });
  writeFileSync(join(home, "notes.txt"), "external\n");
  const outside = fakeDir("dsh-out-");
  writeFileSync(join(outside, "stolen.txt"), "secret\n");
  rmTree(join(home, "profiles"));
  mkdirSync(join(home, "profiles"));
  rmdirSync(join(home, "profiles"));
  linkDir(outside, join(home, "profiles"));

  const root = fakeDir("dsh-snaps-");
  const store = new SnapshotStore({ home, root });
  assert.throws(() => store.create(runtime), /link|symlink|managed|outside/i);
  assert.equal(readFileSync(join(outside, "stolen.txt"), "utf8"), "secret\n");
  assert.equal(readFileSync(join(home, "notes.txt"), "utf8"), "external\n");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "keep\n");
  assert.equal(store.list().length, 0);
});

test("inject after each swap rename rolls back; data-swapped recover returns pending", () => {
  const { home, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "old\n", session: "old-session\n" });
  const root = fakeDir("dsh-snaps-");

  const afterBackup = new SnapshotStore({
    home,
    root,
    inject: (op, detail) => {
      if (op === "restore:backed-up" && detail === "profiles") throw new Error("after backup");
    },
  });
  const snap = afterBackup.create(runtime);
  writeFileSync(join(home, "settings.yaml"), "new\n");
  assert.throws(() => afterBackup.restore(snap.id, runtime), /after backup/);
  assert.equal(readFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "utf8"), "web\n");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "new\n");
  assert.equal(existsSync(join(home, RESTORE_STAGE_DIR)), false);

  const afterReplace = new SnapshotStore({
    home,
    root,
    inject: (op, detail) => {
      if (op === "restore:replaced" && detail === "profiles") throw new Error("after replace");
    },
  });
  assert.throws(() => afterReplace.restore(snap.id, runtime), /after replace/);
  assert.equal(readFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "utf8"), "web\n");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "new\n");
  assert.equal(afterReplace.pendingRestore(), undefined);

  const afterAll = new SnapshotStore({
    home,
    root,
    inject: (op, detail) => {
      if (op === "restore:replaced" && detail === "settings.yaml") throw new Error("after last replace");
    },
  });
  assert.throws(() => afterAll.restore(snap.id, runtime), /after last replace/);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "old\n");
  const restarted = new SnapshotStore({ home, root });
  const pending = restarted.recover();
  assert.ok(pending);
  assert.equal(pending?.snapshotId, snap.id);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "old\n");
  restarted.completeRestore();
});

test("rollback of a backed-up junction keeps the original live target", () => {
  const { home, runtime } = harness();
  seedHome(home, { profiles: ["coding"], settings: "live\n" });
  mkdirSync(join(home, "profiles", "coding", "store"), { recursive: true });
  writeFileSync(join(home, "profiles", "coding", "store", "a.txt"), "from-live\n");
  mkdirSync(join(home, "profiles", "coding", "node_modules"), { recursive: true });
  linkDir(join(home, "profiles", "coding", "store"), join(home, "profiles", "coding", "node_modules", "pkg"));
  const root = fakeDir("dsh-snaps-");
  const store = new SnapshotStore({
    home,
    root,
    inject: (op, detail) => {
      if (op === "restore:backed-up" && detail === "profiles") throw new Error("stop after backup");
    },
  });
  const snap = store.create(runtime);
  writeFileSync(join(home, "profiles", "coding", "store", "a.txt"), "dirty\n");
  assert.throws(() => store.restore(snap.id, runtime), /stop after backup/);
  const target = resolveLink(join(home, "profiles", "coding", "node_modules", "pkg"));
  assert.ok(isInsidePath(join(home, "profiles", "coding"), target), target);
  assert.equal(readFileSync(join(target, "a.txt"), "utf8"), "dirty\n");
});

test("generated CLI fallback links are rebuilt from the captured runtime while local plugins and global patches survive", () => {
  const { home, root, runtime, store } = harness();
  mkdirSync(join(runtime.root, "sdk"));
  writeFileSync(join(runtime.root, "sdk", "module.js"), "runtime dependency");
  const shared = join(home, "profiles", "node_modules");
  mkdirSync(shared, { recursive: true });
  symlinkSync(join(runtime.root, "sdk"), join(shared, "sdk"), process.platform === "win32" ? "junction" : "dir");
  mkdirSync(join(shared, "user-plugin"));
  writeFileSync(join(shared, "user-plugin", "index.js"), "user plugin");
  writeFileSync(join(home, "cordis.patch.yml"), "# original global patch\n");
  const snapshot = store.create(runtime);
  assert.equal(existsSync(join(root, snapshot.id, "data", "profiles", "node_modules", "sdk")), false);
  assert.equal(readFileSync(join(root, snapshot.id, "runtime", "sdk", "module.js"), "utf8"), "runtime dependency");
  writeFileSync(join(home, "cordis.patch.yml"), "# changed global patch\n");
  store.restore(snapshot.id, runtime); store.completeRestore();
  assert.equal(readFileSync(join(shared, "user-plugin", "index.js"), "utf8"), "user plugin");
  assert.equal(readFileSync(join(home, "cordis.patch.yml"), "utf8"), "# original global patch\n");
});

test("recover retargets junctions after the final data rename was interrupted", () => {
  const { home, root, runtime, store } = harness();
  mkdirSync(join(home, "hub", "data"), { recursive: true });
  writeFileSync(join(home, "hub", "data", "value.txt"), "snapshot value");
  symlinkSync(join(home, "hub", "data"), join(home, "hub", "linked"), process.platform === "win32" ? "junction" : "dir");
  const snapshot = store.create(runtime);
  const interrupted = new SnapshotStore({ home, root, inject: (op, name) => {
    if (op === "restore:replaced" && name === "hub") throw new Error("power loss after last rename");
  } });
  assert.throws(() => interrupted.restore(snapshot.id, runtime), /power loss/);
  const recovered = new SnapshotStore({ home, root });
  assert.equal(recovered.recover()?.snapshotId, snapshot.id);
  recovered.completeRestore();
  assert.equal(readFileSync(join(home, "hub", "linked", "value.txt"), "utf8"), "snapshot value");
});

test("data-only before-restore saves data, refuses complete restore, and leaves user data when unconfirmed", () => {
  const { home, root, store, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "old\n", session: "old-session\n" });
  const target = store.create(runtime);
  writeFileSync(join(home, "settings.yaml"), "new\n");
  writeFileSync(join(home, "sessions", "chat.jsonl"), "new-session\n");
  const beforeCount = store.list().length;

  assert.throws(
    () => store.restore(target.id, undefined),
    /allowDataOnlyBackup|missing or damaged/,
  );
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "new\n");
  assert.equal(store.list().length, beforeCount);

  const { restored, beforeRestore } = store.restore(target.id, undefined, {
    allowDataOnlyBackup: true,
    recordedRuntime: { version: "0.1.1-rc.2", root: runtime.root, binRelative: runtime.binRelative },
  });
  assert.equal(restored.id, target.id);
  assert.equal(beforeRestore.runtimeMissing, true);
  assert.equal(beforeRestore.runtimeVersion, "0.1.1-rc.2");
  assert.equal(beforeRestore.reason, "before-restore");
  assert.equal(existsSync(join(root, beforeRestore.id, "runtime")), false);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "old\n");
  assert.throws(() => store.runtimeBin(beforeRestore.id), /no runtime|restore target/);
  assert.throws(() => store.runtimeRoot(beforeRestore.id), /no runtime|restore target/);
  store.completeRestore();
  assert.throws(
    () => store.restore(beforeRestore.id, runtime, { allowDataOnlyBackup: true }),
    /data only|restore target/,
  );
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "old\n");
});

test("allowDataOnlyBackup still takes a full backup when the current runtime is intact", () => {
  const { home, store, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "old\n" });
  const target = store.create(runtime);
  writeFileSync(join(home, "settings.yaml"), "new\n");
  const { beforeRestore } = store.restore(target.id, runtime, { allowDataOnlyBackup: true });
  assert.equal(beforeRestore.runtimeMissing, undefined);
  assert.ok(existsSync(store.runtimeBin(beforeRestore.id)));
  store.completeRestore();
});

test("data-only backup omits generated links into a missing runtime instead of skipping the backup", () => {
  const { home, root, store, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "keep\n" });
  const target = store.create(runtime);
  const missingRuntime = fakeDir("dsh-rt-missing-");
  mkdirSync(join(missingRuntime, "sdk"), { recursive: true });
  const shared = join(home, "profiles", "node_modules");
  mkdirSync(shared, { recursive: true });
  symlinkSync(join(missingRuntime, "sdk"), join(shared, "sdk"), process.platform === "win32" ? "junction" : "dir");
  rmTree(join(missingRuntime, "sdk"));
  writeFileSync(join(home, "settings.yaml"), "dirty\n");
  const { beforeRestore } = store.restore(target.id, undefined, {
    allowDataOnlyBackup: true,
    recordedRuntime: { version: "1.0.0", root: missingRuntime, binRelative: "bin.js" },
  });
  assert.equal(beforeRestore.runtimeMissing, true);
  assert.equal(existsSync(join(root, beforeRestore.id, "runtime")), false);
  assert.equal(existsSync(join(root, beforeRestore.id, "data", "profiles", "node_modules", "sdk")), false);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "keep\n");
  store.completeRestore();
});

test("old snapshots without runtimeMissing remain complete restore targets", () => {
  const { home, root, store, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "old\n" });
  const snap = store.create(runtime);
  const manifestPath = join(root, snap.id, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  delete manifest.runtimeMissing;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(store.preview(snap.id).runtimeMissing, undefined);
  writeFileSync(join(home, "settings.yaml"), "new\n");
  const { restored } = store.restore(snap.id, runtime);
  assert.equal(restored.id, snap.id);
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "old\n");
  store.completeRestore();
});

function harness(): { home: string; root: string; runtime: SnapshotRuntime; store: SnapshotStore } {
  const home = fakeDir("dsh-home-");
  const root = fakeDir("dsh-snaps-");
  const runtimeDir = fakeDir("dsh-rt-");
  writeFileSync(join(runtimeDir, "bin.js"), "cli\n");
  const runtime: SnapshotRuntime = { version: "1.0.0", root: runtimeDir, binRelative: "bin.js" };
  return { home, root, runtime, store: new SnapshotStore({ home, root }) };
}

function seedHome(home: string, opts: { profiles?: string[]; settings?: string; session?: string }): void {
  for (const name of opts.profiles ?? []) {
    mkdirSync(join(home, "profiles", name), { recursive: true });
    writeFileSync(join(home, "profiles", name, "cordis.patch.yml"), `${name}\n`);
  }
  if (opts.settings !== undefined) writeFileSync(join(home, "settings.yaml"), opts.settings);
  if (opts.session !== undefined) {
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "chat.jsonl"), opts.session);
  }
}

function fakeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function linkDir(target: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (process.platform === "win32") {
    symlinkSync(resolve(target), dest, "junction");
    return;
  }
  symlinkSync(relative(dirname(dest), target) || ".", dest);
}

function resolveLink(path: string): string {
  const raw = String(readlinkSync(path));
  return isAbsolute(raw) ? resolve(raw) : resolve(dirname(path), raw);
}

function isInsidePath(root: string, target: string): boolean {
  const r = resolve(root).toLowerCase();
  const t = resolve(target).toLowerCase();
  return t === r || t.startsWith(`${r}\\`) || t.startsWith(`${r}/`);
}

function rmTree(path: string): void {
  if (!existsSync(path)) return;
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    const st = lstatSync(current);
    if (st.isSymbolicLink() || st.isFile()) {
      unlinkSync(current);
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(current)) walk(join(current, name));
      rmdirSync(current);
    }
  };
  try {
    walk(path);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}
