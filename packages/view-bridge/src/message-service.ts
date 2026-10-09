import { Context, Service } from '@deepseek-ai/cordis';
import { SpaceMessageBus, type SpaceOperation, type JsonValue, type SpaceCapabilityDeclaration, type SpaceCapability } from './message-bus';
/** Local Host service only: callers are plugins, never arbitrary browser messages. */
export class SpaceMessages extends Service {
  constructor(ctx: Context, private readonly bus: SpaceMessageBus) { super(ctx, 'spaceMessages'); }
  request(target: string, operation: string, params: JsonValue, timeoutMs?: number): Promise<JsonValue> {
    return this.bus.request(target, operation, params, timeoutMs);
  }
  capabilities(target: string, timeoutMs?: number): Promise<SpaceCapability[]> {
    return this.bus.capabilities(target, timeoutMs);
  }
  handle(operation: string, allowedSpaces: readonly string[], handler: SpaceOperation, declaration?: SpaceCapabilityDeclaration): () => void {
    const dispose = this.bus.handle(operation, allowedSpaces, handler, declaration);
    this.ctx.effect(() => dispose);
    return dispose;
  }
}
declare module '@deepseek-ai/cordis' { interface Context { spaceMessages: SpaceMessages } }
