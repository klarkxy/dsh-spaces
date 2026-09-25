/** Native-process stand-in for Supervisor wiring tests; uses the real publication transport. */
import { createServer } from 'node:http';
import { DashboardHomePublisher } from '../../packages/dashboard/src/host/home-publisher.ts';
const port = Number(process.env.DASHBOARD_TEST_PORT);
const cookie = process.env.DASHBOARD_TEST_COOKIE!;
const bootstrap = process.env.DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE;
const home = bootstrap ? await DashboardHomePublisher.open(bootstrap) : null;
if (home) {
  const result = await home.forProvider('test-provider').publish({
    types: [{ typeId: 'count', version: 1, kind: 'metric', title: 'Count' }],
    instances: [{ instanceId: 'item', typeId: 'count', typeVersion: 1, title: 'Background value',
      content: { kind: 'metric', value: 7, unit: '' }, sourceTarget: null,
      updatedAt: new Date().toISOString(), staleAfterSeconds: null }],
  });
  if (result.state !== 'published') throw new Error('Expected an authorized Home publication');
}
const server = createServer((req, res) => {
  if (req.url === '/?token=test-only-launch') {
    res.writeHead(303, { location: '/', 'set-cookie': `${cookie}=test-session; HttpOnly; Path=/; SameSite=Strict` }); res.end(); return;
  }
  if (req.headers.cookie !== `${cookie}=test-session`) { res.writeHead(401); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: { ok: true, value: {} } }));
});
server.listen(port, '127.0.0.1', () => console.log(`dsh web: http://127.0.0.1:${port}/?token=test-only-launch`));
process.on('SIGTERM', () => { home?.close(); server.closeAllConnections(); server.close(() => process.exit(0)); });
