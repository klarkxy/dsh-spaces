import type { GenerateOptions, PreparedLlmCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { LlmDelegationBootstrap } from '../../../src/shared/llm-delegation';
import { LLM_DELEGATION_PREFIX } from '../../../src/shared/llm-delegation';
export class MainTransport {
    constructor(private readonly identity: LlmDelegationBootstrap) { }
    async post(path: string, input: unknown, signal?: AbortSignal) {
        const response = await fetch(this.identity.origin + LLM_DELEGATION_PREFIX + path, { method: 'POST', redirect: 'error', signal, headers: { authorization: `Bearer ${this.identity.bearer}`, 'x-dsh-instance': this.identity.instanceId, 'content-type': 'application/json' }, body: JSON.stringify(input) });
        if (!response.ok) {
            const error = await response.json();
            throw Object.assign(new Error(error.error ?? 'MAIN_REQUEST_FAILED'), { code: error.error, status: response.status });
        }
        return response;
    }
    async *stream(sessionId: string, prepared: PreparedLlmCall & {
        lease: string;
    }, options: GenerateOptions, cancel?:()=>Promise<void>): AsyncIterable<StreamChunk> {
        const { signal, ...wire } = options;
        let response: Response;
        try {
            response = await this.post('stream', { sessionId, lease: prepared.lease, options: wire }, signal);
            if (!response.body) throw new Error('EMPTY_MAIN_STREAM');
        } catch(error) {
            try {if(cancel)await cancel();else await this.post('cancel',{sessionId,lease:prepared.lease},AbortSignal.timeout(5000));}
            catch(cleanup){throw new AggregateError([error,cleanup],'MAIN_STREAM_DISPATCH_AND_CANCEL_FAILED',{cause:error});}
            throw error;
        }
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let pending = '', terminal = false;
        try {
            while (true) {
                const step = await reader.read();
                if (step.done)
                    break;
                pending += decoder.decode(step.value, { stream: true });
                if (pending.length > 4 * 1024 * 1024)
                    throw new Error('MAIN_FRAME_TOO_LARGE');
                let index;
                while ((index = pending.indexOf('\n')) >= 0) {
                    const line = pending.slice(0, index);
                    pending = pending.slice(index + 1);
                    if (!line)
                        continue;
                    if (terminal)
                        throw new Error('MAIN_DATA_AFTER_FINISH');
                    const chunk = JSON.parse(line) as StreamChunk;
                    if (chunk.type === 'finish')
                        terminal = true;
                    yield chunk;
                }
            }
            pending += decoder.decode();
            if (pending || !terminal)
                throw new Error('MAIN_INCOMPLETE_STREAM');
        }
        finally {
            await reader.cancel();
            reader.releaseLock();
        }
    }
}
