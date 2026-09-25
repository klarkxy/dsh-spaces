import type { Limits } from '../../../shared/dashboard.js';

export const DASHBOARD_LIMITS: Readonly<Limits> = Object.freeze({
  maxRequestBytes: 1024 * 1024,
  maxProvidersPerSpace: 32,
  maxLayoutBytes: 32 * 1024 * 1024,
  maxReceipts: 10_000,
  maxBoardIds: 10_000,
  maxTypesPerProvider: 32,
  maxInstancesPerProvider: 100,
  maxContentBytes: 32 * 1024,
  maxPublishBytes: 1024 * 1024,
  maxQueryRefs: 50,
  maxHomeInstances: 5_000,
  maxHomeProjectionBytes: 64 * 1024 * 1024,
  maxBoards: 20,
  maxPlacementsPerBoard: 200,
  maxCatalogPageSize: 100,
});
export const REQUEST_WINDOW_MS = 5 * 60_000;
export const RECEIPT_RETENTION_MS = 24 * 60 * 60_000;
export const CHANNEL_STALE_MS = 45_000;
export const MAX_JSON_DEPTH = 64;
