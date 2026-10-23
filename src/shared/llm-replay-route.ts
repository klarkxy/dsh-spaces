import type { Message, ReplayEnvelope, ModelMessageSource } from '@deepseek-ai/dsh-llm';
/** The facade advertises its own routes; native state remains opaque inside a lossless route envelope. */
export function wrapMainReplay(replay: ReplayEnvelope, provider: string, model: string): ReplayEnvelope {
    return { ...replay, response: { kind: 'dsh-spaces-main-v1', provider, model, nativeResponse: replay.response } };
}
export function unwrapMainReplay(message: Message): Message {
    if (message.source?.kind !== 'model')
        return message;
    const source = message.source as ModelMessageSource, replay = source.replayState as ReplayEnvelope | undefined;
    const wrapper = replay?.response as {
        kind?: string;
        provider?: string;
        model?: string;
        nativeResponse?: unknown;
    } | undefined;
    if (wrapper?.kind !== 'dsh-spaces-main-v1') {
        // Same-named child-local providers do not prove a main-host origin.
        const { replayState: _replay, ...withoutReplay } = source;
        return { ...message, source: withoutReplay } as Message;
    }
    if (typeof wrapper.provider !== 'string' || typeof wrapper.model !== 'string' || !Object.hasOwn(wrapper, 'nativeResponse') ||
        !(source.provider === 'spaces-main' && source.model === 'default' || source.provider === 'spaces-main:' + wrapper.provider && source.model === wrapper.model))
        throw new Error('REPLAY_ORIGIN_MISMATCH');
    return { ...message, source: { ...source, provider: wrapper.provider, model: wrapper.model, replayState: { ...replay!, response: wrapper.nativeResponse } } } as Message;
}
