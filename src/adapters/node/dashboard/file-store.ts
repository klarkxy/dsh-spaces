import { lstatSync } from "../../../shared/node/filesystem";
import { closeSync, fsyncSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { flushPrivateDirectory, inspectPrivatePathStructure, PrivateFileAccess, PrivateFileError, verifyPrivateIdentity } from '../../../shared/node/private-files.js';
import type { HomeDashboardStore, HomePolicyBook } from '../../../core/domain/dashboard/home-backend.js';
import { parseHomePolicyBook, parseHomeProjection } from '../../../core/domain/dashboard/home-backend.js';
import { parseLayoutDocument, type LayoutDocument } from '../../../core/domain/dashboard/boards.js';
import type { Projection } from '../../../core/domain/dashboard/projection.js';
import { DashboardFault } from '../../../core/domain/dashboard/errors.js';
import { canonicalJson, identifier, parseStrictJson } from '../../../core/domain/dashboard/validation.js';

/** Explicit root selected by the owning Supervisor. No browser path or directory discovery. */
export class HomeDashboardFileStore implements HomeDashboardStore {
  private closed = false;
  private closeResult: Promise<void> | null = null;
  private readonly files = new PrivateFileAccess(() => this.guard());
  readonly root: string;
  constructor(root: string, private readonly assertOwner: () => void) {
    if (!isAbsolute(root) || resolve(root) === parse(root).root) throw new DashboardFault('dashboard/invalid-input');
    this.root = resolve(root); this.guard();
    try { inspectPrivatePathStructure(this.root); }
    catch (error) { if (error instanceof PrivateFileError) throw new DashboardFault('dashboard/storage-failed'); throw error; }
  }
  private guard(): void {
    if (this.closed) throw new DashboardFault('dashboard/unavailable');
    this.assertOwner();
  }
  private async boundary<T>(operation: () => Promise<T>): Promise<T> {
    try { const result = await operation(); this.guard(); return result; }
    catch (error) {
      if (error instanceof PrivateFileError) throw new DashboardFault(error.reason === 'limit-exceeded' ? 'dashboard/limit-exceeded' : 'dashboard/storage-failed');
      throw error;
    }
  }
  private async read(name: string, maximum: number): Promise<unknown | null> {
    this.guard();
    return this.boundary(async () => {
      const bytes = await this.files.read(this.root, join(this.root, name), maximum);
      this.guard(); return bytes === null ? null : parseStrictJson(bytes, maximum);
    });
  }
  private async write(name: string, value: unknown, assertCommit: () => void): Promise<void> {
    this.guard();
    return this.boundary(async () => {
      const path = join(this.root, name), temp = join(this.root, `.write-${randomUUID()}.tmp`);
      const created = await this.files.create(this.root, temp, [path]);
      let fd: number | undefined = created.fd, committed = false;
      try {
        this.guard(); assertCommit(); verifyPrivateIdentity(temp, created.identity, fd);
        writeFileSync(fd, canonicalJson(value), 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
        await this.files.inspect(this.root, [path, temp]);
        this.guard(); assertCommit(); verifyPrivateIdentity(this.root, created.directoryIdentity); verifyPrivateIdentity(temp, created.identity);
        renameSync(temp, path); committed = true;
        // Failure after rename is an uncertain/failed commit, never a rollback.
        flushPrivateDirectory(this.root);
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (!committed) { verifyPrivateIdentity(temp, created.identity); unlinkSync(temp); }
      }
    });
  }
  private projectionName(space: string, provider: string): string {
    identifier(space); identifier(provider);
    return `projection-${createHash('sha256').update(JSON.stringify([space, provider])).digest('hex')}.json`;
  }
  async readPolicies() { return this.read('policies.json', 1024 * 1024); }
  async writePolicies(value: HomePolicyBook, assertCommit: () => void = () => {}) { return this.write('policies.json', parseHomePolicyBook(value), assertCommit); }
  async readLayout() { return this.read('layout.json', 32 * 1024 * 1024); }
  async writeLayout(value: LayoutDocument, assertCommit: () => void = () => {}) { return this.write('layout.json', parseLayoutDocument(value), assertCommit); }
  async readProjection(space: string, provider: string) { return this.read(this.projectionName(space, provider), 1024 * 1024 + 4096); }
  async writeProjection(value: Projection, assertCommit: () => void = () => {}) {
    return this.write(this.projectionName(value.spaceId, value.request.providerId), parseHomeProjection(value, value.spaceId, value.request.providerId), assertCommit);
  }
  async deleteProjection(space: string, provider: string, assertCommit: () => void = () => {}) {
    this.guard();
    return this.boundary(async () => {
      const path = join(this.root, this.projectionName(space, provider));
      await this.files.inspect(this.root, [path]); this.guard();
      let identity;
      try { identity = lstatSync(path, { bigint: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      this.guard(); assertCommit(); verifyPrivateIdentity(path, identity); unlinkSync(path);
      flushPrivateDirectory(this.root);
    });
  }
  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.closed = true;
    return this.closeResult = this.files.close();
  }
}
