import { BlueprintError, MAX_SHARE } from './codec.mjs';
import { closed } from './blueprint.mjs';
import { BlueprintCore, parseBlueprint } from './core.mjs';
import { officialPort } from './official.mjs';
import { installCreatorGuidance } from './creator-guidance.mjs';
import { installBlueprintTools } from './tools.mjs';
import { registerHostRpc } from './host-rpc.mjs';
export const name = 'dsh-blueprint';
export const inject = [];
export function apply(ctx) {
  installCreatorGuidance(ctx);
  installBlueprintTools(ctx);
  // Web is an optional adapter. No model call or profile mutation is exposed over page RPC.
  ctx.inject(['connection', 'webServer', 'pluginManager', 'profileContext'], scope => {
    const core = new BlueprintCore(officialPort(scope));
    scope.effect(() => registerHostRpc(scope, async (endpoint, payload, signal) => {
      try {
        if (Buffer.byteLength(JSON.stringify(payload) ?? '') > MAX_SHARE + 65536) throw new BlueprintError('size', 'Request too large.');
        signal.throwIfAborted();
        let value;
        switch (endpoint) {
          case 'catalog': closed(payload, [], 'catalog request'); value = await core.catalog(signal); break;
          case 'generate': value = await core.generate(payload, signal); break;
          case 'parse': closed(payload, ['text'], 'parse request'); value = parseBlueprint(payload.text); break;
          default: throw new BlueprintError('endpoint', 'Unknown or retired blueprint endpoint. Use Creator and native management tools to merge.');
        }
        signal.throwIfAborted();
        return { ok: true, value };
      } catch (e) {
        return { ok: false, error: { code: e instanceof BlueprintError ? e.code : 'operation-failed',
          message: e instanceof BlueprintError ? e.message : 'The read-only operation failed.', details: {} } };
      }
    }), 'dsh-blueprint.rpc');
  });
}
