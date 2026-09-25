import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { HomeDashboardStore, HomePolicyBook } from '../../../core/domain/dashboard/home-backend.js';
import { parseHomePolicyBook, parseHomeProjection } from '../../../core/domain/dashboard/home-backend.js';
import { parseLayoutDocument, type LayoutDocument } from '../../../core/domain/dashboard/boards.js';
import type { Projection } from '../../../core/domain/dashboard/projection.js';
import { DashboardFault } from '../../../core/domain/dashboard/errors.js';
import { canonicalJson, identifier, parseStrictJson } from '../../../core/domain/dashboard/validation.js';

/** Explicit root selected by the owning Supervisor. No browser path or directory discovery. */
export class HomeDashboardFileStore implements HomeDashboardStore {
  private closed = false;
  readonly root: string;
  constructor(root: string, private readonly assertOwner: () => void) {
    if (!isAbsolute(root) || resolve(root) === parse(root).root) throw new DashboardFault('dashboard/invalid-input');
    // chmod cannot prove Windows ACL. Enable that platform only after its separate ACL adapter is tested.
    if (process.platform === 'win32') throw new DashboardFault('dashboard/unsupported-operation');
    this.root = resolve(root); this.guard();
  }
  private guard(): void {
    if (this.closed) throw new DashboardFault('dashboard/unavailable');
    this.assertOwner();
    // Check existing ancestors without creating or repairing anything.
    let path = this.root;
    for (;;) {
      try { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new DashboardFault('dashboard/storage-failed'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = dirname(path); if (parent === path) break; path = parent;
    }
    try {
      const s = lstatSync(this.root);
      if (s.uid !== process.getuid!() || (s.mode & 0o077) !== 0) throw new DashboardFault('dashboard/storage-failed');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private verifyFile(path: string): void {
    try {
      const s = lstatSync(path);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid!() || (s.mode & 0o077) !== 0) throw new DashboardFault('dashboard/storage-failed');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private read(name: string, maximum: number): unknown | null {
    this.guard(); const path = join(this.root, name); this.verifyFile(path);
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid!() || (s.mode & 0o077) !== 0 || s.size > maximum) throw new DashboardFault('dashboard/storage-failed');
      const chunks: Buffer[] = []; let length = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - length));
        const count = readSync(fd, chunk); if (!count) break;
        length += count; if (length > maximum) throw new DashboardFault('dashboard/limit-exceeded');
        chunks.push(chunk.subarray(0, count));
      }
      this.guard(); return parseStrictJson(Buffer.concat(chunks, length), maximum);
    } finally { closeSync(fd); }
  }
  private write(name: string, value: unknown): void {
    this.guard(); mkdirSync(this.root, { recursive: true, mode: 0o700 }); this.guard();
    const path = join(this.root, name); this.verifyFile(path);
    const temp = join(this.root, `.write-${randomUUID()}.tmp`);
    let fd: number | undefined, created = false, committed = false;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
      writeFileSync(fd, canonicalJson(value), 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      this.guard(); this.verifyFile(path); renameSync(temp, path); committed = true;
      // Failure after rename is an uncertain/failed commit, never a rollback.
      const dir = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (created && !committed) unlinkSync(temp); // Only this call's unpublished temporary file.
    }
  }
  private projectionName(space: string, provider: string): string {
    identifier(space); identifier(provider);
    return `projection-${createHash('sha256').update(JSON.stringify([space, provider])).digest('hex')}.json`;
  }
  async readPolicies() { return this.read('policies.json', 1024 * 1024); }
  async writePolicies(value: HomePolicyBook) { this.write('policies.json', parseHomePolicyBook(value)); }
  async readLayout() { return this.read('layout.json', 32 * 1024 * 1024); }
  async writeLayout(value: LayoutDocument) { this.write('layout.json', parseLayoutDocument(value)); }
  async readProjection(space: string, provider: string) { return this.read(this.projectionName(space, provider), 1024 * 1024 + 4096); }
  async writeProjection(value: Projection) {
    this.write(this.projectionName(value.spaceId, value.request.providerId), parseHomeProjection(value, value.spaceId, value.request.providerId));
  }
  async deleteProjection(space: string, provider: string) {
    this.guard(); const path = join(this.root, this.projectionName(space, provider)); this.verifyFile(path);
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const dir = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  async close() { this.closed = true; }
}
