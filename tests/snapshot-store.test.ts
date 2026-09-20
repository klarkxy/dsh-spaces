import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { SnapshotStore } from "../src/adapters/node/snapshot-store.ts";
import {
  RESTORE_STAGE_DIR,
  SNAPSHOT_ID_RE,
  type SnapshotRuntime,
} from "../src/shared/snapshots.ts";

const temps: string[] = [];
const PLAN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  for (const dir of temps.splice(0)) rmTree(dir);
});

test("create lists presence, keeps credentials out of the snapshot, and does not rewrite live home", () => {
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
  assert.equal(store.preview(original.id).id, original.id);
  assert.equal(readFileSync(store.runtimeBin(original.id), "utf8"), "cli\n");
  assert.equal(existsSync(join(root, original.id, "data", ".credentials.yaml")), false);
  assert.equal(existsSync(join(root, original.id, "data", ".anonymous-user-id")), false);
  assert.equal(readFileSync(join(root, original.id, "data", "settings.yaml"), "utf8"), "old-settings\n");

  mkdirSync(join(home, "profiles", "notes"), { recursive: true });
  writeFileSync(join(home, "profiles", "notes", "cordis.patch.yml"), "new-profile\n");
  writeFileSync(join(home, "settings.yaml"), "new-settings\n");
  assert.equal(readFileSync(join(home, ".credentials.yaml"), "utf8"), "secret-key\n");
  assert.equal(readFileSync(join(home, "notes.txt"), "utf8"), "keep-me\n");
  assert.equal(readFileSync(join(root, original.id, "data", "settings.yaml"), "utf8"), "old-settings\n");
  assert.equal(existsSync(join(root, original.id, "data", "profiles", "notes")), false);
});

test("path-escaping ids are rejected and restore methods do not write", () => {
  const { home, store, runtime, root } = harness();
  seedHome(home, { profiles: ["web"], settings: "a\n" });
  const snap = store.create(runtime);
  const settings = readFileSync(join(home, "settings.yaml"));
  assert.throws(() => store.preview(`../${snap.id}`), /not a snapshot directory/);
  assert.throws(() => store.preview(`${snap.id}/../${snap.id}`), /not a snapshot directory/);
  assert.throws(() => store.delete(join(root, snap.id)), /not a snapshot directory/);
  assert.throws(() => store.preview(`/tmp/${snap.id}`), /not a snapshot directory/);
  assert.throws(() => store.restore(snap.id, runtime), /not supported/);
  assert.throws(() => store.recover(), /not supported/);
  assert.throws(() => store.completeRestore(), /not supported/);
  assert.deepEqual(readFileSync(join(home, "settings.yaml")), settings);
  assert.equal(store.list().length, 1);
  assert.equal(existsSync(join(root, "pending-restore.json")), false);
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
  usedId = "";
  used.delete(snap.id);
  assert.equal(used.list().length, 0);

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

test("create refuses a missing runtime binary and path-escaping binRelative", () => {
  const { home, store, runtime } = harness();
  seedHome(home, { profiles: ["web"] });
  const snap = store.create(runtime);
  assert.ok(existsSync(store.runtimeBin(snap.id)));
  assert.throws(() => store.create({ ...runtime, binRelative: "missing.js" }), /does not exist/);
  assert.throws(() => store.create({ ...runtime, binRelative: "../bin.js" }), /escapes/);
});

test("create accepts a published snapshot runtime without copying the store", () => {
  const { home, root, store, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "v1\n" });
  const first = store.create(runtime, "install");
  const selected: SnapshotRuntime = {
    version: first.runtimeVersion,
    root: store.runtimeRoot(first.id),
    binRelative: first.binRelative,
  };
  writeFileSync(join(home, "settings.yaml"), "v2\n");
  const fromSnap = store.create(selected, "upgrade");
  assert.equal(existsSync(join(root, fromSnap.id, "runtime", first.id)), false);
  assert.equal(existsSync(join(root, fromSnap.id, "runtime", "data")), false);
  assert.equal(existsSync(join(root, fromSnap.id, "data", first.id)), false);
  assert.equal(readFileSync(store.runtimeBin(fromSnap.id), "utf8"), "cli\n");
  const published = readdirSync(root).filter((name) => SNAPSHOT_ID_RE.test(name));
  assert.equal(published.length, 2);
  for (const id of published) {
    assert.equal(existsSync(join(root, id, first.id)), false);
  }
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

test("windows-style internal junctions are rewritten inside the created snapshot", () => {
  const { home, root, store, runtime } = harness();
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
  const snapLink = join(root, original.id, "data", "profiles", "coding", "node_modules", "pkg");
  const snapTarget = resolveLink(snapLink);
  assert.ok(isInsidePath(join(root, original.id, "data", "profiles", "coding"), snapTarget), snapTarget);
  assert.equal(readFileSync(join(snapTarget, "index.js"), "utf8"), "pkg-v1\n");
  assert.equal(readFileSync(join(home, "profiles", "coding", ".pnpm", "pkg@1", "index.js"), "utf8"), "pkg-v2\n");
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

test("generated CLI fallback links are omitted from snapshot data while local plugins and patches are kept", () => {
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
  assert.equal(readFileSync(join(root, snapshot.id, "data", "profiles", "node_modules", "user-plugin", "index.js"), "utf8"), "user plugin");
  assert.equal(readFileSync(join(root, snapshot.id, "data", "cordis.patch.yml"), "utf8"), "# original global patch\n");
});

test("unfinished pending/journal/receipt evidence is read-only and blocks writes", () => {
  const { home, root, store, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "live\n" });
  const snap = store.create(runtime);
  const pendingPath = join(root, "pending-restore.json");
  const pending = Buffer.from(`${JSON.stringify({
    snapshotId: snap.id,
    beforeRestoreId: snap.id,
    runtimeVersion: "1.0.0",
    binRelative: "bin.js",
    startedAt: "2026-09-12T00:00:00.000Z",
    planId: PLAN_A,
  }, null, 2)}\n`);
  writeFileSync(pendingPath, pending);
  const journalPath = join(home, RESTORE_STAGE_DIR, "journal.json");
  mkdirSync(dirname(journalPath), { recursive: true });
  const journal = Buffer.from(`${JSON.stringify({
    phase: "swapping",
    snapshotId: snap.id,
    beforeRestoreId: snap.id,
    originalPresence: {
      profiles: true,
      sessions: false,
      storages: false,
      hub: false,
      "settings.yaml": true,
      "cordis.patch.yml": false,
    },
    runtimeVersion: "1.0.0",
    binRelative: "bin.js",
    startedAt: "2026-09-12T00:00:00.000Z",
    planId: PLAN_A,
  }, null, 2)}\n`);
  writeFileSync(journalPath, journal);
  const settings = readFileSync(join(home, "settings.yaml"));

  assert.equal(store.pendingRestore()?.planId, PLAN_A);
  assert.equal(store.restoreJournal()?.phase, "swapping");
  assert.throws(() => store.create(runtime), /Unfinished restore evidence/);
  assert.throws(() => store.delete(snap.id), /Unfinished restore evidence/);
  assert.throws(() => store.restore(snap.id, runtime), /not supported/);
  assert.throws(() => store.recover(), /not supported/);
  assert.throws(() => store.completeRestore(), /not supported/);
  assert.deepEqual(readFileSync(pendingPath), pending);
  assert.deepEqual(readFileSync(journalPath), journal);
  assert.deepEqual(readFileSync(join(home, "settings.yaml")), settings);
  assert.equal(store.list().length, 1);
  rmSync(pendingPath);
  assert.throws(() => store.create(runtime), /Unfinished restore evidence/);
  assert.throws(() => store.delete(snap.id), /Unfinished restore evidence/);
  assert.deepEqual(readFileSync(journalPath), journal);
  assert.equal(store.list().length, 1);
});

test("old snapshots without runtimeMissing remain readable; missing runtime refuses runtimeRoot", () => {
  const { home, root, store, runtime } = harness();
  seedHome(home, { profiles: ["web"], settings: "old\n" });
  const snap = store.create(runtime);
  const manifestPath = join(root, snap.id, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  delete manifest.runtimeMissing;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(store.preview(snap.id).runtimeMissing, undefined);
  assert.ok(existsSync(store.runtimeBin(snap.id)));

  const dataOnly = `${JSON.stringify({
    ...manifest,
    runtimeMissing: true,
  }, null, 2)}\n`;
  writeFileSync(manifestPath, dataOnly);
  assert.equal(store.preview(snap.id).runtimeMissing, true);
  assert.throws(() => store.runtimeBin(snap.id), /no runtime|restore target/);
  assert.throws(() => store.runtimeRoot(snap.id), /no runtime|restore target/);
  assert.equal(readFileSync(manifestPath, "utf8"), dataOnly);
});

test("bad and future restore receipts and journals throw and keep the original bytes", () => {
  const { home, root, store } = harness();
  const receiptPath = join(root, "restore-receipt.json");
  assert.equal(store.recoveryReceipt(), undefined);
  writeFileSync(receiptPath, "{not-json");
  assert.throws(() => store.recoveryReceipt(), /not valid JSON/);
  assert.equal(readFileSync(receiptPath, "utf8"), "{not-json");

  const future = `${JSON.stringify({
    schemaVersion: 2,
    outcome: "completed",
    snapshotId: "11111111-1111-1111-1111-111111111111",
    beforeRestoreId: "22222222-2222-2222-2222-222222222222",
    runtimeVersion: "1.0.0",
    binRelative: "bin.js",
    startedAt: "2026-09-12T00:00:00.000Z",
  }, null, 2)}\n`;
  writeFileSync(receiptPath, future);
  assert.throws(() => new SnapshotStore({ home, root }).recoveryReceipt(), /not supported/);
  assert.equal(readFileSync(receiptPath, "utf8"), future);

  const illegal = `${JSON.stringify({
    schemaVersion: 1,
    outcome: "rolled-back",
    snapshotId: "not-a-uuid",
    beforeRestoreId: "22222222-2222-2222-2222-222222222222",
    runtimeVersion: "1.0.0",
    binRelative: "bin.js",
    startedAt: "2026-09-12T00:00:00.000Z",
  }, null, 2)}\n`;
  writeFileSync(receiptPath, illegal);
  assert.throws(() => new SnapshotStore({ home, root }).recoveryReceipt(), /invalid/);
  assert.equal(readFileSync(receiptPath, "utf8"), illegal);

  const journalPath = join(home, RESTORE_STAGE_DIR, "journal.json");
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, "{not-json");
  assert.throws(() => store.restoreJournal(), /not valid JSON/);
  assert.equal(readFileSync(journalPath, "utf8"), "{not-json");
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
