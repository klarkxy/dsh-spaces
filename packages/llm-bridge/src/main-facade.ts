import { Context, type Fiber } from '@deepseek-ai/cordis';
import LlmRuntime, { callConfigEquals, resolveRetryPolicy, projectFilesToText, type LlmAdapter, type LlmCallConfig, type ConfigureCall, type PreparedLlmCall, type LlmProviderInfo, type LlmModelInfo, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-fs';
import { connectOwnedLlmChannel } from './delegation-channel';
import { MainTransport } from './main-transport';
import { apply as applySpaceBridge } from './plugin';
import { createHash } from 'node:crypto';
import { deepFreeze } from '@deepseek-ai/dsh-util-values';
import {assertOwnedProfilePath} from '../../../src/adapters/node/profile/profile-settings';
import { wrapMainReplay } from '../../../src/shared/llm-replay-route';
import {AuxiliaryContext,type Route} from './auxiliary-context';
import type {Session,SessionSeq} from '@deepseek-ai/dsh-session';
import {singleAuxiliaryPolicy} from './auxiliary-policy';
import type {StreamChunk} from '@deepseek-ai/dsh-llm';
import {scopeAuxiliaryCommands} from './auxiliary-policy';
import {AutomaticCompactionFailures} from './automatic-compaction';
import type {Agent} from '@deepseek-ai/dsh-agent';
const PREFIX = 'spaces-main:';
declare module '@deepseek-ai/cordis' {interface Events {
    'llm/adapters-updated'():void;
    'compaction/summary-error'(payload:{session:Session;sourceEventSeqs:readonly SessionSeq[];error:unknown;signal?:AbortSignal},next:()=>boolean):boolean;
}}
export const MAIN_PROVIDER = 'spaces-main';
const virtual = (provider: string) => PREFIX + provider;
const unvirtual = (provider: string) => provider.startsWith(PREFIX) ? provider.slice(PREFIX.length) : provider;
const controls = (config: Record<string, any>) => Object.fromEntries(['reasoningEffort', 'temperature', 'maxTokens', 'stop'].filter(k => config[k] !== undefined).map(k => [k, config[k]]));
type Description = {
    providers: LlmProviderInfo[];
    models: LlmModelInfo[];
    selection: LlmCallConfig;
};
type Origin = {
    sessionId: string;
    defaultReasoning: boolean;
    target: LlmCallConfig;
    main?:boolean;
};
/** Keeps ordinary native adapters for explicit local/shared choices; main calls bypass local replay filtering. */
export class MainLlmFacade extends LlmRuntime {
    private description?: Description;
    private transport?: MainTransport;
    private channel?: Awaited<ReturnType<typeof connectOwnedLlmChannel>>;
    private readonly exact = new WeakMap<object, Origin>();
    private consumers?: Context;
    private auxiliary?:AuxiliaryContext;
    private readonly automaticFailures=new AutomaticCompactionFailures();
    private remoteProvider(provider: string) { return !!this.transport && (provider === MAIN_PROVIDER || provider.startsWith(PREFIX)); }
    registerAdapter(providers: string[], adapter: LlmAdapter) { if (process.env.DSH_SPACES_LLM_INHERIT_MAIN==='1'&&providers.some(p => p===MAIN_PROVIDER||p.startsWith(PREFIX)))
        throw new Error('MAIN_ROUTE_RESERVED'); return super.registerAdapter(providers, adapter); }
    async initialize() {
        this.ctx.provide('spacesAuxiliarySources',{llm:this});
        this.ctx.inject(['sessionTitle'],ready=>ready.provide('spacesTitleSource',{realm:ready[Context.isolate].sessionTitle} as never));
        this.ctx.inject(['commands'],ready=>ready.provide('spacesCommandsSource',{realm:ready[Context.isolate].commands} as never));
        if (process.env.DSH_SPACES_LLM_INHERIT_MAIN !== '1')
            return;
        this.ctx.on('internal/config',function(this:Fiber|undefined,first:Fiber|undefined,next:()=>unknown){const fiber=this??first;const result=next();const name=fiber?.runtime?.callback.name;const project=name==='BasicCompactionEngine'?(value:unknown)=>{const policy=singleAuxiliaryPolicy(value) as {auto?:boolean};if(policy?.auto!==false)throw new Error('SPACES_AUTOMATIC_COMPACTION_REQUIRES_GUARDED_PRESET');return policy;}:name==='AgentPreset'?scopeAuxiliaryCommands:undefined;return !project?result:result instanceof Promise?result.then(project):project(result);},{global:true,prepend:true});
        this.channel = await connectOwnedLlmChannel((request, signal) => this.readImage(request, signal),()=>{
            if(this.transport)void this.refresh().catch(error=>this.ctx.logger.warn(error));
        });
        this.ctx.effect(() => () => this.channel?.dispose());
        this.transport = new MainTransport(this.channel.bootstrap);
        try { await this.refresh(); } catch(error) {this.channel.dispose();this.transport=undefined;throw error;}
        this.consumers = this.ctx;
        this.auxiliary=new AuxiliaryContext(session=>{if(this.ctx.sessions?.get(session.id)!==session)throw new Error('EXACT_SESSION_ORIGIN_REQUIRED');});
        // Native summary-error listeners can otherwise mutate selected input and repeat independently of retry counts.
        this.ctx.on('compaction/summary-error',()=>false,{global:true,prepend:true});
        this.ctx.on('session/event',(session,event)=>{if(event.type==='request/header')void this.auxiliary!.header(session,event.data.header.config)?.catch(error=>this.ctx.logger.error(error));});
        this.ctx.on('agent/pre-step',async(payload:any,next:any)=>{
            if(this.ctx.agents?.get(payload.agent.id)!==payload.agent)throw new Error('EXACT_AGENT_ORIGIN_REQUIRED');
            const session=payload.agent.session;this.automaticFailures.assertClean(session);
            const scope=await this.auxiliary!.capture(session,session.requestHeader()?.config);scope.automatic=true;
            return this.auxiliary!.storage.run(scope,async()=>{const result=await next();if(scope.failed)throw scope.failure;return result;});
        },{prepend:true});
        this.ctx.on('agent/request', async (payload: any, next: any) => {
                const seed = await next(), agent = payload.agent;
                if (!agent || this.ctx.agents?.get(agent.session.id) !== agent)
                    throw new Error('EXACT_AGENT_ORIGIN_REQUIRED');
                // Official Agent selection and downstream middleware have already assembled this proposal.
                const selection = seed, selectedProvider = selection.provider;
                if (selectedProvider && !this.remoteProvider(selectedProvider))
                    return seed;
                const description = await this.refresh();
                const target: LlmCallConfig = selectedProvider && selectedProvider !== MAIN_PROVIDER ? { provider: unvirtual(selectedProvider), model: selection.model } : description.selection;
                if (!target?.provider || !target.model)
                    throw new Error('MAIN_DEFAULT_MODEL_MISSING');
                const explicit = controls(selection);
                const defaultReasoning = explicit.reasoningEffort === undefined && target.reasoningEffort !== undefined;
                const config = deepFreeze({ ...seed, ...target, ...explicit, provider: selectedProvider || MAIN_PROVIDER, model: selectedProvider && selectedProvider !== MAIN_PROVIDER ? selection.model : 'default' });
                this.exact.set(config, { sessionId: agent.session.id, defaultReasoning, target,main:true });
                return config;
            });
    }
    private async refresh() {
        const next:Description=await (await this.transport!.post('describe', {})).json();
        const changed=this.description&&JSON.stringify([this.description.providers,this.description.models])!==JSON.stringify([next.providers,next.models]);
        this.description=next;
        if(changed)void this.ctx.parallel('llm/adapters-updated').catch(error=>this.ctx.logger.warn(error));
        return next;
    }
    listProviders() { const local = super.listProviders(); if (!this.description)
        return local; return [...local, { id: MAIN_PROVIDER, name: '主空间默认' }, ...this.description.providers.map(p => ({ id: virtual(p.id), name: '主空间 · ' + p.name }))]; }
    async listModels(provider: string) { if (!this.remoteProvider(provider))
        return super.listModels(provider); const d = await this.refresh(); if (provider === MAIN_PROVIDER)
        return d.selection?.provider && d.selection.model ? [{ provider, id: 'default', name: '跟随主空间默认' }] : []; return d.models.filter(m => m.provider === unvirtual(provider)).map(m => ({ ...m, provider })); }
    async resolveModelInfo(provider: string, model: string, signal?: AbortSignal) {
        if (!this.remoteProvider(provider))
            return super.resolveModelInfo(provider, model, signal);
        const scope=this.auxiliary?.storage.getStore();
        const bound=scope?this.auxiliary!.route(scope,{provider,model}):{provider,model};
        const selection = bound.provider === MAIN_PROVIDER ? (await this.refresh()).selection : { provider: unvirtual(bound.provider), model:bound.model };
        const info = await (await this.transport!.post('model-info', { provider: selection.provider, model: selection.model }, signal)).json();
        return { ...info, provider, id: model };
    }
    async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig> {
        if (!this.remoteProvider(config.provider))
            return super.resolveCallConfig(config, signal);
        const target = config.provider === MAIN_PROVIDER ? (await this.refresh()).selection : { provider: unvirtual(config.provider), model: config.model };
        const effective = await (await this.transport!.post('resolve-config', { config: { ...target, ...controls(config) } }, signal)).json();
        const result={ ...effective, provider: config.provider, model: config.model };
        // UI Default is a live policy choice; preparation materializes its value and provenance.
        if(config.reasoningEffort===undefined)delete result.reasoningEffort;
        return result;
    }
    async prepareCall(config: LlmCallConfig, signal?: AbortSignal, configure?: ConfigureCall): Promise<PreparedLlmCall> {
        let origin = this.exact.get(config);
        const scope=this.auxiliary?.storage.getStore();
        if(!origin&&scope&&this.remoteProvider(config.provider)){
            const bound=this.auxiliary!.route(scope,config);
            const target=bound.provider===MAIN_PROVIDER?(await this.refresh()).selection:{provider:unvirtual(bound.provider),model:bound.model};
            origin={sessionId:scope.session.id,defaultReasoning:config.reasoningEffort===undefined&&target.reasoningEffort!==undefined,target};
        }
        if (!origin) {
            if (this.remoteProvider(config.provider))
                throw new Error('EXACT_REQUEST_ORIGIN_REQUIRED');
            return super.prepareCall(config, signal, configure);
        }
        let proposed = { ...origin.target, ...controls(config) }, expectedModel;
        if (configure) {
            expectedModel = await (await this.transport!.post('model-info', { provider: origin.target.provider, model: origin.target.model }, signal)).json();
            proposed = { provider: origin.target.provider, model: origin.target.model, ...configure(deepFreeze(controls(config)), deepFreeze(expectedModel)) };
        }
        const releaseSession = await this.channel!.grantSession(origin.sessionId);
        let prepared: any;
        let preparationFailure: unknown;
        try {
            prepared = deepFreeze(await (await this.transport!.post('prepare', { sessionId: origin.sessionId, config: proposed, defaultReasoning: origin.defaultReasoning, ...expectedModel ? { expectedModel } : {} }, signal)).json());
        } catch(error) {
            preparationFailure = error;
            throw error;
        } finally {
            // The prepared lease independently retains its exact session authority.
            try { await releaseSession(); } catch(cleanup) {
                if(preparationFailure)throw new AggregateError([preparationFailure,cleanup],'MAIN_PREPARE_AND_SESSION_RELEASE_FAILED',{cause:preparationFailure});
                throw cleanup;
            }
        }
        let used = false;
        const facade = this, visible = deepFreeze({ ...prepared.config, provider: config.provider, model: config.model });
        let cancellation:Promise<void>|undefined;
        const cancel=()=>cancellation??=(async()=>{const response=await facade.transport!.post('cancel',{sessionId:origin.sessionId,lease:prepared.lease},AbortSignal.timeout(5000));await response.body?.cancel();})();
        const onAbort=()=>{void cancel().catch(error=>facade.ctx.logger.error(error));};
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted){signal.removeEventListener('abort',onAbort);try{await cancel();}catch(cleanup){throw new AggregateError([signal.reason,cleanup],'MAIN_PREPARED_CANCEL_FAILED',{cause:signal.reason});}signal.throwIfAborted();}
        const session=origin.main?this.consumers!.sessions.get(origin.sessionId as never):undefined;
        const pending=session?this.auxiliary!.stage(session,visible,{provider:prepared.config.provider,model:prepared.config.model}):undefined;
        return Object.freeze({ ...prepared, config: visible, retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'spaces.main'), stream(options: GenerateOptions) {
                if (used || !callConfigEquals(options, visible) || options.sessionId!==origin.sessionId)
                    throw new Error('INVALID_PREPARED_CALL');
                used = true;
                return facade.ctx.waterfall(facade, 'llm/stream', options, async function* () {
                    // Transfer cancellation to the stream only when iteration actually starts.
                    signal?.removeEventListener('abort',onAbort);
                    const signals=[signal,options.signal].filter((value):value is AbortSignal=>!!value);
                    const effective=signals.length?AbortSignal.any(signals):undefined;
                    options={...options,...effective?{signal:effective}:{}};
                    let projected: GenerateOptions;
                    try {
                        effective?.throwIfAborted();
                        if(pending)await facade.auxiliary!.publish(session!,pending);
                        projected = await facade.project(options, origin.sessionId);
                    }
                    catch (error) {
                        try {await cancel();}
                        catch(cleanup){throw new AggregateError([error,cleanup],'MAIN_PROJECTION_AND_CANCEL_FAILED',{cause:error});}
                        throw error;
                    }
                    for await (const chunk of facade.transport!.stream(origin.sessionId, prepared, { ...projected, ...prepared.config },cancel)) {
                        if (chunk.type === 'finish' && chunk.replayState)
                            yield { ...chunk, replayState: wrapMainReplay(chunk.replayState, prepared.config.provider, prepared.config.model) };
                        else
                            yield chunk;
                    }
                });
            } });
    }
    async *stream(options: GenerateOptions):AsyncGenerator<StreamChunk> {
        if (!this.remoteProvider(options.provider)) {
            yield* super.stream(options);
            return;
        }
        const config = { provider: options.provider, model: options.model, ...controls(options) };
        const prepared = await this.prepareCall(config, options.signal);
        yield* prepared.stream({ ...options, ...prepared.config });
    }
    async withAuxiliary<T>(session:Session,route:Route|undefined,operation:(bound?:Route)=>Promise<T>):Promise<T>{
        if(!this.auxiliary)return operation(route);
        return this.auxiliary.run(session,route,operation);
    }
    async guardAutomaticCompaction<T>(agent:Agent,operation:()=>Promise<T>):Promise<T>{
        const scope=this.auxiliary?.storage.getStore();
        if(!scope?.automatic||scope.session!==agent.session||this.consumers?.agents.get(agent.id)!==agent){
            const error=new Error('EXACT_AUTOMATIC_COMPACTION_SOURCE_REQUIRED');if(scope?.automatic){scope.failed=true;scope.failure=error;}throw error;
        }
        try{this.automaticFailures.assertClean(agent.session);return await operation();}
        catch(error){scope.failed=true;scope.failure=this.automaticFailures.record(agent.session,error);throw scope.failure;}
    }
    private refs(sessionId: string) { const agent = this.consumers?.agents.get(sessionId as Parameters<Context['agents']['get']>[0]); if (!agent)
        throw new Error('SESSION_NOT_ACTIVE'); return agent.session.snapshotEvents().filter((event: any) => ['user/message', 'developer/message', 'assistant/message', 'tool/result'].includes(event.type)).flatMap((event: any) => event.data?.message?.content ?? event.data?.result?.content ?? event.data?.content ?? []).filter((b: any) => b.type === 'image' || b.type === 'file'); }
    private granted(sessionId: string, ref: any, type: string) { const facts = (r: any) => JSON.stringify(Object.entries(r).filter(([k]) => k !== 'name').sort(([a], [b]) => a.localeCompare(b))); if (!this.refs(sessionId).some((b: any) => b.type === type && facts(b.attachment) === facts(ref)))
        throw new Error('ATTACHMENT_NOT_GRANTED'); }
    private async ownedPath(path: string | undefined, signal?: AbortSignal) { if (!path)
        throw new Error('SOURCE_PATH_MISSING'); const ctx = this.consumers!;if (!ctx.profileContext || !ctx.fs)
        throw new Error('EXACT_CONSUMER_SERVICES_REQUIRED'); assertOwnedProfilePath(ctx.profileContext.home,path);const target = await ctx.fs.resolve(path, { signal }), root = await ctx.fs.resolve(ctx.profileContext.home + '/hub/' + ctx.profileContext.name, { signal }); if (!ctx.fs.contains(root, target))
        throw new Error('SOURCE_PATH_OUTSIDE_SPACE'); return ctx.fs.processPath(target); }
    private async readImage({ sessionId, ref, target }: any, signal: AbortSignal) { this.granted(sessionId, ref, 'image'); const ctx = this.consumers!;if (!ctx.attachments)
        throw new Error('EXACT_CONSUMER_SERVICES_REQUIRED'); const path = await this.ownedPath(ctx.attachments.imageHostPath(ref), signal); if (target === null)
        return { toolPath: path }; const result = await ctx.attachments.readImageRequest(ref, target, signal); signal.throwIfAborted(); return { ...result, data: Buffer.from(result.data).toString('base64'), toolPath: path }; }
    private async project(options: GenerateOptions, sessionId: string) {
        const attachments = this.consumers!.attachments, fs = this.consumers!.fs;
        if (!attachments || !fs)
            throw new Error('EXACT_CONSUMER_SERVICES_REQUIRED');
        for (const message of options.messages)
            for (const block of message.content) {
                if (block.type === 'image')
                    this.granted(sessionId, block.attachment, 'image');
                if (block.type === 'file') {
                    this.granted(sessionId, block.attachment, 'file');
                    await this.ownedPath(attachments.fileHostPath(block.attachment), options.signal);
                    const hash = createHash('sha256');
                    for await (const chunk of attachments.readFileStream(block.attachment, options.signal))
                        hash.update(chunk);
                    if ('sha256:' + hash.digest('hex') !== block.attachment.attachmentId)
                        throw new Error('FILE_INTEGRITY_MISMATCH');
                }
            }
        return { ...options, messages: [...projectFilesToText(options.messages, ref => fs.processPathFromHostPath(attachments.fileHostPath(ref)!))] };
    }
}
export const name = 'dsh-spaces-llm-facade';
export const inject = ['loader'];
export async function apply(ctx: Context) { const facade = new MainLlmFacade(ctx); await facade.initialize(); ctx.inject(['configEditor'], ready => applySpaceBridge(ready)); }
export default { name, inject, apply };
