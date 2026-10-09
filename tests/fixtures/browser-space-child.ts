import { Context, Service } from '@deepseek-ai/cordis';
import { SpaceMessageBus } from '../../packages/view-bridge/src/message-bus.ts';
import { SpaceMessages } from '../../packages/view-bridge/src/message-service.ts';
import { apply as browserApply } from '../../packages/browser/src/index.ts';

const ctx = new Context();
class TestWebServer extends Service {
  readonly port = 4100;
  constructor(ctx: Context) { super(ctx, 'webServer'); }
}
await ctx.plugin({ name: 'test-server', apply: plugin => { new TestWebServer(plugin); } });
await ctx.plugin({ name: 'test-bus', apply: plugin => { new SpaceMessages(plugin, new SpaceMessageBus()); } });
await ctx.plugin({ name: 'test-browser', inject: ['spaceMessages', 'webServer'],
  apply: plugin => { browserApply(plugin, { allowedSpaces: process.env.BROWSER_ALLOWED ? process.env.BROWSER_ALLOWED.split(',') : [] }); } });
process.send?.({ test: 'ready' });
process.on('disconnect', () => { void ctx.fiber.dispose().finally(() => process.exit(0)); });
