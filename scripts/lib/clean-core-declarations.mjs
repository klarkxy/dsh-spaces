import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Declaration emit root. index.js and index.d.ts live beside it and stay. */
export const CORE_DECLARATION_DIR = "packages/core/lib/types";

/**
 * Remove only packages/core/lib/types under repoRoot.
 * Refuses a symlink/junction, a non-directory, or a real path that is not that
 * exact directory. Does not follow a link and does not delete anything else.
 */
export async function removeExactCoreDeclarations(repoRoot) {
  const root = resolve(repoRoot);
  const absolute = resolve(root, CORE_DECLARATION_DIR);
  const lexical = relative(root, absolute);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical) || slash(lexical) !== CORE_DECLARATION_DIR) {
    throw new Error(`refusing to remove ${absolute}: not ${CORE_DECLARATION_DIR}`);
  }
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to remove ${absolute}: it is a symlink or junction`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`refusing to remove ${absolute}: it is not a directory`);
  }
  const real = await realpath(absolute);
  const realRel = relative(root, real);
  if (!realRel || realRel.startsWith("..") || isAbsolute(realRel) || slash(realRel) !== CORE_DECLARATION_DIR) {
    throw new Error(`refusing to remove ${absolute}: real path is ${real}`);
  }
  await rm(real, { recursive: true, force: false });
}

function slash(value) {
  return value.split(sep).join("/");
}
