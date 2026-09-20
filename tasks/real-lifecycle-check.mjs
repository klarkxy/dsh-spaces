import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bin, home } from './real-config-check.mjs';
import { ProcessManager } from '../src/adapters/node/process-manager.ts';
import { PatchWriter } from '../src/adapters/node/patch-writer.ts';
import { setSelectedDshResolver } from '../src/adapters/node/dsh-cli.ts';

setSelectedDshResolver(() => bin);
const writer = new PatchWriter(home);
const manager = new ProcessManager(home, writer, 3350, 3379);
const names = ['web', 'coding', 'writing'];
const ports = new Set();
async function rpc(port, method, payload = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, connection: 'close' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.result?.ok, JSON.stringify(body));
  return body.result.value;
}
try {
  const instances = await Promise.all(names.map(name => manager.start(name)));
  assert.equal(new Set(instances.map(row => row.port)).size, names.length);
  const sessions = [];
  for (const [index, { port }] of instances.entries()) {
    ports.add(port);
    const cwd = join(home, `workspace-${names[index]}`); mkdirSync(cwd);
    const session = await rpc(port, 'session.create', { cwd });
    assert.ok(session.sessionId); sessions.push(session.sessionId);
  }
  for (const [index, { port }] of instances.entries()) {
    const ids = (await rpc(port, 'session.list')).items.map(row => row.sessionId);
    assert.ok(ids.includes(sessions[index]));
    sessions.forEach((id, other) => { if (other !== index) assert.ok(!ids.includes(id)); });
  }
  console.log('PASS three real DSH processes: concurrent startup, unique ports, session isolation');
  const restarted = await manager.restart('coding'); ports.add(restarted.port);
  assert.ok((await rpc(restarted.port, 'session.list')).items.some(row => row.sessionId === sessions[1]));
  for (const index of [0, 2]) await rpc(instances[index].port, 'session.list');
  console.log('PASS restarting coding preserves its sessions and other running spaces');
  await manager.stopAll();
  const patch = join(home, 'profiles', 'coding', 'cordis.patch.yml');
  const original = readFileSync(patch, 'utf8');
  try {
    writeFileSync(patch, original.replaceAll("hub/coding/sessions", "hub/writing/sessions"));
    await assert.rejects(writer.verify('coding'));
    await assert.rejects(manager.start('coding'));
    console.log('PASS real A8: invalid isolation is rejected before startup');
  } finally { writeFileSync(patch, original); }
  const pending = manager.start('coding');
  const cancelled = assert.rejects(pending);
  await manager.stopAll(); await cancelled;
  console.log('PASS stopAll cancels a real queued startup');
} finally { await manager.stopAll(); }
for (const port of ports) {
  await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }));
}
console.log('PASS all owned API ports closed');
