import { randomUUID } from 'node:crypto';
import { Context, Service } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderHandle, ProviderRegistration } from '../../../src/shared/dashboard.js';
import { LocalDashboard } from '../../../src/core/domain/dashboard/local-backend.js';
import { DashboardFault } from '../../../src/core/domain/dashboard/errors.js';
import { identifier, object } from '../../../src/core/domain/dashboard/validation.js';
import { openDashboardDomainStore, type DashboardDomainFacility } from './host/domain-store.js';
import { authorizeDashboardRequest, dashboardHttpHandler, QUERY_PATH, COMMAND_PATH, type DashboardHttpPorts } from './host/http.js';

import { DASHBOARD_BOOTSTRAP_ENV, DashboardHomePublisher } from './host/home-publisher.js';

export const name = 'dsh-dashboard';
export const inject = ['storageDomain', 'connection', 'webServer'];
interface NativeWebServer {
  readonly host: string;
  readonly port: number;
  register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void;
}
interface NativeConnection { requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined }

/** Initial standalone installation requires an explicit named native profile.
 * Identity comes from the launcher, not config, query, URL or provider payload.
 * Root web is never given a new storage record by this plugin.
 */
export function namedProfile(argv: readonly string[]): string {
  const names: string[] = [];
  for (let index = 2; index < argv.length; index++) {
    if (argv[index] === '--profile') names.push(argv[++index] ?? '');
    else if (argv[index].startsWith('--profile=')) names.push(argv[index].slice('--profile='.length));
  }
  if (names.length !== 1 || names[0] === 'web' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(names[0])) {
    throw new DashboardFault('dashboard/unsupported-operation');
  }
  return names[0];
}

/** No Typert/Remote annotations: only business plugins inside this Host can register. */
export class DashboardProvider extends Service {
  private readonly handles = new Set<ProviderHandle>();
  private closing = false;
  constructor(ctx: Context, private readonly dashboard: LocalDashboard) { super(ctx, 'dashboardProvider'); }
  register(registration: ProviderRegistration): ProviderHandle {
    if (this.closing) throw new DashboardFault('dashboard/unavailable');
    const caller = this.ctx;
    const providerId = identifier(caller.fiber.name, 'providerId');
    if (!providerId || providerId === name) throw new DashboardFault('dashboard/forbidden');
    const handle = this.dashboard.bindProvider(providerId).register(registration);
    this.handles.add(handle);
    caller.effect(() => () => handle.dispose());
    return handle;
  }
  async closeProviders(): Promise<void> {
    this.closing = true;
    const settled = await Promise.allSettled([...this.handles].map(handle => handle.dispose()));
    this.handles.clear();
    const rejected = settled.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }
}
declare module '@deepseek-ai/cordis' { interface Context { dashboardProvider: DashboardProvider } }

export async function apply(ctx: Context, config: unknown = {}): Promise<void> {
  object(config, [], []);
  const spaceId = namedProfile(process.argv);
  const server = ctx.get('webServer') as unknown as NativeWebServer;
  const connection = ctx.get('connection') as unknown as NativeConnection;
  const domain = ctx.get('storageDomain') as unknown as DashboardDomainFacility;
  if (server?.host !== '127.0.0.1' || typeof server.register !== 'function' || typeof connection?.requestRejection !== 'function' || typeof domain?.open !== 'function') {
    throw new DashboardFault('dashboard/unsupported-operation');
  }
  const bootstrapPath = process.env[DASHBOARD_BOOTSTRAP_ENV];
  const home = bootstrapPath === undefined ? null : await DashboardHomePublisher.open(bootstrapPath);
  let store;
  try { store = await openDashboardDomainStore(domain); } catch (error) { home?.close(); throw error; }
  const dashboard = new LocalDashboard({ spaceId, title: spaceId, backendEpoch: randomUUID(), newId: randomUUID, now: Date.now, store, ...(home ? { homePublisherFor: (id: string) => home.forProvider(id) } : {}) });
  let active = true;
  let provider: DashboardProvider | null = null;
  const routes: Array<() => void> = [];
  let cleanup: Promise<void> | null = null;
  const close = (): Promise<void> => cleanup ??= (async () => {
    active = false;
    for (const dispose of routes.splice(0)) dispose();
    let failed: unknown;
    try { await provider?.closeProviders(); } catch (error) { failed = error; }
    home?.close();
    try { await dashboard.close(); } catch (error) { failed ??= error; }
    if (failed) throw failed;
  })();
  try {
    ctx.effect(() => close);
    provider = new DashboardProvider(ctx, dashboard);
    const ports: DashboardHttpPorts = {
      port: () => server.port, active: () => active,
      rejection: request => connection.requestRejection(request),
      backend: request => dashboard.client(() => {
        authorizeDashboardRequest(request, ports);
        // DSH's local Web carrier admits its single operator. This identifier
        // is not a user supplied field and does not claim a multi-user ACL.
        return { subjectId: 'native-local-operator', layoutWrite: true };
      }),
    };
    for (const path of [QUERY_PATH, COMMAND_PATH] as const) {
      routes.push(server.register({ kind: 'exact', path, handler: dashboardHttpHandler(path, ports) }));
    }
  } catch (error) {
    await close();
    throw error;
  }
}
export default { name, inject, apply };
