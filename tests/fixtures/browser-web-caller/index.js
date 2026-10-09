export const name = 'browser-caller-fixture';
export const inject = ['spaceMessages'];
export function apply(ctx) {
  const target = process.env.BROWSER_ACCEPT_TARGET;
  if (!target) throw new Error('Browser acceptance target is missing');
  const receive = async raw => {
    if (raw?.test !== 'browser-live-query') return;
    try {
      const value = raw.kind === 'capabilities' ? await ctx.spaceMessages.capabilities(target)
        : await ctx.spaceMessages.request(target, raw.operation, raw.params);
      process.send?.({ test: 'browser-live-result', id: raw.id, ok: true, value });
    } catch (error) { process.send?.({ test: 'browser-live-result', id: raw.id, ok: false, error: error?.code ?? String(error) }); }
  };
  process.on('message', receive);
  ctx.effect(() => () => process.off('message', receive));
  process.send?.({ test: 'browser-caller-ready' });
}
export default {name, inject, apply};
