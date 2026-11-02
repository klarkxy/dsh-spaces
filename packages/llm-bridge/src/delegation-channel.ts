import { randomUUID } from 'node:crypto';
import { LLM_DELEGATION_CHANNEL, type LlmDelegationBootstrap } from '../../../src/shared/llm-delegation';

export type DelegatedImageReader = (request: {sessionId:string;ref:unknown;target:unknown}, signal: AbortSignal) => Promise<unknown>;
/** One IPC lifetime. Never reconnects, reissues hello, or infers another source. */
export async function connectOwnedLlmChannel(readImage: DelegatedImageReader, catalogUpdated?:()=>void): Promise<{
  bootstrap: LlmDelegationBootstrap;
  grantSession(sessionId: string): Promise<() => Promise<void>>;
  dispose(): void;
}> {
  if (!process.connected || !process.send) throw new Error('OWNED_SUPERVISOR_IPC_REQUIRED');
  let closed=false;
  let acceptHello!: (value:LlmDelegationBootstrap)=>void, rejectHello!: (error:Error)=>void;
  const hello={promise:new Promise<LlmDelegationBootstrap>((resolve,reject)=>{acceptHello=resolve;rejectHello=reject;}),resolve:(value:LlmDelegationBootstrap)=>acceptHello(value),reject:(error:Error)=>rejectHello(error)};
  const sessions=new Map<string,{resolve():void;reject(error:Error):void}>();
  const images=new Map<string,AbortController>();
  let confirm:ReturnType<typeof setImmediate>|undefined;
  const stopTimeout=()=>{clearTimeout(timer);clearImmediate(confirm);};
  const timer=setTimeout(()=>{confirm=setImmediate(()=>hello.reject(new Error('SUPERVISOR_BOOTSTRAP_TIMEOUT')));},5000);
  const fail=()=>{
    if(closed)return;closed=true;stopTimeout();hello.reject(new Error('SUPERVISOR_DISCONNECTED'));
    process.off('message',receive);process.off('disconnect',fail);
    for(const p of sessions.values())p.reject(new Error('SUPERVISOR_DISCONNECTED'));sessions.clear();
    for(const c of images.values())c.abort();images.clear();
  };
  const receive=(raw:unknown)=>{
    if(closed||!raw||typeof raw!=='object'||(raw as {channel?:unknown}).channel!==LLM_DELEGATION_CHANNEL)return;
    const m=raw as Record<string,unknown>;
    if(m.kind==='bootstrap'){
      if(typeof m.origin!=='string'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(m.origin)||typeof m.bearer!=='string'||!/^[a-f0-9]{64}$/.test(m.bearer)||
        typeof m.spaceId!=='string'||typeof m.generation!=='number'||!Number.isInteger(m.generation)||m.generation<1||typeof m.serviceEpoch!=='string'||typeof m.instanceId!=='string'){
        hello.reject(new Error('INVALID_SUPERVISOR_BOOTSTRAP'));fail();return;
      }
      stopTimeout();hello.resolve(m as unknown as LlmDelegationBootstrap);
    }else if(m.kind==='catalog-updated'){catalogUpdated?.();}
    else if(m.kind==='refused'){hello.reject(new Error('SUPERVISOR_REFUSED'));}
    else if((m.kind==='session-granted'||m.kind==='session-refused')&&typeof m.requestId==='string'){
      const p=sessions.get(m.requestId);if(!p)return;sessions.delete(m.requestId);
      m.kind==='session-granted'?p.resolve():p.reject(new Error('SESSION_REFUSED'));
    }else if(m.kind==='image-cancel'&&typeof m.requestId==='string'){images.get(m.requestId)?.abort();}
    else if(m.kind==='image-read'&&typeof m.requestId==='string'){
      const requestId=m.requestId;if(images.has(requestId)||images.size>=32)return;
      const abort=new AbortController();images.set(requestId,abort);
      void (async()=>{
        try{const value=await readImage(m.input as Parameters<DelegatedImageReader>[0],abort.signal);abort.signal.throwIfAborted();
          if(!closed)process.send?.({channel:LLM_DELEGATION_CHANNEL,kind:'image-result',requestId,value});
        }catch{if(!closed)process.send?.({channel:LLM_DELEGATION_CHANNEL,kind:'image-result',requestId,error:'IMAGE_REFUSED'});}
        finally{images.delete(requestId);}
      })();
    }
  };
  process.on('message',receive);process.once('disconnect',fail);
  process.send({channel:LLM_DELEGATION_CHANNEL,kind:'hello'},error=>{if(error)hello.reject(error);});
  let bootstrap:LlmDelegationBootstrap;
  try{bootstrap=await hello.promise;}catch(error){fail();throw error;}
  return {bootstrap,dispose:fail,async grantSession(sessionId){
    if(closed)throw new Error('SUPERVISOR_DISCONNECTED');
    const requestId=randomUUID();
    let release: Promise<void> | undefined;
    const releaseSession = () => release ??= new Promise<void>((resolve,reject) => {
      if(closed || !process.send) { reject(new Error('SUPERVISOR_DISCONNECTED')); return; }
      process.send({channel:LLM_DELEGATION_CHANNEL,kind:'session-release',sessionId,requestId},error=>error?reject(error):resolve());
    });
    try { await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{sessions.delete(requestId);reject(new Error('SESSION_GRANT_TIMEOUT'));},5000);
      sessions.set(requestId,{resolve(){clearTimeout(timer);resolve();},reject(error){clearTimeout(timer);reject(error);}});
      process.send?.({channel:LLM_DELEGATION_CHANNEL,kind:'session',requestId,sessionId},error=>{
        if(error){sessions.get(requestId)?.reject(error);sessions.delete(requestId);}
      });
    }); } catch(error) {
      // A late grant after a timeout must not consume a slot for the process lifetime.
      if(!closed)try { await releaseSession(); } catch(cleanup) { throw new AggregateError([error,cleanup],'SESSION_GRANT_AND_RELEASE_FAILED',{cause:error}); }
      throw error;
    }
    return releaseSession;
  }};
}
