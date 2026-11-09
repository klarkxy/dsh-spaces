import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { MainLlmService } from '../../packages/plugin/src/host/llm-main';

/**
 * MAIN_REGISTRATION_REFUSED carries only the HTTP status plus a whitelisted
 * supervisor error code. Arbitrary body text — tokens, messages, other JSON —
 * must never leak into the thrown error.
 */
type Stub = {
    endpoint: { origin: string; bearer: string; protocolVersion: 2; homeId: string; serviceEpoch: string };
    requests: { url: string; body: unknown }[];
    respond(status: number, body: unknown, headers?: Record<string, string>): void;
    close(): Promise<void>;
};

async function stubSupervisor(): Promise<Stub> {
    const requests: { url: string; body: unknown }[] = [];
    let status = 200, body: unknown = { registrationId: 'r1' }, headers: Record<string, string> = {};
    const server: Server = createServer((req, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            requests.push({ url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
            res.writeHead(status, headers);
            res.end(typeof body === 'string' || body instanceof Buffer ? body : JSON.stringify(body));
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    return {
        endpoint: {
            origin: `http://127.0.0.1:${port}`,
            bearer: 'a'.repeat(64),
            protocolVersion: 2,
            homeId: 'b'.repeat(64),
            serviceEpoch: 'c'.repeat(64),
        },
        requests,
        respond(nextStatus, nextBody, nextHeaders = {}) {
            status = nextStatus;
            body = nextBody;
            headers = nextHeaders;
        },
        close() {
            server.closeAllConnections();
            return new Promise<void>((done) => server.close(() => done()));
        },
    };
}

function service(): MainLlmService {
    const ctx = new Context();
    ctx.provide('attachments', {} as never);
    ctx.provide('fs', {} as never);
    ctx.provide('profileContext', { home: '/isolated-home', name: 'desktop' } as never);
    ctx.provide('llm', {} as never);
    return new MainLlmService(ctx);
}

async function refused(stub: Stub, status: number, body: unknown, headers?: Record<string, string>): Promise<Error> {
    stub.respond(status, body, headers);
    const main = service();
    try {
        return await main.attach(stub.endpoint).then(
            () => assert.fail('registration unexpectedly succeeded'),
            (error: unknown) => error as Error,
        );
    }
    finally {
        await main.close().catch(() => undefined);
    }
}

test('refusal surface carries only status plus a whitelisted code', async (t) => {
    const stub = await stubSupervisor();
    try {
        await t.test('400 workbench/read-only is distinguishable from a schema refusal', async () => {
            const error = await refused(stub, 400, { error: 'workbench/read-only' });
            assert.equal(error.message, 'MAIN_REGISTRATION_REFUSED:400:workbench/read-only');
        });
        await t.test('400 INVALID_INPUT is a different, recognizable code', async () => {
            const error = await refused(stub, 400, { error: 'INVALID_INPUT' });
            assert.equal(error.message, 'MAIN_REGISTRATION_REFUSED:400:INVALID_INPUT');
        });
        await t.test('403 and 404 keep the original prefix shape', async () => {
            const forbidden = await refused(stub, 403, { error: 'FOREIGN_HOME' });
            assert.match(forbidden.message, /^MAIN_REGISTRATION_REFUSED:403(:|$)/);
            assert.equal(forbidden.message, 'MAIN_REGISTRATION_REFUSED:403:FOREIGN_HOME');
            const missing = await refused(stub, 404, 'not found');
            assert.equal(missing.message, 'MAIN_REGISTRATION_REFUSED:404');
        });
        await t.test('409 conflict keeps a known code', async () => {
            const error = await refused(stub, 409, { error: 'MAIN_ALREADY_REGISTERED' });
            assert.equal(error.message, 'MAIN_REGISTRATION_REFUSED:409:MAIN_ALREADY_REGISTERED');
        });
        await t.test('unknown or injected-looking codes fall back to bare status', async () => {
            const unknown = await refused(stub, 400, { error: 'TOTALLY_UNKNOWN_CODE' });
            assert.equal(unknown.message, 'MAIN_REGISTRATION_REFUSED:400');
            const bearer = 'f'.repeat(64);
            const token = await refused(stub, 400, { error: `Bearer ${bearer}` });
            assert.equal(token.message, 'MAIN_REGISTRATION_REFUSED:400');
            assert.equal(token.message.includes(bearer), false);
            const sentence = await refused(stub, 400, { error: 'the real reason is a secret path C:/Users/secret' });
            assert.equal(sentence.message, 'MAIN_REGISTRATION_REFUSED:400');
            assert.equal(sentence.message.includes('secret'), false);
        });
        await t.test('non-JSON and oversized bodies never leak and never mask the status', async () => {
            const malformed = await refused(stub, 400, '<<< not json');
            assert.equal(malformed.message, 'MAIN_REGISTRATION_REFUSED:400');
            const large = await refused(stub, 400, { error: 'workbench/read-only', pad: 'x'.repeat(16 * 1024) });
            assert.equal(large.message, 'MAIN_REGISTRATION_REFUSED:400');
            const declared = await refused(stub, 400, { error: 'workbench/read-only' }, { 'content-length': String(64 * 1024) });
            // Declared length past the bound skips the body entirely: bare status.
            assert.equal(declared.message, 'MAIN_REGISTRATION_REFUSED:400');
        });
        await t.test('a truncated mid-stream body keeps the original status', async () => {
            const before = stub.requests.length;
            const error = await refused(stub, 400, Buffer.from('{"error":"workben'), { 'content-length': '64', connection: 'close' });
            assert.equal(error instanceof TypeError, false);
            assert.equal(error.message, 'MAIN_REGISTRATION_REFUSED:400');
            assert.equal(stub.requests.slice(before).filter((request) => request.url.endsWith('/register')).length, 1);
        });
        await t.test('a successful registration still works', async () => {
            stub.respond(200, { registrationId: 'ok-1' });
            const before = stub.requests.length;
            const main = service();
            try {
                await main.attach(stub.endpoint);
            }
            finally {
                await main.close().catch(() => undefined);
            }
            const fresh = stub.requests.slice(before).filter((request) => request.url.endsWith('/register'));
            assert.equal(fresh.length, 1);
            const input = fresh[0]!.body as Record<string, unknown>;
            assert.equal(typeof input.bearer, 'string');
            assert.equal(input.profile, 'desktop');
            assert.equal(input.home, resolve('/isolated-home'));
        });
        await t.test('random 64-hex values in other JSON fields are never surfaced', async () => {
            const secret = randomBytes(32).toString('hex');
            const error = await refused(stub, 400, { error: 'workbench/read-only', bearer: secret, detail: `token=${secret}` });
            assert.equal(error.message, 'MAIN_REGISTRATION_REFUSED:400:workbench/read-only');
            assert.equal(error.message.includes(secret), false);
        });
    }
    finally {
        await stub.close();
    }
});
