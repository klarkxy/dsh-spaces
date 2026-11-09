import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {MainLlmFacade} from '../../packages/llm-bridge/src/main-facade.ts';
import {AgentModel,type ModelSelection,type ModelSelectionProjectionState} from '@deepseek-ai/dsh-agent';
import {ReasoningEffortId} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-compaction-basic';
import {Session,SessionId,pluginRecordOf} from '@deepseek-ai/dsh-session';
import {guardedCompaction} from '../../packages/llm-bridge/src/automatic-compaction.ts';
const ctx=new Context(),before={message:process.listenerCount('message'),disconnect:process.listenerCount('disconnect')};
const agent={id:SessionId('owned-session'),session:Session.create(SessionId('owned-session')),options:{provider:'spaces-main',model:'default'}};
const healthy={...agent,id:SessionId('healthy-session'),session:Session.create(SessionId('healthy-session'))};
ctx.provide('agents',{get:(id:string)=>id==='owned-session'?agent:id===healthy.id?healthy:undefined} as never);
ctx.provide('sessions',{get:(id:string)=>id==='owned-session'?agent.session:id===healthy.id?healthy.session:undefined} as never);
ctx.provide('attachments',{} as never);ctx.provide('fs',{} as never);ctx.provide('profileContext',{home:'/isolated',name:'space-a'} as never);
const facade=new MainLlmFacade(ctx);
try{
  if(process.env.FACADE_TEST_MODE==='refused'){
    await assert.rejects(facade.initialize(),/DENIED/);
    assert.equal(process.listenerCount('message'),before.message);assert.equal(process.listenerCount('disconnect'),before.disconnect);
    process.send?.({test:'initialized-failure-clean'});
    await new Promise<void>(r=>setTimeout(r,80));
    assert.equal(process.listenerCount('message'),before.message);
  }else if(process.env.FACADE_TEST_MODE==='prepare-refused'){
    await facade.initialize();
    const config=await ctx.waterfall('agent/request',{agent} as never,()=>Promise.resolve({provider:'spaces-main',model:'default'}));
    await assert.rejects(facade.prepareCall(config),/PREPARE_DENIED/);
  }else{
    await facade.initialize();
    let recoveries=0;
    const recovery=ctx.on('compaction/summary-error',()=>{recoveries++;return true;});
    assert.equal(ctx.waterfall('compaction/summary-error',{session:agent.session,sourceEventSeqs:[],error:new Error('NO_RECOVERY')},()=>true),false);
    assert.equal(recoveries,0);recovery();
    // Exercise the public waterfall and freeze path; the registry supplies the exact Agent identity.
    const proposal={provider:'spaces-main:chosen',model:'assembled',reasoningEffort:ReasoningEffortId('high'),temperature:0.25,maxTokens:17,stop:['END']};
    const summary={...proposal,purpose:'compaction' as const,sessionId:agent.id,messages:[]};
    const oldRoute={provider:'spaces-main',model:'default'};
    agent.session.append('request/header',{reason:'initial',header:{config:oldRoute}});
    let ordinary=false;await ctx.waterfall('agent/pre-step',{agent} as never,async()=>{ordinary=true;return {kind:'enter' as const,messages:[]};});assert.equal(ordinary,true);
    await assert.rejects(async()=>{for await(const _ of ctx.llm.stream(summary)){}},/EXACT_REQUEST_ORIGIN_REQUIRED/);
    await assert.rejects(facade.withAuxiliary(Session.create(agent.id),proposal,async()=>{}),/EXACT_SESSION_ORIGIN_REQUIRED/);
    await facade.withAuxiliary(agent.session,oldRoute,async()=>{
      await assert.rejects(async()=>{for await(const _ of ctx.llm.stream({...summary,...oldRoute})){}},/MAIN_BINDING_MISSING/);
      const chunks=[];for await(const chunk of ctx.llm.stream(summary))chunks.push(chunk);
      assert.equal(chunks.at(-1)?.type,'finish');
    });
    const ordinaryConfig=await ctx.waterfall('agent/request',{agent} as never,()=>Promise.resolve({...proposal,...oldRoute}));
    const ordinaryPrepared=await facade.prepareCall(ordinaryConfig);
    agent.session.append('request/header',{reason:'change',header:{config:ordinaryPrepared.config}});
    for await(const _ of ordinaryPrepared.stream({...ordinaryPrepared.config,sessionId:agent.id,messages:[]})){}
    const binding=agent.session.snapshotEvents().map(pluginRecordOf).find(e=>e?.type==='plugin:dsh-spaces/llm-binding');
    assert.equal((binding?.data as any).native.provider,'main-default');
    const local={provider:'local',model:'assembled-local',temperature:0.4};
    for(const input of [local,proposal]){
      const dispose=ctx.on('agent/request',async(_payload,next)=>{await next();return Object.freeze(input);});
      const resolved=await ctx.waterfall('agent/request',{agent} as never,()=>Promise.resolve({provider:'spaces-main',model:'default'}));dispose();
      assert.equal(resolved.provider,input.provider);assert.equal(resolved.model,input.model);
      if(input===local)assert.strictEqual(resolved,local);
      else{assert.equal(resolved.temperature,0.25);assert.equal(resolved.maxTokens,17);assert.deepEqual(resolved.stop,['END']);const prepared=await facade.prepareCall(resolved);assert.equal(prepared.config.maxTokens,17);}
    }
    let projection:ModelSelectionProjectionState={lastUsed:null,pending:{provider:'spaces-main:chosen',model:'assembled',reasoningEffort:ReasoningEffortId('high')}};
    const model=new AgentModel(()=>projection,agent.session,agent.options as never);
    // Mirror the retired ModelSelectionRef contract: prompt assembly snapshots
    // the selection, request routing applies the assembled value. The rc.1
    // AgentModel records durable choices but no longer couples them to the
    // agent/request waterfall, so the fixture reproduces the captured step.
    const selection:{current:ModelSelection|undefined;assembled:ModelSelection|undefined}={current:{provider:'spaces-main:chosen',model:'assembled',reasoningEffort:ReasoningEffortId('high')},assembled:undefined};
    const disposeSelection=ctx.on('agent/request',async(_payload,next)=>{
      const resolved=await next();
      const selected=selection.assembled;
      if(selected===void 0)return resolved;
      const {reasoningEffort:_inherited,...without}=resolved as unknown as Record<string,unknown>;
      return {...without,provider:selected.provider,model:selected.model,...selected.reasoningEffort===undefined?{}:{reasoningEffort:selected.reasoningEffort}};
    });
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);let entered!:()=>void;const paused=new Promise<void>(r=>entered=r);
    const assembling=(ctx.waterfall as any)('system-prompt/assemble',{}, {},async()=>{entered();selection.assembled=selection.current;await gate;return {variables:{}};});
    await paused;model.select({provider:'spaces-main',model:'default'});selection.current={provider:'spaces-main',model:'default'};release();await assembling;
    const config=await ctx.waterfall('agent/request',{agent} as never,()=>Promise.resolve({...proposal,provider:'spaces-main',model:'default'}));
    assert.equal(config.provider,'spaces-main:chosen');assert.equal(config.model,'assembled');assert.equal(config.reasoningEffort,'high');
    await facade.prepareCall(config);disposeSelection();
    const canceled=new Promise<void>((accept,reject)=>{const timer=setTimeout(()=>reject(new Error('PREPARED_CANCEL_TIMEOUT')),3000);const receive=(m:any)=>{if(m?.test==='cancel-confirmed'){clearTimeout(timer);process.off('message',receive);accept();}};process.on('message',receive);});
    const abort=new AbortController();await facade.prepareCall(config,abort.signal);abort.abort(new Error('NO_STREAM_ITERATION'));await canceled;abort.abort();
    process.send?.({test:'proposal-preserved'});
    const original=new Error('BEFORE_COMPACTION_START');let failedAttempts=0,healthyAttempts=0,dispatched=0;
    class NativeProbe {
      constructor(ready:Context){ready.on('agent/pre-step',async({agent:owner}:any,next:any)=>{try{await this.compactIfNeeded(owner);}catch{}return next();});}
      async compactIfNeeded(owner:any){if(owner===agent){failedAttempts++;throw original;}healthyAttempts++;return null;}
    }
    await ctx.plugin(guardedCompaction(NativeProbe as never,facade),{});
    for(let index=0;index<2;index++)await assert.rejects(async()=>{await ctx.waterfall('agent/pre-step',{agent} as never,async()=>({kind:'enter' as const,messages:[]}));dispatched++;},error=>error===original);
    assert.equal(failedAttempts,1);assert.equal(dispatched,0);
    await ctx.waterfall('agent/pre-step',{agent:healthy} as never,async()=>({kind:'enter' as const,messages:[]}));assert.equal(healthyAttempts,1);
  }
}catch(error){process.send?.({test:'failed',error:String(error),stack:(error as Error).stack});process.exitCode=1;}
finally{await ctx.fiber.dispose();process.disconnect?.();}
