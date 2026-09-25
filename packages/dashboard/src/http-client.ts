import type { BoardMutation, BoardMutationReceipt, DashboardQuery, DashboardQueryResponse } from '../../../src/shared/dashboard.js';
import { DashboardFault } from '../../../src/core/domain/dashboard/errors.js';
import { canonicalJson, object, parseBoardMutation, parseQuery, parseStrictJson } from '../../../src/core/domain/dashboard/validation.js';
import type { DashboardReadBackend } from './model.js';
const CODES = new Set(['invalid-input','unauthenticated','forbidden','not-found','stale-epoch','stale-run','stale-grant','stale-sequence','sequence-conflict','revision-conflict','request-conflict','request-expired','cursor-invalid','limit-exceeded','rate-limited','unsupported-version','unsupported-operation','unavailable','storage-failed'].map(code => `dashboard/${code}`));
export function createDashboardHttpBackend(origin: string, request: typeof fetch = fetch, transport: 'same-origin' | 'owned-manager' = 'same-origin'): DashboardReadBackend {
  const base = new URL(origin);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new DashboardFault('dashboard/forbidden');
  async function call(path: string, body: unknown, caller?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    caller?.addEventListener('abort', cancel, { once: true });
    if (caller?.aborted) controller.abort();
    const timeout = setTimeout(cancel, 5000);
    try {
      const response = await request(new URL(path, base), {
        method: 'POST', credentials: transport === 'owned-manager' ? 'include' : 'same-origin', mode: transport === 'owned-manager' ? 'cors' : 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-DSH-Dashboard': '1' }, body: canonicalJson(body), signal: controller.signal,
      });
      if (response.status === 401) throw new DashboardFault('dashboard/unauthenticated');
      if (response.status === 403) throw new DashboardFault('dashboard/forbidden');
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new DashboardFault('dashboard/invalid-input');
      const reader = response.body?.getReader();
      if (!reader) throw new DashboardFault('dashboard/invalid-input');
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new DashboardFault('dashboard/limit-exceeded'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = parseStrictJson(bytes, 8 * 1024 * 1024);
      if (!response.ok) {
        const envelope = object(value, ['protocolVersion', 'error']);
        const error = object(envelope.error, ['code', 'message'], ['requestId', 'details']);
        if (envelope.protocolVersion !== 1 || typeof error.code !== 'string' || !CODES.has(error.code)) throw new DashboardFault('dashboard/invalid-input');
        // Do not forward upstream raw messages/details into the UI.
        throw new DashboardFault(error.code as ConstructorParameters<typeof DashboardFault>[0]);
      }
      if (controller.signal.aborted) throw new DashboardFault('dashboard/unavailable');
      return value;
    } catch (error) {
      throw error instanceof DashboardFault ? error : new DashboardFault('dashboard/unavailable');
    } finally { clearTimeout(timeout); caller?.removeEventListener('abort', cancel); }
  }
  return {
    query: (input: DashboardQuery, signal?: AbortSignal) => call('/api/dashboard/v1/query', parseQuery(input), signal) as Promise<DashboardQueryResponse>,
    mutate: (input: BoardMutation) => call('/api/dashboard/v1/commands', parseBoardMutation(input)) as Promise<BoardMutationReceipt>,
  };
}
