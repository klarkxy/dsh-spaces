import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HomeDashboard, HomeRunPublisher, OwnedDashboardRun } from '../../../core/domain/dashboard/home-backend.js';
import { DashboardFault, publicError } from '../../../core/domain/dashboard/errors.js';
import { canonicalJson, parseStrictJson } from '../../../core/domain/dashboard/validation.js';

export const INTERNAL_PREFIX = '/internal/dashboard/v1/';
export interface DashboardBootstrap { protocolVersion: 1; origin: string; runId: string; bearer: string }
interface Entry { digest: Buffer; run: HomeRunPublisher }
/** Only registered on the existing Supervisor HTTP listener. No new manager or listener. */
export class HomeDashboardInternalHttp {
  private readonly entries = new Map<string, Entry>();
  private active = true;
  private inFlight = 0;
  constructor(private readonly hub: HomeDashboard, private readonly origin: () => string) {}
  async issue(binding: OwnedDashboardRun): Promise<{ bootstrap: DashboardBootstrap; dispose(): void }> {
    if (!this.active || this.entries.size >= 1000) throw new DashboardFault('dashboard/unavailable');
    if (this.entries.has(binding.runId)) throw new DashboardFault('dashboard/request-conflict');
    const run = await this.hub.beginRun(binding);
    if (!this.active) { run.close(); throw new DashboardFault('dashboard/unavailable'); }
    const bearer = randomBytes(32).toString('hex'), digest = createHash('sha256').update(bearer).digest();
    this.entries.set(binding.runId, { digest, run });
    return { bootstrap: { protocolVersion: 1, origin: this.origin(), runId: binding.runId, bearer }, dispose: () => { run.close(); this.entries.delete(binding.runId); } };
  }
  private authenticate(req: IncomingMessage): Entry {
    if (!this.active) throw new DashboardFault('dashboard/unavailable');
    const origin = new URL(this.origin());
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || req.headers.host !== origin.host ||
        req.headers.origin !== undefined || req.headers.cookie !== undefined || req.headers['sec-fetch-site'] !== undefined) throw new DashboardFault('dashboard/forbidden');
    // Count raw security headers: comma normalization must not create a second credential path.
    for (const header of ['host', 'authorization']) if (req.rawHeaders.filter((_, i) => i % 2 === 0).filter(h => h.toLowerCase() === header).length !== 1) throw new DashboardFault('dashboard/unauthenticated');
    const auth = req.headers.authorization;
    if (!auth || !/^Bearer [a-f0-9]{64}$/.test(auth)) throw new DashboardFault('dashboard/unauthenticated');
    const digest = createHash('sha256').update(auth.slice(7)).digest();
    let matched: Entry | undefined;
    for (const entry of this.entries.values()) if (timingSafeEqual(digest, entry.digest)) matched = entry;
    if (!matched) throw new DashboardFault('dashboard/unauthenticated');
    return matched;
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!req.url?.startsWith(INTERNAL_PREFIX)) return false;
    let admitted = false;
    const send = (status: number, data: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status >= 400 ? { Connection: 'close' } : {}) });
      res.end(canonicalJson(data));
    };
    try {
      const entry = this.authenticate(req);
      if (this.inFlight >= 32) throw new DashboardFault('dashboard/rate-limited');
      this.inFlight++; admitted = true;
      let result: unknown;
      if (req.method === 'GET' && req.url === INTERNAL_PREFIX + 'grant') {
        if (req.headers['transfer-encoding'] || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) throw new DashboardFault('dashboard/invalid-input');
        result = await entry.run.grant();
      } else if (req.method === 'POST' && [INTERNAL_PREFIX + 'publish', INTERNAL_PREFIX + 'heartbeat'].includes(req.url)) {
        if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) throw new DashboardFault('dashboard/invalid-input');
        const body = await readDashboardBody(req);
        if (this.authenticate(req) !== entry || req.aborted || res.destroyed) throw new DashboardFault('dashboard/unauthenticated');
        result = req.url.endsWith('/publish') ? await entry.run.publish(body) : await entry.run.heartbeat(body);
      } else throw new DashboardFault('dashboard/unsupported-operation');
      if (this.authenticate(req) !== entry) throw new DashboardFault('dashboard/unauthenticated');
      send(200, result);
    } catch (error) {
      const fault = publicError(error);
      const status = fault.code.endsWith('/unauthenticated') ? 401 : fault.code.endsWith('/forbidden') ? 403 : fault.code.endsWith('/limit-exceeded') ? 413 :
        fault.code.endsWith('/rate-limited') ? 429 : fault.code.endsWith('/storage-failed') ? 500 : fault.code.endsWith('/unavailable') ? 503 :
          fault.code.endsWith('/unsupported-operation') ? 501 : /stale-|conflict/.test(fault.code) ? 409 : 400;
      send(status, { protocolVersion: 1, error: fault });
    } finally { if (admitted) this.inFlight--; }
    return true;
  }
  close(): void { this.active = false; for (const entry of this.entries.values()) entry.run.close(); this.entries.clear(); }
}
export async function readDashboardBody(req: IncomingMessage): Promise<unknown> {
  const maximum = 1024 * 1024;
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > maximum)) throw new DashboardFault('dashboard/limit-exceeded');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let length = 0, done = false;
    const finish = (error?: unknown) => {
      if (done) return; done = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('aborted', fail); req.off('error', fail);
      if (error) { req.pause(); reject(error); }
      else { try { resolve(parseStrictJson(Buffer.concat(chunks, length), maximum)); } catch (error) { reject(error); } }
    };
    const data = (chunk: Buffer) => { length += chunk.length; if (length > maximum) finish(new DashboardFault('dashboard/limit-exceeded')); else chunks.push(chunk); };
    const end = () => finish(), fail = () => finish(new DashboardFault('dashboard/unavailable'));
    const timer = setTimeout(fail, 5000);
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', fail);
  });
}
