import { Context, Service } from '@deepseek-ai/cordis';
import { SpaceMessageBus, type SpaceOperation, type JsonValue } from './message-bus';
/** Local Host service only: callers are plugins, never arbitrary browser messages. */
export class SpaceMessages extends Service {
  constructor(ctx: Context, private readonly bus: SpaceMessageBus) { super(ctx, 'spaceMessages'); }
  request(target: string, operation: string, params: JsonValue, timeoutMs?: number): Promise<JsonValue> {
    return this.bus.request(target, operation, params, timeoutMs);
  }
  handle(operation: string, allowedSpaces: readonly string[], handler: SpaceOperation): () => void {
    const dispose = this.bus.handle(operation, allowedSpaces, handler);
    this.ctx.effect(() => dispose);
    return dispose;
  }
}
declare module '@deepseek-ai/cordis' { interface Context { spaceMessages: SpaceMessages } }
