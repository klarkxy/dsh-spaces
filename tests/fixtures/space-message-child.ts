import { SpaceMessageBus } from '../../packages/view-bridge/src/message-bus.ts';
const bus = new SpaceMessageBus();
const disposeEcho = bus.handle('echo', ['alpha', 'beta'], async (params, caller) => {
  const p = params as { delay?: number; value?: string };
  if (p.delay) await new Promise(resolve => setTimeout(resolve, p.delay));
  return { value: p.value ?? null, caller: caller.spaceId };
}, { description: 'Echo a value and the trusted caller.' });
bus.handle('private', [], () => 'never');
bus.handle('failure', ['alpha'], () => { throw new Error('secret token must not leave Host'); });
bus.handle('bad-result', ['alpha'], () => undefined as never);
bus.handle('hang', ['alpha'], () => new Promise(() => {}));
process.on('message', async (m: any) => {
  if (m?.test === 'capabilities') {
    try { process.send!({ test: 'result', id: m.id, ok: true, value: await bus.capabilities(m.target) }); }
    catch (error: any) { process.send!({ test: 'result', id: m.id, ok: false, error: error.code }); }
  } else if (m?.test === 'dispose-echo') { disposeEcho(); process.send!({ test: 'result', id: m.id }); }
  else if (m?.test === 'request') {
    try { process.send!({ test: 'result', id: m.id, ok: true, value: await bus.request(m.target, m.operation, m.params, m.timeoutMs) }); }
    catch (error: any) { process.send!({ test: 'result', id: m.id, ok: false, error: error.code }); }
  } else if (m?.test === 'counts') process.send!({ test: 'result', id: m.id, pending: bus.pendingCount, active: bus.activeCount });
  else if (m?.test === 'disconnect') process.disconnect!();
  else if (m?.test === 'exit') process.exit(0);
  else if (m?.test === 'raw') process.send!(m.value);
});
process.send!({ test: 'ready' });
process.on('disconnect', () => process.exit(0));
