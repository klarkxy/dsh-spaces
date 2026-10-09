/** Minimal native Host, with real Cordis/view-bridge service and private IPC. */
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../../packages/view-bridge/src/index.ts';
const ctx = new Context();
await ctx.plugin({ name: 'fixture-view', apply: plugin => { apply(plugin); } });
let disposeOperation: (() => Promise<void>) | undefined;
const registration = await ctx.plugin({ name: 'fixture-operation', inject: ['spaceMessages'], apply: plugin => {
  plugin.spaceMessages.handle('echo', ['alpha'], (params, caller) => ({ params, caller: caller.spaceId }));
} });
disposeOperation = async () => { await registration.dispose(); };
process.on('message', async (m: any) => {
  if (m?.test === 'request') {
    try { process.send!({ test: 'result', id: m.id, ok: true, value: await ctx.spaceMessages.request(m.target, m.operation, m.params) }); }
    catch (error: any) { process.send!({ test: 'result', id: m.id, ok: false, error: error.code }); }
  } else if (m?.test === 'dispose-operation') { await disposeOperation!(); process.send!({ test: 'result', id: m.id }); }
});
const port = Number(process.env.BUS_TEST_PORT), cookie = process.env.BUS_TEST_COOKIE!;
const server = createServer((req, res) => {
  if (req.url === '/?token=test-only-launch') {
    res.writeHead(303, { location: '/', 'set-cookie': `${cookie}=test-session; HttpOnly; Path=/; SameSite=Strict` }); res.end(); return;
  }
  if (req.headers.cookie !== `${cookie}=test-session`) { res.writeHead(401); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: { ok: true, value: {} } }));
});
server.listen(port, '127.0.0.1', () => console.log(`dsh web: http://127.0.0.1:${port}/?token=test-only-launch`));
process.on('SIGTERM', async () => { await ctx.dispose(); server.closeAllConnections(); server.close(() => process.exit(0)); });
