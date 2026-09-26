import { closeSync, fsyncSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { createPrivateFile, flushPrivateDirectory, inspectPrivatePaths, PrivateFileError, verifyPrivateIdentity } from '../../../shared/node/private-files.js';
import type { DashboardBootstrap } from './internal-http.js';
import { DashboardFault } from '../../../core/domain/dashboard/errors.js';
import { canonicalJson } from '../../../core/domain/dashboard/validation.js';

/** One normal launch's private handoff. The returned path is Node-only, never a DTO. */
export function writeDashboardBootstrap(directory: string, value: DashboardBootstrap, assertOwner: () => void): { path: string; dispose(): void } {
  if (!isAbsolute(directory)) throw new DashboardFault('dashboard/invalid-input');
  directory = resolve(directory);
  const boundary = <T>(operation: () => T): T => {
    try { return operation(); }
    catch (error) { if (error instanceof PrivateFileError) throw new DashboardFault('dashboard/forbidden'); throw error; }
  };
  return boundary(() => {
    assertOwner();
    const path = join(directory, `${randomUUID()}.json`);
    const { fd, identity, directoryIdentity } = createPrivateFile(directory, path);
    let successful = false;
    try {
      assertOwner(); verifyPrivateIdentity(path, identity, fd); verifyPrivateIdentity(directory, directoryIdentity);
      writeFileSync(fd, canonicalJson(value)); fsyncSync(fd); flushPrivateDirectory(directory); successful = true;
    } finally {
      closeSync(fd);
      if (!successful) { verifyPrivateIdentity(path, identity); unlinkSync(path); }
    }
    let disposed = false;
    return { path, dispose() {
      if (disposed) return;
      boundary(() => {
        assertOwner(); inspectPrivatePaths(directory, [path]);
        assertOwner(); verifyPrivateIdentity(directory, directoryIdentity); verifyPrivateIdentity(path, identity);
        unlinkSync(path); disposed = true; flushPrivateDirectory(directory);
      });
    } };
  });
}
