import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HomeDashboard, HomeAuthorizer, HomeReader } from '../../../core/domain/dashboard/home-backend.js';
import { DashboardFault, publicError } from '../../../core/domain/dashboard/errors.js';
import { canonicalJson, parseBoardMutation, parseQuery } from '../../../core/domain/dashboard/validation.js';
import { HomeDashboardInternalHttp, readDashboardBody } from './internal-http.js';

/** Supplied by the existing authenticated Supervisor entry, never by request DTOs. */
export interface HomeDashboardGatewayOptions {
  origin(): string;
  /** Current owned manager origin only. Ordinary space origins are never admitted. */
  managerOrigin?(): string | null;
  authorize(req: IncomingMessage): HomeReader | null;
}

// Origin permission is independent of service readiness: an admitted browser
// must be able to read a real unavailable response, without gaining authority.
function checkOrigin(req: IncomingMessage, options: HomeDashboardGatewayOptions, preflight = false): string {
  const origin = new URL(options.origin());
  for (const name of ['host', 'origin', ...(preflight ? [] : ['x-dsh-dashboard'])]) {
    if (req.rawHeaders.filter((_, i) => i % 2 === 0).filter(h => h.toLowerCase() === name).length !== 1) throw new DashboardFault('dashboard/forbidden');
  }
  const incoming = req.headers.origin, manager = options.managerOrigin?.();
  const allowedManager = manager && /^http:\/\/127\.0\.0\.1:\d+$/.test(manager) ? manager : null;
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || req.headers.host !== origin.host ||
      typeof incoming !== 'string' || (incoming !== origin.origin && incoming !== allowedManager) ||
      (!preflight && req.headers['x-dsh-dashboard'] !== '1')) throw new DashboardFault('dashboard/forbidden');
  return incoming;
}
function cors(req: IncomingMessage, options: HomeDashboardGatewayOptions): Record<string, string> {
  try {
    const incoming = checkOrigin(req, options, req.method === 'OPTIONS');
    return incoming === options.origin() ? {} : { 'Access-Control-Allow-Origin': incoming, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' };
  } catch { return {}; }
}
function preflight(req: IncomingMessage, res: ServerResponse, options: HomeDashboardGatewayOptions): boolean {
  if (req.method !== 'OPTIONS') return false;
  checkOrigin(req, options, true);
  const headers = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(h => h.trim()).sort();
  if (!['/api/dashboard/v1/query', '/api/dashboard/v1/commands'].includes(req.url ?? '') ||
      req.headers['access-control-request-method'] !== 'POST' || headers.join(',') !== 'content-type,x-dsh-dashboard') throw new DashboardFault('dashboard/forbidden');
  res.writeHead(204, { ...cors(req, options), 'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, X-DSH-Dashboard', 'Access-Control-Max-Age': '0' });
  res.end(); return true;
}

/** No backing service exists. Check the same browser boundary before reporting it. */
export function handleDashboardUnavailable(req: IncomingMessage, res: ServerResponse, options: HomeDashboardGatewayOptions): boolean {
  const internal = req.url?.startsWith('/internal/dashboard/');
  if (!internal && !req.url?.startsWith('/api/dashboard/')) return false;
  let fault = new DashboardFault('dashboard/unavailable');
  try {
    if (internal) {
      // No live service means no issued bearer can remain authorized.
      if (req.headers.origin !== undefined || req.headers.cookie !== undefined || req.headers['sec-fetch-site'] !== undefined ||
          req.headers.host !== new URL(options.origin()).host) throw new DashboardFault('dashboard/forbidden');
      throw new DashboardFault('dashboard/unauthenticated');
    }
    if (preflight(req, res, options)) return true;
    checkOrigin(req, options);
    if (!options.authorize(req)) throw new DashboardFault('dashboard/unauthenticated');
  } catch (error) { fault = error instanceof DashboardFault ? error : new DashboardFault('dashboard/unavailable'); }
  const status = fault.code === 'dashboard/forbidden' ? 403 : fault.code === 'dashboard/unauthenticated' ? 401 : 503;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    Connection: 'close', ...(!internal ? cors(req, options) : {}) });
  res.end(canonicalJson({ protocolVersion: 1, error: publicError(fault) })); return true;
}
/** Route adapter only. The owning host must call handle on its existing listener. */
export class HomeDashboardGateway {
  readonly publishers: HomeDashboardInternalHttp;
  private active = true;
  private inFlight = 0;
  constructor(private readonly hub: HomeDashboard, private readonly options: HomeDashboardGatewayOptions) {
    this.publishers = new HomeDashboardInternalHttp(hub, options.origin);
  }
  private checkOrigin(req: IncomingMessage, preflight = false): string {
    return checkOrigin(req, this.options, preflight);
  }
  private cors(req: IncomingMessage): Record<string, string> {
    return cors(req, this.options);
  }
  private auth(req: IncomingMessage): HomeReader | null {
    if (!this.active) throw new DashboardFault('dashboard/unavailable');
    this.checkOrigin(req);
    return this.options.authorize(req);
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!this.active) return handleDashboardUnavailable(req, res, this.options);
    if (await this.publishers.handle(req, res)) return true;
    if (!req.url?.startsWith('/api/dashboard/')) return false;
    let admitted = false;
    const send = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      const encoded = canonicalJson(value);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...this.cors(req), ...(status >= 400 ? { Connection: 'close' } : {}) });
      res.end(encoded);
    };
    try {
      if (preflight(req, res, this.options)) return true;
      const reader = this.auth(req); if (!reader) throw new DashboardFault('dashboard/unauthenticated');
      if (this.inFlight >= 32) throw new DashboardFault('dashboard/rate-limited'); this.inFlight++; admitted = true;
      if (req.method !== 'POST' || !['/api/dashboard/v1/query', '/api/dashboard/v1/commands'].includes(req.url)) throw new DashboardFault('dashboard/unsupported-operation');
      if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'] !== undefined) throw new DashboardFault('dashboard/invalid-input');
      const body = await readDashboardBody(req);
      const auth: HomeAuthorizer = () => {
        const current = this.auth(req);
        if (current?.subjectId !== reader.subjectId) throw new DashboardFault('dashboard/unauthenticated');
        if (req.aborted || res.destroyed) throw new DashboardFault('dashboard/unavailable');
        return current;
      };
      // Send inside the Hub critical section, not after another policy mutation
      // can run between constructing a response and writing it to the socket.
      if (req.url.endsWith('/query')) await this.hub.query(parseQuery(body), auth, value => { auth(); send(200, value); });
      else await this.hub.mutate(parseBoardMutation(body), auth, value => { auth(); send(200, value); });
    } catch (error) {
      const fault = publicError(error);
      const status = fault.code.endsWith('/unauthenticated') ? 401 : fault.code.endsWith('/forbidden') ? 403 : fault.code.endsWith('/not-found') ? 404 :
        fault.code.endsWith('/limit-exceeded') ? 413 : fault.code.endsWith('/rate-limited') ? 429 : fault.code.endsWith('/storage-failed') ? 500 :
          fault.code.endsWith('/unavailable') ? 503 : fault.code.endsWith('/unsupported-operation') ? 501 : /stale-|conflict|cursor-invalid/.test(fault.code) ? 409 : 400;
      send(status, { protocolVersion: 1, error: fault });
    } finally { if (admitted) this.inFlight--; }
    return true;
  }
  close(): void { this.active = false; this.publishers.close(); }
}
