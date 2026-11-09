import {
  constants, lstatSync as nodeLstatSync, readdirSync, readlinkSync as nodeReadlinkSync, rmdirSync, unlinkSync,
  realpathSync as nodeRealpathSync, symlinkSync, type BigIntStats, type Stats,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

// Windows' native resolver follows reparse points (including Global DOS-device
// junctions) which lstat and the JS realpath walker can treat as directories.
export const realpathSync = process.platform === "win32" ? nodeRealpathSync.native : nodeRealpathSync;

function directoryAlias(path: string): string | undefined {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent === absolute) return undefined;
  try {
    const target = realpathSync(absolute);
    const entry = join(realpathSync(parent), basename(absolute));
    return target.toLowerCase() === entry.toLowerCase() ? undefined : target;
  } catch (cause) {
    // lstat already proved the entry exists. In particular a dangling reparse
    // point must not become ENOENT and authorize creation through that entry.
    throw new Error("Existing directory could not be resolved safely.", { cause });
  }
}

export function lstatSync(path: string): Stats;
export function lstatSync(path: string, options: { bigint: true }): BigIntStats;
export function lstatSync(path: string, options?: { bigint: true }): Stats | BigIntStats {
  let stat: Stats | BigIntStats;
  try { stat = options ? nodeLstatSync(path, options) : nodeLstatSync(path); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      assertMissingEntry(path, error);
    }
    throw error;
  }
  if (process.platform === "win32" && stat.isDirectory() && !stat.isSymbolicLink() && directoryAlias(path)) {
    // Keep the OS identity fields, including dev/ino used by private-file
    // checks, and correct only the file type used by Stats' predicates.
    stat.mode = typeof stat.mode === "bigint"
      ? (stat.mode & ~BigInt(constants.S_IFMT)) | BigInt(constants.S_IFLNK)
      : (stat.mode & ~constants.S_IFMT) | constants.S_IFLNK;
  }
  return stat;
}

function assertMissingEntry(path: string, cause: unknown): void {
  // lstat can also report ENOENT for an unrecognised dangling junction.
  // Check the nearest enumerable parent before classifying the path as absent.
  for (let entry = resolve(path); dirname(entry) !== entry; entry = dirname(entry)) {
    let names: string[];
    try { names = readdirSync(dirname(entry)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (names.some(name => name.toLowerCase() === basename(entry).toLowerCase())) {
      throw new Error("Existing path could not be inspected safely.", { cause });
    }
    return;
  }
}

export function readlinkSync(path: string): string {
  const stat = nodeLstatSync(path);
  if (process.platform === "win32" && stat.isDirectory() && !stat.isSymbolicLink()) {
    const target = directoryAlias(path);
    if (target) return target;
  }
  return nodeReadlinkSync(path);
}

/** Remove directory entries without traversing directory aliases or linked package sources. */
export function removeTreeNoFollow(path: string): void {
  let stat: Stats;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    // A Windows directory alias that native lstat reports as a directory needs
    // the non-recursive directory-entry removal API, never a recursive walk.
    if (process.platform === "win32" && nodeLstatSync(path).isDirectory()) rmdirSync(path);
    else unlinkSync(path);
    return;
  }
  // Use our native-identity-aware lstat at every level. A generic recursive rm
  // may use the runtime's uncorrected directory classification for junctions.
  for (const name of readdirSync(path)) removeTreeNoFollow(join(path, name));
  rmdirSync(path);
}

/** Create an internal directory link, including a not-yet-published target. */
export function createDirectoryLink(target: string, path: string): void {
  symlinkSync(process.platform === "win32" ? resolve(target) : relative(dirname(path), target) || ".",
    path, process.platform === "win32" ? "junction" : "dir");
}
