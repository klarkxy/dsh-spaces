import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DashboardBackend } from '../../../../src/shared/dashboard.js';
import { DashboardFault, publicError } from '../../../../src/core/domain/dashboard/errors.js';
import { DASHBOARD_LIMITS } from '../../../../src/core/domain/dashboard/limits.js';
import { canonicalJson, parseBoardMutation, parseQuery, parseStrictJson } from '../../../../src/core/domain/dashboard/validation.js';

export const QUERY_PATH = '/api/dashboard/v1/query';
export const COMMAND_PATH = '/api/dashboard/v1/commands';
export interface DashboardHttpPorts {
  port(): number;
  /** The real native Connection authentication check, repeated for every request. */
  rejection(req: IncomingMessage): 401 | 403 | undefined;
  backend(req: IncomingMessage): DashboardBackend;
  active(): boolean;
}
const statusOf = (code: string): number => {
  if (code === 'dashboard/unauthenticated') return 401;
  if (code === 'dashboard/forbidden') return 403;
  if (code === 'dashboard/not-found') return 404;
  if (code === 'dashboard/limit-exceeded') return 413;
  if (code === 'dashboard/rate-limited') return 429;
  if (code === 'dashboard/storage-failed') return 500;
  if (code === 'dashboard/unavailable') return 503;
  if (code.startsWith('dashboard/unsupported-')) return 501;
  return /(?:conflict|stale-|cursor-invalid)/.test(code) ? 409 : 400;
};
function one(req: IncomingMessage, name: string): string | undefined {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  const value = req.headers[name];
  if (count !== 1 || typeof value !== 'string') return undefined;
  return value;
}
export function authorizeDashboardRequest(req: IncomingMessage, ports: DashboardHttpPorts): void {
  if (!ports.active()) throw new DashboardFault('dashboard/unavailable');
  const host = one(req, 'host');
  const permitted = [`127.0.0.1:${ports.port()}`, `localhost:${ports.port()}`];
  if (!host || !permitted.includes(host) || one(req, 'origin') !== `http://${host}` || one(req, 'x-dsh-dashboard') !== '1') {
    throw new DashboardFault('dashboard/forbidden');
  }
  const rejection = ports.rejection(req);
  if (rejection) throw new DashboardFault(rejection === 401 ? 'dashboard/unauthenticated' : 'dashboard/forbidden');
}
function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > DASHBOARD_LIMITS.maxRequestBytes)) {
    return Promise.reject(new DashboardFault('dashboard/limit-exceeded'));
  }
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted);
      if (error) { chunks.length = 0; req.pause(); reject(error); }
      else resolve(Buffer.concat(chunks, size));
    };
    const data = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > DASHBOARD_LIMITS.maxRequestBytes) finish(new DashboardFault('dashboard/limit-exceeded'));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const failed = () => finish(new DashboardFault('dashboard/invalid-input'));
    const aborted = () => finish(new DashboardFault('dashboard/unavailable'));
    const timer = setTimeout(() => finish(new DashboardFault('dashboard/unavailable')), 5000);
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', aborted);
  });
}
function send(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status >= 400 ? { Connection: 'close' } : {}) });
  res.end(canonicalJson(value));
}
/** Exact routes on the existing native web server; never creates another listener. */
export function dashboardHttpHandler(path: typeof QUERY_PATH | typeof COMMAND_PATH, ports: DashboardHttpPorts) {
  let inFlight = 0;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let admitted = false;
    try {
      authorizeDashboardRequest(req, ports);
      if (req.method !== 'POST' || req.url !== path) throw new DashboardFault('dashboard/unsupported-operation');
      if (one(req, 'content-type')?.toLowerCase() !== 'application/json' || req.headers['content-encoding'] !== undefined) throw new DashboardFault('dashboard/invalid-input');
      if (inFlight >= 16) throw new DashboardFault('dashboard/rate-limited');
      inFlight++; admitted = true;
      const body = parseStrictJson(await readBody(req));
      authorizeDashboardRequest(req, ports);
      if (req.aborted || res.destroyed) throw new DashboardFault('dashboard/unavailable');
      const backend = ports.backend(req);
      const result = path === QUERY_PATH ? await backend.query(parseQuery(body)) : await backend.mutate(parseBoardMutation(body));
      // Native logout/shutdown during asynchronous work cannot release cached content.
      authorizeDashboardRequest(req, ports);
      send(res, 200, result);
    } catch (error) {
      const fault = publicError(error);
      send(res, statusOf(fault.code), { protocolVersion: 1, error: fault });
    } finally { if (admitted) inFlight--; }
  };
