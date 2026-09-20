import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from '../src/adapters/node/process-manager.ts';

const unhandled = [];
process.on('unhandledRejection', err => unhandled.push(String(err)));
const rejected = new ProcessManager('unused', { verify: async () => { throw new Error('expected verification failure'); } });
await rejected.start('coding').catch(() => {});
await delay(20);
console.log('handled start rejection creates unhandled promises:', unhandled.length);

let release;
let verifies = 0;
let ensureCalls = 0;
const processes = new ProcessManager('unused', {
  verify: async () => { if (++verifies === 1) await new Promise(resolve => { release = resolve; }); },
}, 51001, 51001, {
  ensureCli: async () => { ensureCalls++; throw new Error('should never try to start cancelled queued work'); },
});
const first = processes.start('coding').catch(() => {});
const restart = processes.restart('coding').catch(() => {});
const stop = processes.stopAll();
release();
await Promise.allSettled([first, restart, stop]);
await delay(20);
console.log('queued restart runs CLI after stopAll:', ensureCalls);
assert.equal(unhandled.length, 0, 'handled caller rejections must not leak unhandled rejections');
assert.equal(ensureCalls, 0, 'stopAll must invalidate queued restarts');
