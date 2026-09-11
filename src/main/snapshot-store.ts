import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWrite, renameDirectory as renameSync } from "./atomic";
import { assertNotRealHome, samePath } from "./home-guard";
import { isExactRuntimeVersion } from "../shared/runtime";
import {
  MANAGED_HOME_ENTRIES,
  RESTORE_STAGE_DIR,
  SNAPSHOT_ID_RE,
  type PendingRestore,
  type RestoreJournal,
  type RestoreResult,
  type RestoreSnapshotOptions,
  type SnapshotMeta,
  type SnapshotPresence,
  type SnapshotRuntime,
} from "../shared/snapshots";

const MANIFEST = "manifest.json";
const PENDING_FILE = "pending-restore.json";
const JOURNAL_FILE = "journal.json";
const DATA_DIR = "data";
const RUNTIME_DIR = "runtime";
const INCOMING_DIR = "incoming";
const BACKUP_DIR = "backup";

export type SnapshotInject = (op: string, detail?: string) => void;

export type SnapshotRestoreOptions = RestoreSnapshotOptions & {
  /** Layout recorded from a damaged current pointer. Never copied as a runtime. */
  recordedRuntime?: SnapshotRuntime;
};

export interface SnapshotStoreOptions {
  home: string;
  root: string;
  inUse?: (id: string) => boolean;
  /** Test seam for copy/rename failures. Not a general filesystem mock. */
  inject?: SnapshotInject;
}

interface Manifest extends SnapshotMeta {
  schemaVersion: 1;
}

/**
 * Copy a directory tree without dereferencing links.
 * `dest` must not exist. Internal relative links stay relative; internal
 * absolute links/junctions are rewritten into `dest`. External links throw.
 *
 * After `dest` is renamed to its published location, call
 * `retargetTree(published, dest, published)` so Windows junctions do not keep
 * pointing at the pre-rename path. Alternatively call
 * `retargetTree(dest, dest, published)` before the rename.
 */
export function copyLinkedTree(src: string, dest: string, fallbackRuntimeRoot?: string): void {
  if (lexists(dest)) {
    throw new Error(`copy destination already exists: ${dest}`);
  }
  const srcRoot = assertControlledRoot(src, "copy source");
  const destRoot = assertControlledRoot(dest, "copy destination", true);
  if (lstatSync(srcRoot).isSymbolicLink() || !lstatSync(srcRoot).isDirectory()) {
    throw new Error(`copy source must be a real directory: ${srcRoot}`);
  }
  mkdirSync(destRoot, { recursive: true });
  for (const name of readdirSync(srcRoot)) {
    copyNode(join(srcRoot, name), join(destRoot, name), srcRoot, destRoot, fallbackRuntimeRoot);
  }
}

/**
 * Rewrite absolute internal links/junctions after a tree is moved from
 * `oldRoot` to `newRoot`. Relative internal links are left alone so a rename
 * of the whole tree keeps its original semantics.
 */
export function retargetTree(dir: string, oldRoot: string, newRoot: string): void {
  if (!lexists(dir)) return;
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return;
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    const childSt = lstatSync(child);
    if (childSt.isSymbolicLink()) {
      retargetLink(child, oldRoot, newRoot);
    } else if (childSt.isDirectory()) {
      retargetTree(child, oldRoot, newRoot);
    }
  }
}

export class SnapshotStore {
  private readonly home: string;
  private readonly root: string;
  private readonly inUse: (id: string) => boolean;
  private readonly inject?: SnapshotInject;

  constructor(opts: SnapshotStoreOptions) {
    this.home = assertControlledRoot(opts.home, "DSH home");
    this.root = assertControlledRoot(opts.root, "snapshot store root", true);
    this.inUse = opts.inUse ?? (() => false);
    this.inject = opts.inject;
    assertDisjoint(this.home, this.root, "snapshot store root and DSH home");
  }

  list(): SnapshotMeta[] {
    if (!lexists(this.root)) return [];
    this.assertStoreRoot();
    const metas: SnapshotMeta[] = [];
    for (const name of readdirSync(this.root)) {
      if (!SNAPSHOT_ID_RE.test(name)) continue;
      metas.push(this.readPublished(name));
    }
    metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return metas;
  }

  create(runtime: SnapshotRuntime, reason?: string): SnapshotMeta {
    this.assertWritable();
    const prepared = this.prepareRuntime(runtime);
    return this.writeSnapshot({
      reason,
      runtimeVersion: prepared.version,
      binRelative: prepared.binRelative,
      copyRuntimeFrom: prepared.root,
    });
  }

  preview(id: string): SnapshotMeta {
    return this.readPublished(this.requireId(id));
  }

  runtimeRoot(id: string): string {
    const meta = this.preview(id);
    if (meta.runtimeMissing) {
      throw new Error(`Snapshot ${meta.id} has no runtime and cannot be used as a restore target`);
    }
    return this.snapshotRuntimeRoot(meta.id);
  }

  runtimeBin(id: string): string {
    const meta = this.preview(id);
    if (meta.runtimeMissing) {
      throw new Error(`Snapshot ${meta.id} has no runtime and cannot be used as a restore target`);
    }
    const runtimeRoot = this.snapshotRuntimeRoot(meta.id);
    const bin = resolve(runtimeRoot, ...meta.binRelative.split("/"));
    assertContained(runtimeRoot, bin, "runtime binary");
    if (samePath(bin, runtimeRoot) || !lexists(bin)) {
      throw new Error(`Snapshot ${meta.id} is missing its runtime binary`);
    }
    return bin;
  }

  restore(id: string, currentRuntime?: SnapshotRuntime, options?: SnapshotRestoreOptions): RestoreResult {
    this.assertWritable();
    const restored = this.preview(id);
    if (restored.runtimeMissing) {
      throw new Error(`Snapshot ${restored.id} saved data only and cannot be used as a restore target`);
    }
    this.assertHomeMatch(restored);
    const beforeRestore = this.backupCurrent(currentRuntime, options);
    const stage = this.stageDir();
    const startedAt = new Date().toISOString();
    rmContained(this.home, stage);
    mkdirSync(join(stage, INCOMING_DIR), { recursive: true });
    mkdirSync(join(stage, BACKUP_DIR), { recursive: true });
    const journal: RestoreJournal = {
      phase: "copying",
      snapshotId: restored.id,
      beforeRestoreId: beforeRestore.id,
      originalPresence: currentPresence(this.home),
      runtimeVersion: restored.runtimeVersion,
      binRelative: restored.binRelative,
      startedAt,
    };
    this.writeJournal(journal);
    try {
      this.stageIncoming(restored.id);
      this.hook("restore:staged");
      journal.phase = "swapping";
      this.writeJournal(journal);
      this.swapManaged(stage);
      this.finishSwapped(journal, restored, beforeRestore);
      return { restored: this.preview(restored.id), beforeRestore: this.preview(beforeRestore.id) };
    } catch (err) {
      if (!this.pendingRestore() && !this.isDataSwapped(journal)) {
        this.rollbackSwap(journal);
      }
      throw err;
    }
  }

  delete(id: string): void {
    this.assertWritable();
    const resolved = this.requireId(id);
    if (this.inUse(resolved)) {
      throw new Error(`Snapshot ${resolved} is in use and cannot be deleted`);
    }
    rmContained(this.root, join(this.root, resolved));
  }

  pendingRestore(): PendingRestore | undefined {
    const path = join(this.root, PENDING_FILE);
    if (!lexists(path)) return undefined;
    this.assertInsideStore(path);
    return parsePending(readFileSync(path, "utf8"), path);
  }

  completeRestore(): void {
    const pending = this.pendingRestore();
    if (!pending) {
      throw new Error("No pending restore to complete");
    }
    this.hook("restore:complete");
    rmContained(this.home, this.stageDir());
    this.hook("restore:complete-pending");
    const pendingPath = join(this.root, PENDING_FILE);
    if (lexists(pendingPath)) {
      this.assertInsideStore(pendingPath);
      unlinkSync(pendingPath);
    }
  }

  recover(): PendingRestore | undefined {
    const stage = this.stageDir();
    const journalPath = join(stage, JOURNAL_FILE);
    if (!lexists(journalPath)) {
      return this.pendingRestore();
    }
    this.assertInsideHome(journalPath);
    const journal = parseJournal(readFileSync(journalPath, "utf8"), journalPath);
    if (journal.phase === "swapped" || this.isDataSwapped(journal)) {
      // A crash may occur after the final rename but before its junctions are retargeted.
      for (const name of MANAGED_HOME_ENTRIES) {
        const live = join(this.home, name);
        this.assertInsideHome(live);
        if (lexists(live) && lstatSync(live).isDirectory()) {
          retargetTree(live, join(stage, INCOMING_DIR, name), live);
        }
      }
      if (!this.pendingRestore()) {
        this.writePending({
          snapshotId: journal.snapshotId,
          beforeRestoreId: journal.beforeRestoreId,
          runtimeVersion: journal.runtimeVersion,
          binRelative: journal.binRelative,
          startedAt: journal.startedAt,
        });
      }
      return this.pendingRestore();
    }
    this.rollbackSwap(journal);
    return undefined;
  }

  private backupCurrent(currentRuntime: SnapshotRuntime | undefined, options?: SnapshotRestoreOptions): SnapshotMeta {
    if (currentRuntime) {
      return this.create(currentRuntime, "before-restore");
    }
    if (options?.allowDataOnlyBackup !== true) {
      throw new Error(
        "Current runtime is missing or damaged; restoring requires allowDataOnlyBackup to save data without the runtime",
      );
    }
    const recorded = options.recordedRuntime;
    const binRelative = recorded?.binRelative
      ? normalizeRel(recorded.binRelative)
      : "missing-runtime";
    return this.writeSnapshot({
      reason: "before-restore",
      runtimeMissing: true,
      runtimeVersion: recorded?.version && isExactRuntimeVersion(recorded.version) ? recorded.version : "unknown",
      binRelative,
      omitRuntimeRoot: recorded?.root,
    });
  }

  private writeSnapshot(input: {
    reason?: string;
    runtimeVersion: string;
    binRelative: string;
    copyRuntimeFrom?: string;
    omitRuntimeRoot?: string;
    runtimeMissing?: boolean;
  }): SnapshotMeta {
    const id = randomUUID();
    const temp = join(this.root, `.tmp-${id}`);
    const published = join(this.root, id);
    mkdirSync(this.root, { recursive: true });
    this.assertInsideStore(temp);
    this.assertInsideStore(published);
    if (lexists(published) || lexists(temp)) {
      throw new Error(`Snapshot path already exists for ${id}`);
    }
    mkdirSync(temp, { recursive: true });
    let publishedReady = false;
    const fallbackRuntimeRoot = input.copyRuntimeFrom ?? input.omitRuntimeRoot;
    try {
      const dataDir = join(temp, DATA_DIR);
      mkdirSync(dataDir);
      const presence = emptyPresence();
      for (const name of MANAGED_HOME_ENTRIES) {
        const src = join(this.home, name);
        this.assertInsideHome(src);
        presence[name] = lexists(src);
        if (!presence[name]) continue;
        copyManagedEntry(src, join(dataDir, name), name === "profiles" ? fallbackRuntimeRoot : undefined);
      }
      if (input.copyRuntimeFrom) {
        copyLinkedTree(input.copyRuntimeFrom, join(temp, RUNTIME_DIR));
      }
      this.hook("create:copied");
      const meta = this.buildMeta(
        id,
        temp,
        { version: input.runtimeVersion, binRelative: input.binRelative },
        presence,
        input.reason,
        input.runtimeMissing,
      );
      atomicWrite(join(temp, MANIFEST), `${JSON.stringify(toManifest(meta), null, 2)}\n`);
      this.hook("create:retarget");
      retargetTree(temp, temp, published);
      this.hook("create:publish");
      renameSync(temp, published);
      publishedReady = true;
      this.hook("create:published");
      return this.readPublished(id);
    } catch (err) {
      rmContained(this.root, temp);
      if (!publishedReady) rmContained(this.root, published);
      throw err;
    }
  }

  private prepareRuntime(runtime: SnapshotRuntime): { version: string; root: string; binRelative: string } {
    if (!runtime.version.trim()) {
      throw new Error("Runtime version is required");
    }
    const root = resolve(runtime.root);
    assertNotRealHome(root);
    const publishedRuntime = this.publishedRuntimeSource(root);
    if (publishedRuntime) {
      this.assertInsideStore(publishedRuntime);
    } else {
      assertDisjoint(root, this.root, "snapshot store root and runtime root");
    }
    const binRelative = normalizeRel(runtime.binRelative);
    const runtimeRoot = publishedRuntime ?? root;
    const bin = resolve(runtimeRoot, ...binRelative.split("/"));
    assertContained(runtimeRoot, bin, "runtime binary");
    if (samePath(bin, runtimeRoot) || !lexists(bin)) {
      throw new Error(`Runtime binary does not exist: ${binRelative}`);
    }
    const st = lstatSync(runtimeRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error("Runtime root must be a real directory");
    }
    return { version: runtime.version, root: runtimeRoot, binRelative };
  }

  /**
   * Only the published `root/<uuid>/runtime` directory may sit inside the store.
   * The store itself, a snapshot dir, temp dirs, and nested paths are rejected.
   */
  private publishedRuntimeSource(root: string): string | undefined {
    const resolved = resolve(root);
    if (basename(resolved) !== RUNTIME_DIR) return undefined;
    const snapDir = dirname(resolved);
    const storeDir = dirname(snapDir);
    if (!samePath(storeDir, this.root)) return undefined;
    const id = basename(snapDir);
    if (!SNAPSHOT_ID_RE.test(id)) return undefined;
    const expected = join(this.root, id, RUNTIME_DIR);
    if (!samePath(expected, resolved)) return undefined;
    this.readPublished(id);
    return expected;
  }

  private buildMeta(
    id: string,
    snapDir: string,
    runtime: { version: string; binRelative: string },
    presence: SnapshotPresence,
    reason?: string,
    runtimeMissing?: boolean,
  ): SnapshotMeta {
    const profilesDir = join(snapDir, DATA_DIR, "profiles");
    const profiles = presence.profiles && lexists(profilesDir) ? listProfiles(profilesDir) : [];
    return {
      id,
      createdAt: new Date().toISOString(),
      reason,
      home: this.home,
      runtimeVersion: runtime.version,
      binRelative: runtime.binRelative,
      profiles,
      size: treeSize(snapDir),
      presence,
      ...(runtimeMissing ? { runtimeMissing: true } : {}),
    };
  }

  private readPublished(id: string): SnapshotMeta {
    const dir = join(this.root, id);
    this.assertInsideStore(dir);
    if (!lexists(dir)) {
      throw new Error(`Snapshot ${id} was not found`);
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Snapshot ${id} is not a directory`);
    }
    const manifestPath = join(dir, MANIFEST);
    if (!lexists(manifestPath)) {
      throw new Error(`Snapshot ${id} is missing its manifest`);
    }
    const meta = parseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    if (meta.id !== id) {
      throw new Error(`Snapshot directory ${id} does not match manifest id ${meta.id}`);
    }
    return meta;
  }

  private snapshotRuntimeRoot(id: string): string {
    const dir = join(this.root, id, RUNTIME_DIR);
    this.assertInsideStore(dir);
    if (!lexists(dir)) {
      throw new Error(`Snapshot ${id} is missing its runtime`);
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Snapshot ${id} runtime must be a real directory`);
    }
    return dir;
  }

  private stageIncoming(id: string): void {
    const srcData = join(this.root, id, DATA_DIR);
    this.assertInsideStore(srcData);
    const incoming = join(this.stageDir(), INCOMING_DIR);
    this.assertInsideHome(incoming);
    const manifest = this.readPublished(id);
    for (const name of MANAGED_HOME_ENTRIES) {
      const src = join(srcData, name);
      const dest = join(incoming, name);
      this.assertInsideStore(src);
      this.assertInsideHome(dest);
      const present = lexists(src);
      if (present !== manifest.presence[name]) {
        throw new Error(`Snapshot ${id} presence for ${name} does not match stored data`);
      }
      if (!present) continue;
      copyManagedEntry(src, dest);
    }
  }

  private swapManaged(stage: string): void {
    for (const name of MANAGED_HOME_ENTRIES) {
      this.hook("restore:swap", name);
      const live = join(this.home, name);
      const backup = join(stage, BACKUP_DIR, name);
      const incoming = join(stage, INCOMING_DIR, name);
      this.assertInsideHome(live);
      this.assertInsideHome(backup);
      this.assertInsideHome(incoming);
      if (lexists(live)) {
        if (lexists(backup)) {
          throw new Error(`Restore backup already exists for ${name}`);
        }
        renameSync(live, backup);
        this.hook("restore:backed-up", name);
      }
      if (lexists(incoming)) {
        renameSync(incoming, live);
        this.hook("restore:replaced", name);
        if (lstatSync(live).isDirectory()) {
          retargetTree(live, incoming, live);
        }
      }
    }
  }

  private isDataSwapped(journal: RestoreJournal): boolean {
    if (journal.phase === "copying") return false;
    const stage = this.stageDir();
    if (!lexists(join(stage, JOURNAL_FILE))) return false;
    for (const name of MANAGED_HOME_ENTRIES) {
      if (lexists(join(stage, INCOMING_DIR, name))) return false;
      if (journal.originalPresence[name] && !lexists(join(stage, BACKUP_DIR, name))) return false;
    }
    return true;
  }

  private finishSwapped(journal: RestoreJournal, restored: SnapshotMeta, beforeRestore: SnapshotMeta): void {
    const stage = this.stageDir();
    journal.phase = "swapped";
    this.writeJournal(journal);
    this.writePending({
      snapshotId: restored.id,
      beforeRestoreId: beforeRestore.id,
      runtimeVersion: restored.runtimeVersion,
      binRelative: restored.binRelative,
      startedAt: journal.startedAt,
    });
    this.hook("restore:pending");
    rmContained(stage, join(stage, INCOMING_DIR));
    rmContained(stage, join(stage, BACKUP_DIR));
  }

  private rollbackSwap(journal: RestoreJournal): void {
    const stage = this.stageDir();
    for (const name of MANAGED_HOME_ENTRIES) {
      const live = join(this.home, name);
      const backup = join(stage, BACKUP_DIR, name);
      this.assertInsideHome(live);
      this.assertInsideHome(backup);
      if (lexists(backup)) {
        if (lexists(live)) rmContained(this.home, live);
        renameSync(backup, live);
        continue;
      }
      if (!journal.originalPresence[name] && lexists(live)) {
        rmContained(this.home, live);
      }
    }
    const pendingPath = join(this.root, PENDING_FILE);
    if (lexists(pendingPath)) {
      this.assertInsideStore(pendingPath);
      unlinkSync(pendingPath);
    }
    rmContained(this.home, stage);
  }

  private assertWritable(): void {
    if (this.pendingRestore()) {
      throw new Error("A restore is pending; complete it before creating, restoring, or deleting snapshots");
    }
  }

  private assertHomeMatch(meta: SnapshotMeta): void {
    if (!samePath(meta.home, this.home)) {
      throw new Error(`Snapshot ${meta.id} belongs to a different DSH home`);
    }
  }

  private requireId(id: string): string {
    if (
      !id ||
      isAbsolute(id) ||
      id.includes("\0") ||
      id.includes("/") ||
      id.includes("\\") ||
      id.includes("..") ||
      !SNAPSHOT_ID_RE.test(id)
    ) {
      throw new Error("Snapshot id is not a snapshot directory in this store");
    }
    const dir = resolve(this.root, id);
    if (!samePath(dirname(dir), this.root)) {
      throw new Error("Snapshot id is outside the snapshot store");
    }
    return id;
  }

  private assertStoreRoot(): void {
    const st = lstatSync(this.root);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error(`Snapshot store root is not a directory: ${this.root}`);
    }
  }

  private assertInsideStore(target: string): void {
    assertContained(this.root, target, "snapshot store");
  }

  private assertInsideHome(target: string): void {
    assertContained(this.home, target, "DSH home");
  }

  private stageDir(): string {
    const dir = join(this.home, RESTORE_STAGE_DIR);
    this.assertInsideHome(dir);
    if (samePath(dir, this.home)) {
      throw new Error("Restore stage resolved to DSH home");
    }
    return dir;
  }

  private writeJournal(journal: RestoreJournal): void {
    const path = join(this.stageDir(), JOURNAL_FILE);
    this.assertInsideHome(path);
    atomicWrite(path, `${JSON.stringify(journal, null, 2)}\n`);
  }

  private writePending(pending: PendingRestore): void {
    const path = join(this.root, PENDING_FILE);
    this.assertInsideStore(path);
    atomicWrite(path, `${JSON.stringify(pending, null, 2)}\n`);
  }

  private hook(op: string, detail?: string): void {
    this.inject?.(op, detail);
  }
}

function toManifest(meta: SnapshotMeta): Manifest {
  return { schemaVersion: 1, ...meta };
}

function emptyPresence(): SnapshotPresence {
  return {
    profiles: false,
    sessions: false,
    storages: false,
    hub: false,
    "settings.yaml": false,
    "cordis.patch.yml": false,
  };
}

function currentPresence(home: string): SnapshotPresence {
  const presence = emptyPresence();
  for (const name of MANAGED_HOME_ENTRIES) {
    presence[name] = lexists(join(home, name));
  }
  return presence;
}

function copyManagedEntry(src: string, dest: string, fallbackRuntimeRoot?: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to snapshot symlink at managed path ${src}`);
  }
  if (st.isDirectory()) {
    copyLinkedTree(src, dest, fallbackRuntimeRoot);
    return;
  }
  if (st.isFile()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return;
  }
  throw new Error(`Unsupported managed path type: ${src}`);
}

function copyNode(from: string, to: string, srcRoot: string, destRoot: string, fallbackRuntimeRoot?: string): void {
  // Checked roots, enumerated names and link-only copying keep recursion in this tree.
  if (!isInside(destRoot, to)) throw new Error("Copy destination escaped its root");
  const st = lstatSync(from);
  if (st.isSymbolicLink()) {
    copyLink(from, to, srcRoot, destRoot, fallbackRuntimeRoot);
    return;
  }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      copyNode(join(from, name), join(to, name), srcRoot, destRoot, fallbackRuntimeRoot);
    }
    return;
  }
  if (st.isFile()) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    return;
  }
  throw new Error(`Unsupported file type at ${from}`);
}

function copyLink(from: string, to: string, srcRoot: string, destRoot: string, fallbackRuntimeRoot?: string): void {
  const raw = normalizeReadlink(String(readlinkSync(from)));
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(dirname(from), raw);
  if (!isInside(srcRoot, resolved)) {
    // DSH heals profiles/node_modules from its CLI on every boot, without a download.
    // Only omit generated fallback links into the runtime captured alongside this profile tree.
    // Locally installed plugins and links to any other outside directory are not omitted.
    if (fallbackRuntimeRoot && isRuntimeFallback(from, srcRoot, fallbackRuntimeRoot, resolved)) return;
    throw new Error(`External link is not in snapshot scope: ${from} -> ${raw}`);
  }
  const destTarget = resolve(destRoot, relative(resolve(srcRoot), resolved));
  assertContained(destRoot, destTarget, "rewritten link target");
  mkdirSync(dirname(to), { recursive: true });
  recreateLink(to, destTarget, followsDirectory(from));
}

function isRuntimeFallback(from: string, profiles: string, runtimeRoot: string, target: string): boolean {
  if (!isInside(join(profiles, "node_modules"), from) || !isInside(runtimeRoot, target)) return false;
  try {
    return isInside(realpathSync(runtimeRoot), realpathSync(from));
  } catch {
    return true;
  }
}

/** Discard only CLI-generated shared links; DSH rebuilds them offline on the next boot. */
export function clearRuntimeFallback(profiles: string, runtimeRoot: string): void {
  const modules = join(profiles, "node_modules");
  if (!lexists(modules)) return;
  const visit = (path: string): void => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      const raw = normalizeReadlink(String(readlinkSync(path)));
      const target = isAbsolute(raw) ? resolve(raw) : resolve(dirname(path), raw);
      if (isRuntimeFallback(path, profiles, runtimeRoot, target)) unlinkSync(path);
    } else if (st.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    }
  };
  visit(modules);
}

function recreateLink(linkPath: string, destTarget: string, dir: boolean): void {
  const rel = relative(dirname(linkPath), destTarget);
  const relTarget = rel.length === 0 ? "." : rel;
  try {
    symlinkSync(relTarget, linkPath, dir ? "dir" : "file");
  } catch (err) {
    if (process.platform === "win32" && dir) {
      symlinkSync(resolve(destTarget), linkPath, "junction");
      return;
    }
    throw err;
  }
}

function retargetLink(linkPath: string, oldRoot: string, newRoot: string): void {
  const raw = normalizeReadlink(String(readlinkSync(linkPath)));
  if (!isAbsolute(raw)) return;
  const resolved = resolve(raw);
  if (isInside(newRoot, resolved) && !isInside(oldRoot, resolved)) return;
  if (!isInside(oldRoot, resolved) && !isInside(newRoot, resolved)) {
    throw new Error(`Link escaped the snapshot tree: ${linkPath} -> ${raw}`);
  }
  const fromRoot = isInside(oldRoot, resolved) ? oldRoot : newRoot;
  const destTarget = resolve(newRoot, relative(resolve(fromRoot), resolved));
  assertContained(newRoot, destTarget, "retargeted link");
  const dir = followsDirectory(linkPath) || isDirectoryEntry(destTarget);
  unlinkSync(linkPath);
  recreateLink(linkPath, destTarget, dir);
}

function followsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isDirectoryEntry(path: string): boolean {
  if (!lexists(path)) return false;
  const st = lstatSync(path);
  if (st.isDirectory()) return true;
  if (st.isSymbolicLink()) return followsDirectory(path);
  return false;
}

function listProfiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort();
}

function treeSize(root: string): number {
  let total = 0;
  const walk = (path: string): void => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return;
    if (st.isFile()) {
      total += st.size;
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    }
  };
  walk(root);
  return total;
}

function parseManifest(raw: string, path: string): SnapshotMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Snapshot manifest is not valid JSON: ${path}`);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error(`Snapshot manifest schema is not supported: ${path}`);
  }
  if (typeof parsed.id !== "string" || !SNAPSHOT_ID_RE.test(parsed.id)) {
    throw new Error(`Snapshot manifest id is invalid: ${path}`);
  }
  if (typeof parsed.createdAt !== "string" || Number.isNaN(Date.parse(parsed.createdAt))) {
    throw new Error(`Snapshot manifest createdAt is invalid: ${path}`);
  }
  if (typeof parsed.home !== "string" || !parsed.home) {
    throw new Error(`Snapshot manifest home is invalid: ${path}`);
  }
  if (typeof parsed.runtimeVersion !== "string" || !parsed.runtimeVersion) {
    throw new Error(`Snapshot manifest runtime version is invalid: ${path}`);
  }
  if (typeof parsed.binRelative !== "string") {
    throw new Error(`Snapshot manifest binRelative is invalid: ${path}`);
  }
  if (!Array.isArray(parsed.profiles) || parsed.profiles.some((name) => typeof name !== "string")) {
    throw new Error(`Snapshot manifest profiles are invalid: ${path}`);
  }
  if (typeof parsed.size !== "number" || !Number.isFinite(parsed.size) || parsed.size < 0) {
    throw new Error(`Snapshot manifest size is invalid: ${path}`);
  }
  const presence = parsePresence(parsed.presence, path);
  const reason = parsed.reason;
  if (reason !== undefined && typeof reason !== "string") {
    throw new Error(`Snapshot manifest reason is invalid: ${path}`);
  }
  if (parsed.runtimeMissing !== undefined && parsed.runtimeMissing !== true && parsed.runtimeMissing !== false) {
    throw new Error(`Snapshot manifest runtimeMissing is invalid: ${path}`);
  }
  return {
    id: parsed.id,
    createdAt: parsed.createdAt,
    reason,
    home: parsed.home,
    runtimeVersion: parsed.runtimeVersion,
    binRelative: normalizeRel(parsed.binRelative),
    profiles: parsed.profiles as string[],
    size: parsed.size,
    presence,
    ...(parsed.runtimeMissing === true ? { runtimeMissing: true } : {}),
  };
}

function parsePending(raw: string, path: string): PendingRestore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Pending restore file is not valid JSON: ${path}`);
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.snapshotId !== "string" ||
    !SNAPSHOT_ID_RE.test(parsed.snapshotId) ||
    typeof parsed.beforeRestoreId !== "string" ||
    !SNAPSHOT_ID_RE.test(parsed.beforeRestoreId) ||
    typeof parsed.runtimeVersion !== "string" ||
    typeof parsed.binRelative !== "string" ||
    typeof parsed.startedAt !== "string"
  ) {
    throw new Error(`Pending restore file is invalid: ${path}`);
  }
  return {
    snapshotId: parsed.snapshotId,
    beforeRestoreId: parsed.beforeRestoreId,
    runtimeVersion: parsed.runtimeVersion,
    binRelative: normalizeRel(parsed.binRelative),
    startedAt: parsed.startedAt,
  };
}

function parseJournal(raw: string, path: string): RestoreJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Restore journal is not valid JSON: ${path}`);
  }
  if (
    !isRecord(parsed) ||
    (parsed.phase !== "copying" && parsed.phase !== "swapping" && parsed.phase !== "swapped") ||
    typeof parsed.snapshotId !== "string" ||
    !SNAPSHOT_ID_RE.test(parsed.snapshotId) ||
    typeof parsed.beforeRestoreId !== "string" ||
    !SNAPSHOT_ID_RE.test(parsed.beforeRestoreId) ||
    typeof parsed.runtimeVersion !== "string" ||
    typeof parsed.binRelative !== "string" ||
    typeof parsed.startedAt !== "string"
  ) {
    throw new Error(`Restore journal is invalid: ${path}`);
  }
  return {
    phase: parsed.phase,
    snapshotId: parsed.snapshotId,
    beforeRestoreId: parsed.beforeRestoreId,
    originalPresence: parsePresence(parsed.originalPresence, path),
    runtimeVersion: parsed.runtimeVersion,
    binRelative: normalizeRel(parsed.binRelative),
    startedAt: parsed.startedAt,
  };
}

function parsePresence(value: unknown, path: string): SnapshotPresence {
  if (!isRecord(value)) {
    throw new Error(`Snapshot presence is invalid: ${path}`);
  }
  const presence = emptyPresence();
  for (const name of MANAGED_HOME_ENTRIES) {
    if (name === "cordis.patch.yml" && value[name] === undefined) continue;
    if (typeof value[name] !== "boolean") {
      throw new Error(`Snapshot presence for ${name} is invalid: ${path}`);
    }
    presence[name] = value[name];
  }
  return presence;
}

function normalizeRel(rel: string): string {
  if (!rel || isAbsolute(rel) || rel.includes("\0")) {
    throw new Error(`Relative path is invalid: ${rel}`);
  }
  const parts = rel.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Relative path escapes its root: ${rel}`);
  }
  return parts.join("/");
}

function normalizeReadlink(raw: string): string {
  if (raw.startsWith("\\\\?\\")) return raw.slice(4);
  return raw;
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDisjoint(a: string, b: string, label: string): void {
  if (isInside(a, b) || isInside(b, a)) {
    throw new Error(`Refusing nested paths for ${label}`);
  }
}

function assertControlledRoot(path: string, label: string, optional = false): string {
  const resolved = resolve(path);
  assertNotRealHome(resolved);
  if (!lexists(resolved)) {
    if (!optional) {
      throw new Error(`${label} does not exist: ${resolved}`);
    }
    const ancestor = nearestExisting(resolved);
    assertRealDir(ancestor, label);
    return resolved;
  }
  return assertRealDir(resolved, label);
}

function assertRealDir(path: string, label: string): string {
  const resolved = resolve(path);
  const st = lstatSync(resolved);
  if (st.isSymbolicLink()) {
    throw new Error(`${label} must not be a link directory: ${resolved}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolved}`);
  }
  const real = realpathSync(resolved);
  if (!samePath(real, resolved)) {
    throw new Error(`${label} escapes through a linked path: ${resolved} -> ${real}`);
  }
  return real;
}

function nearestExisting(path: string): string {
  let current = resolve(path);
  while (!lexists(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`No existing ancestor for ${path}`);
    }
    current = parent;
  }
  return current;
}

function assertContained(root: string, target: string, label: string): void {
  const resolved = resolve(target);
  if (!isInside(root, resolved)) {
    throw new Error(`Refusing to touch path outside ${label}: ${resolved}`);
  }
  const existing = lexists(resolved) ? resolved : nearestExisting(resolved);
  if (!isInside(root, existing) && !samePath(root, existing)) {
    if (!lexists(root)) return;
    throw new Error(`Refusing to touch path outside ${label}: ${existing}`);
  }
  const st = lstatSync(existing);
  if (st.isSymbolicLink()) {
    if (samePath(existing, resolved)) return;
    throw new Error(`Refusing linked path outside ${label}: ${existing}`);
  }
  const real = realpathSync(existing);
  const realRoot = lexists(root) ? realpathSync(root) : resolve(root);
  if (!isInside(realRoot, real) && !samePath(realRoot, real)) {
    throw new Error(`Refusing to touch path outside ${label}: ${real}`);
  }
}

function isInside(root: string, target: string): boolean {
  const r = canon(root);
  const t = canon(target);
  if (t === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

function canon(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function rmContained(root: string, target: string): void {
  if (!lexists(target)) return;
  assertContained(root, target, "controlled directory");
  if (samePath(target, root)) {
    throw new Error(`Refusing to delete controlled root ${root}`);
  }
  rmLinkAware(target);
}

function rmLinkAware(path: string): void {
  if (!lexists(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.isFile()) {
    unlinkSync(path);
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      rmLinkAware(join(path, name));
    }
    rmdirSync(path);
  }
}
