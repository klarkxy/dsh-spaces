import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DashboardBootstrap } from './internal-http.js';
import { DashboardFault } from '../../../core/domain/dashboard/errors.js';
import { canonicalJson } from '../../../core/domain/dashboard/validation.js';

/** One normal launch's private handoff. The returned path is Node-only, never a DTO. */
export function writeDashboardBootstrap(directory: string, value: DashboardBootstrap, assertOwner: () => void): { path: string; dispose(): void } {
  if (process.platform === 'win32') throw new DashboardFault('dashboard/unsupported-operation');
  if (!isAbsolute(directory)) throw new DashboardFault('dashboard/invalid-input');
  assertOwner(); let ancestor = resolve(directory);
  for (;;) {
    try { const stat = lstatSync(ancestor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DashboardFault('dashboard/forbidden'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(ancestor); if (ancestor === parent) break; ancestor = parent;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  if (dir.uid !== process.getuid!() || (dir.mode & 0o077) !== 0 || dir.isSymbolicLink()) throw new DashboardFault('dashboard/forbidden');
  const path = join(directory, `${randomUUID()}.json`);
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const identity = fstatSync(fd); let successful = false;
  try { writeFileSync(fd, canonicalJson(value)); fsyncSync(fd); successful = true; }
  finally { closeSync(fd); if (!successful) unlinkSync(path); }
  let disposed = false;
  return { path, dispose() {
    if (disposed) return; assertOwner();
    const stat = lstatSync(path);
    if (stat.ino !== identity.ino || stat.dev !== identity.dev || !stat.isFile() || stat.isSymbolicLink()) throw new DashboardFault('dashboard/forbidden');
    unlinkSync(path); disposed = true;
  } };
}
