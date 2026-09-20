import assert from 'node:assert/strict';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/adapters/node/runtime-store.ts';
import { ProcessManager } from '../src/adapters/node/process-manager.ts';
import { PatchWriter } from '../src/adapters/node/patch-writer.ts';
import { setSelectedDshResolver } from '../src/adapters/node/dsh-cli.ts';
import { setToolchainRoot } from '../src/adapters/node/toolchain.ts';
const [home, testRoot, sessionId] = process.argv.slice(2);
assert.ok(home && testRoot && sessionId, 'Usage: restored-start-check.mjs <temporary-home> <test-root> <original-session-id>');
for (const path of [home, testRoot]) {
  const rel = relative(tmpdir(), path);
  assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('spaces-'), 'only acceptance temporary directories are allowed');
}
const runtimes = new RuntimeStore({ root: join(testRoot, 'app', 'runtimes'), source: () => 'official', legacy: () => undefined });
setSelectedDshResolver(() => runtimes.current().bin);
setToolchainRoot(join(testRoot, 'tools'));
const manager = new ProcessManager(home, new PatchWriter(home), 3340, 3359);
manager.onStatus((name, status, extra) => console.log(name, status, JSON.stringify(extra)));
manager.onLog((name, stream, text) => console.log(name, stream, text.trim()));
try {
  const { port } = await manager.start('coding');
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/api/session.list`, { method: 'POST', headers: { 'content-type': 'application/json', origin, connection: 'close' }, body: JSON.stringify({ type: 'client-request', rpcId: 'acceptance', method: 'session.list', payload: {} }), signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  assert.ok(body.result.ok);
  console.log('Restored sessions:', JSON.stringify(body.result.value.items));
  assert.ok(body.result.value.items.some(row => row.sessionId === sessionId));
  console.log('PASS snapshot runtime starts on its owned endpoint and returns the original coding session');
} finally { await manager.stopAll(); }
