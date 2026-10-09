import { MAX_SHARE } from './codec.mjs';

const CHANNEL = '/dsh-blueprint';
// The payload may contain a full share code plus JSON framing and RPC metadata.
const MAX_REQUEST_BYTES = MAX_SHARE + 65536 + 1024;

/** Blueprint's standalone HTTP boundary, admitted by the native Connection service. */
export function registerHostRpc(ctx, call) {
  return ctx.webServer.register({ kind: 'prefix', path: CHANNEL, handler: async (req, res) => {
    const reject = status => {
      if (res.destroyed) return;
      res.writeHead(status, status === 413 ? { connection: 'close' } : {});
      res.end(status === 500 ? 'rpc request failed' : '');
    };
    try {
      if (typeof ctx.connection.requestRejection !== 'function') { reject(503); return; }
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) { reject(rejection); return; }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const endpoint = pathname.startsWith(`${CHANNEL}/`) ? pathname.slice(CHANNEL.length + 1) : '';
      if (req.method !== 'POST' || endpoint === '.' || endpoint === '..' || !/^[A-Za-z0-9_$.-]+$/.test(endpoint)) {
        reject(404); return;
      }
      if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        reject(415); return;
      }
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_REQUEST_BYTES) { reject(413); req.destroy(); return; }
        chunks.push(bytes);
      }
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reject(400); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)
          || message.type !== 'client-request' || typeof message.rpcId !== 'string'
          || message.method !== endpoint || !Object.hasOwn(message, 'payload')) {
        reject(400); return;
      }
      const raw = await call(endpoint, message.payload, controller.signal);
      const result = raw.ok ? raw : { ...raw, error: { details: {}, ...raw.error } };
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }));
      }
    } catch {
      reject(500);
    }
  } });
}
