import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import type { Context } from '@deepseek-ai/cordis';
import type { LlmCallConfig, PreparedLlmCall, GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { SupervisorEndpoint } from './supervisor-bootstrap';
import { readSourceImage, type MainImageScope } from './llm-images';
import { LLM_DELEGATION_PREFIX } from '../../../../src/shared/llm-delegation';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-app-boot';
import { unwrapMainReplay } from '../../../../src/shared/llm-replay-route';
type Request = {
    requestId: string;
    sessionId: string;
    abort: AbortController;
    prepared?: PreparedLlmCall;
    lease?: string;
    used?: boolean;
    timer?: NodeJS.Timeout;
};
/**
 * Public error codes a supervisor may put in the JSON `error` field of a
 * refused register/catalog-updated/unregister response. A closed set: anything
 * else — arbitrary messages, tokens, or unrelated codes — is dropped so the
 * thrown error only ever carries status plus a recognized code.
 */
const SUPERVISOR_REFUSAL_CODES: ReadonlySet<string> = new Set([
    'INVALID_CONTENT_TYPE', 'BODY_TOO_LARGE', 'NATIVE_AUTH_REQUIRED',
    'UNAUTHENTICATED', 'METHOD_NOT_ALLOWED', 'REQUEST_LIMIT', 'HOST_REQUIRED',
    'HOST_AUTH_REQUIRED', 'MAIN_ALREADY_REGISTERED', 'MAIN_DRAINING',
    'FOREIGN_HOME', 'INVALID_MAIN_ORIGIN', 'MAIN_IDENTITY_MISMATCH',
    'MAIN_NOT_REGISTERED', 'STALE_MAIN', 'UNAVAILABLE', 'CLEANUP_UNCONFIRMED',
    'UNKNOWN_OPERATION', 'REQUEST_FAILED', 'INVALID_INPUT',
    'workbench/read-only', 'workbench/unavailable', 'workbench/protected',
]);
const SUPERVISOR_REFUSAL_BODY_LIMIT = 8 * 1024;
/** A plugin-owned listener; official LLM services retain credentials and adapter generations. */
export class MainLlmService {
    private endpoint?: SupervisorEndpoint;
    private registrationId?: string;
    private bearer = randomBytes(32).toString('hex');
    private readonly requests = new Map<string, Request>();
    private readonly calls = new Map<string, Request>();
    private readonly contexts = new WeakMap<object, MainImageScope>();
    private readonly storage = new AsyncLocalStorage<MainImageScope>();
    private closed = false;
    private attaching?: Promise<void>;
    private readonly server = createServer((req, res) => { void this.handle(req, res); });
    constructor(private readonly ctx: Context) {
        ctx.provide('spacesMainAttachmentSource', { store: ctx.attachments, fs: ctx.fs, storage: this.storage });
        ctx.on('llm/adapters-updated', async () => {
            if (!this.registrationId || this.closed) return;
            await this.supervisor('catalog-updated', {registrationId:this.registrationId});
        });
        ctx.on('llm/stream', (options, next) => {
            const value = this.contexts.get(options) ?? { local: true, paths: new Map(), revoked: false };
            const iterable = next(), storage = this.storage;
            return { async *[Symbol.asyncIterator]() { const iterator = storage.run(value, () => iterable[Symbol.asyncIterator]()); try {
                    while (true) {
                        const step = await storage.run(value, () => iterator.next());
                        if (step.done)
                            break;
                        yield step.value;
                    }
                }
                finally {
                    await storage.run(value, () => iterator.return?.());
                    value.revoked = true;
                } } };
        });
    }
    attach(endpoint: SupervisorEndpoint): Promise<void> {
        if (this.closed)
            throw new Error('MAIN_CLOSED');
        if (this.endpoint) {
            if (this.endpoint.serviceEpoch !== endpoint.serviceEpoch)
                throw new Error('MAIN_REGISTRATION_CHANGED');
            return this.attaching!;
        }
        this.endpoint = endpoint;
        return this.attaching = this.register();
    }
    private async register() {
        try {
        await new Promise<void>((accept, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); accept(); }); });
        const profile = this.ctx.profileContext;
        const response = await this.supervisor('register', { origin: `http://127.0.0.1:${(this.server.address() as {
                port: number;
            }).port}`, bearer: this.bearer,
            home: resolve(profile.home), profile: profile.name, allowedSpaces: [], allowNewSpaces: true, liveCatalog: true, routes: [] });
        this.registrationId = (await response.json()).registrationId;
        } catch(error) {
            this.server.closeAllConnections();
            if(this.server.listening)await new Promise<void>(r=>this.server.close(()=>r()));
            throw error;
        }
    }
    private async supervisor(operation: string, input: unknown) {
        const response = await fetch(this.endpoint!.origin + LLM_DELEGATION_PREFIX + operation, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${this.endpoint!.bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
        if (!response.ok) {
            const code = await this.refusalCode(response);
            throw new Error('MAIN_REGISTRATION_REFUSED:' + response.status + (code ? ':' + code : ''));
        }
        return response;
    }
    /** Bounded read of a refusal body; read failures never mask the HTTP status. */
    private async refusalCode(response: Response): Promise<string | undefined> {
        try {
            if (!response.body || Number(response.headers.get('content-length')) > SUPERVISOR_REFUSAL_BODY_LIMIT) {
                await response.body?.cancel();
                return undefined;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            const reader = response.body.getReader();
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done)
                        break;
                    bytes += value.length;
                    if (bytes > SUPERVISOR_REFUSAL_BODY_LIMIT) {
                        await reader.cancel();
                        return undefined;
                    }
                    chunks.push(Buffer.from(value));
                }
            }
            finally {
                reader.releaseLock();
            }
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const error = (parsed as { error?: unknown }).error;
                if (typeof error === 'string' && SUPERVISOR_REFUSAL_CODES.has(error))
                    return error;
            }
        }
        catch { }
        return undefined;
    }
    private json(res: ServerResponse, value: unknown, status = 200) { if (res.destroyed || res.writableEnded)
        return; res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
    private async handle(req: import('node:http').IncomingMessage, res: ServerResponse) {
        try {
            if (this.closed && req.url !== '/cancel' || req.method !== 'POST' || req.headers.authorization !== `Bearer ${this.bearer}` || req.headers.origin || req.headers.cookie)
                throw new Error('MAIN_AUTH_REQUIRED');
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const part of req) {
                bytes += part.length;
                if (bytes > 1024 * 1024)
                    throw new Error('BODY_TOO_LARGE');
                chunks.push(part);
            }
            const input = JSON.parse(Buffer.concat(chunks).toString());
            if (req.url === '/identity')
                return this.json(res, { nonce: input.nonce, home: resolve(this.ctx.profileContext.home), profile: this.ctx.profileContext.name });
            if (req.url === '/describe') {
                const providers = this.ctx.llm.listProviders();
                const models = (await Promise.all(providers.map(p => this.ctx.llm.listModels(p.id)))).flat();
                return this.json(res, { providers, models, selection: this.ctx.agentDefaultModel.currentSelection() });
            }
            if (req.url === '/model-info')
                return this.json(res, await this.ctx.llm.resolveModelInfo(input.provider, input.model));
            if (req.url === '/resolve-config')
                return this.json(res, await this.ctx.llm.resolveCallConfig(input.config));
            if (req.url === '/cancel') {
                let request = this.requests.get(input.requestId);
                if (!request) {
                    request = { requestId: input.requestId, sessionId: input.sessionId, abort: new AbortController() };
                    this.requests.set(input.requestId, request);
                }
                if (request.sessionId !== input.sessionId)
                    throw new Error('SESSION_MISMATCH');
                request.abort.abort();
                clearTimeout(request.timer);
                if (request.lease)
                    this.calls.delete(request.lease);
                request.timer = setTimeout(() => this.requests.delete(input.requestId), 10000);
                request.timer.unref();
                return this.json(res, { canceled: true });
            }
            if (req.url === '/prepare') {
                if (this.requests.has(input.requestId) || this.requests.size >= 512)
                    throw new Error('MAIN_REQUEST_LIMIT');
                const request: Request = { requestId: input.requestId, sessionId: input.sessionId, abort: new AbortController() };
                this.requests.set(input.requestId, request);
                const disconnected = () => { if (!res.writableEnded)
                    request.abort.abort(); };
                res.once('close', disconnected);
                try {
                    const prepared = await this.ctx.llm.prepareCall(input.config as LlmCallConfig, request.abort.signal, (controls, model) => { if (input.expectedModel && !deepEqualJson(model, input.expectedModel))
                        throw new Error('MODEL_CAPABILITY_CHANGED'); return controls; });
                    request.abort.signal.throwIfAborted();
                    request.prepared = prepared;
                    request.lease = randomBytes(32).toString('hex');
                    this.calls.set(request.lease, request);
                    request.timer = setTimeout(() => { request.abort.abort(); this.calls.delete(request.lease!); this.requests.delete(input.requestId); }, 10000);
                    request.timer.unref();
                    const { stream, ...metadata } = prepared;
                    return this.json(res, { ...metadata, adapterDefaults: { ...metadata.adapterDefaults, ...input.defaultReasoning ? { reasoningEffort: true } : {} }, lease: request.lease });
                }
                finally {
                    res.off('close', disconnected);
                }
            }
            const call = this.calls.get(input.lease);
            if (req.url !== '/stream' || !call?.prepared || call.used || call.sessionId !== input.sessionId)
                throw new Error('MAIN_LEASE_NOT_OWNED');
            call.used = true;
            this.calls.delete(input.lease);
            clearTimeout(call.timer);
            const scope: MainImageScope = { images: input.images, revoked: false, paths: new Map() };
            const disconnected = () => { if (!res.writableEnded)
                call.abort.abort(); };
            res.once('close', disconnected);
            try {
                for (const ref of input.images.refs) {
                    const info = await readSourceImage(scope, ref, null, call.abort.signal);
                    scope.paths.set(ref.attachmentId, info.toolPath);
                }
                const messages = input.options.messages.map(unwrapMainReplay);
                const options = { ...input.options, messages, signal: call.abort.signal } as GenerateOptions;
                this.contexts.set(options, scope);
                res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
                for await (const chunk of call.prepared.stream(options)) {
                    if (res.destroyed)
                        break;
                    if (!res.write(JSON.stringify(chunk) + '\n'))
                        await new Promise<void>((accept, reject) => { res.once('drain', accept); res.once('close', () => reject(new Error('STREAM_CLOSED'))); });
                }
                res.end();
            }
            finally {
                scope.revoked = true;
                call.abort.abort();
                this.requests.delete(call.requestId);
                res.off('close', disconnected);
            }
        }
        catch (error) {
            if (!res.headersSent)
                this.json(res, { error: error instanceof Error ? error.message : 'MAIN_FAILED' }, 400);
            else
                res.destroy();
        }
    }
    /** Called only by the explicit Desktop operation after shutdown and lease release. */
    async afterSupervisorStopped(previousEpoch: string | null) {
        if (this.closed) throw new Error('MAIN_CLOSED');
        if (previousEpoch !== null && this.endpoint && this.endpoint.serviceEpoch !== previousEpoch) throw new Error('MAIN_REGISTRATION_CHANGED');
        await this.attaching?.catch(() => {});
        this.registrationId = undefined;
        for (const request of this.requests.values()) { request.abort.abort(); clearTimeout(request.timer); }
        this.calls.clear(); this.requests.clear();
        this.server.closeAllConnections();
        if (this.server.listening) await new Promise<void>(r => this.server.close(() => r()));
        this.endpoint = undefined; this.attaching = undefined;
        this.bearer = randomBytes(32).toString('hex');
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        await this.attaching?.catch(() => { });
        for (const request of this.requests.values()) {
            request.abort.abort();
            clearTimeout(request.timer);
        }
        this.calls.clear();
        let error: unknown;
        try {
            if (this.registrationId)
                await this.supervisor('unregister', { registrationId: this.registrationId });
        }
        catch (e) {
            error = e;
        }
        this.server.closeAllConnections();
        if (this.server.listening)
            await new Promise<void>(r => this.server.close(() => r()));
        if (error)
            throw error;
    }
}
