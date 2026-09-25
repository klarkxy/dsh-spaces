import { z } from 'zod';
import { emptyLayout } from '../../../../src/core/domain/dashboard/boards.js';
import { DashboardFault } from '../../../../src/core/domain/dashboard/errors.js';
import { parseLocalDashboardDocument, type LocalDashboardDocument, type LocalDashboardStore } from '../../../../src/core/domain/dashboard/local-backend.js';
import { copyJson } from '../../../../src/core/domain/dashboard/validation.js';

// Official storage unit names accept lowercase letters, digits and underscores.
// This is a private storage identifier, not the package or wire protocol name.
export const DASHBOARD_DOMAIN_NAME = 'dsh_dashboard_local';

/** The owning Host must already hold its profile's single-writer rights. */
export function dashboardDomainSpec() {
  return {
    name: DASHBOARD_DOMAIN_NAME,
    version: 1,
    layout: 'single' as const,
    tables: {},
    global: {
      // Null is the official medium's never-written sentinel, not a valid record.
      schema: z.custom<LocalDashboardDocument>((value) => {
        try { parseLocalDashboardDocument(value); return true; }
        catch { return false; }
      }, 'Invalid dashboard document'),
      // An explicit new-domain value. The official domain facility does not write
      // this value on open; corrupt or foreign records still reject the open.
      initial: { schemaVersion: 1 as const, layout: emptyLayout(), providers: [] },
    },
  };
}

/** Structural seam verified against the installed official storage-domain API.
 * No bundled copy of Cordis, Storage, or a filesystem backend is introduced.
 */
export interface DashboardDomainHandle {
  global: { get(): unknown; set(value: LocalDashboardDocument): Promise<void> };
  close(): Promise<void>;
}
export interface DashboardDomainFacility {
  open(spec: ReturnType<typeof dashboardDomainSpec>): Promise<DashboardDomainHandle>;
}

export async function openDashboardDomainStore(facility: DashboardDomainFacility): Promise<LocalDashboardStore> {
  const domain = await facility.open(dashboardDomainSpec());
  let closed = false;
  let failed = false;
  let closing: Promise<void> | null = null;
  const assertOpen = () => {
    if (closed) throw new DashboardFault('dashboard/unavailable');
    if (failed) throw new DashboardFault('dashboard/storage-failed');
  };
  return {
    async read() {
      assertOpen();
      try { return parseLocalDashboardDocument(copyJson(domain.global.get())); }
      catch { failed = true; throw new DashboardFault('dashboard/storage-failed'); }
    },
    async write(value) {
      assertOpen();
      const validated = parseLocalDashboardDocument(value);
      try {
        // The whole layout, receipt ledger and local projections share one
        // official durable write. Never acknowledge a write-behind cache.
        await domain.global.set(copyJson(validated));
      } catch { failed = true; throw new DashboardFault('dashboard/storage-failed'); }
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = domain.close();
      return closing;
    },
  };
}
