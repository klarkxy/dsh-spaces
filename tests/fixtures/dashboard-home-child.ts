/** Test-only independent Node publisher. No frontend, supervisor or user data. */
import { DashboardHomePublisher } from '../../packages/dashboard/src/host/home-publisher.ts';
const path = process.env.DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE;
if (!path) throw new Error('Missing explicit fixture bootstrap');
const home = await DashboardHomePublisher.open(path);
const provider = home.forProvider('provider');
process.send?.({ kind: 'ready' });
process.on('message', async (message: { kind: string; value?: number; id?: string }) => {
  if (message.kind === 'close') { home.close(); process.disconnect(); return; }
  if (message.kind !== 'publish') return;
  const result = await provider.publish({ types: [{ typeId: 'metric', version: 1, title: 'Metric', kind: 'metric' }], instances: [{
    instanceId: 'item', typeId: 'metric', typeVersion: 1, title: 'Published from Node', content: { kind: 'metric', value: message.value ?? 0, unit: '' },
    sourceTarget: { kind: 'space' }, updatedAt: new Date().toISOString(), staleAfterSeconds: 30,
  }] });
  process.send?.({ kind: 'published', id: message.id, result });
});
