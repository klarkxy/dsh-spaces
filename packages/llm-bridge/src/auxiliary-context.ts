import {AsyncLocalStorage} from 'node:async_hooks';
import {appendPluginRecord,pluginRecordOf,type Session} from '@deepseek-ai/dsh-session';
import {callConfigEquals,type LlmCallConfig} from '@deepseek-ai/dsh-llm';
import {z} from 'zod';

export type Route={provider:string;model:string};
const route=z.object({provider:z.string().min(1),model:z.string().min(1)}).strict();
const record=z.object({version:z.literal(1),headerSeq:z.number().int().nonnegative(),visible:z.object({provider:z.string(),model:z.string()}).catchall(z.unknown()),native:route}).strict();
type Binding=z.infer<typeof record>;
declare module '@deepseek-ai/dsh-session' {interface PluginRecordMap {'plugin:dsh-spaces/llm-binding':Binding}}
type Pending={visible:LlmCallConfig;native:Route;published?:Promise<Binding>};
export type AuxiliaryScope={session:Session;route?:Route;bound?:Binding;bindingError?:unknown;automatic?:boolean;failed?:boolean;failure?:unknown};

/** Carries an exact public service invocation; a session id alone never creates this context. */
export class AuxiliaryContext {
  readonly storage=new AsyncLocalStorage<AuxiliaryScope>();
  private readonly pending=new WeakMap<Session,Pending>();
  constructor(private readonly live:(session:Session)=>void){}
  stage(session:Session,visible:LlmCallConfig,native:Route){this.live(session);const pending={visible,native};this.pending.set(session,pending);return pending;}
  header(session:Session,config:LlmCallConfig){const pending=this.pending.get(session);if(pending&&callConfigEquals(pending.visible,config))return this.publish(session,pending);}
  publish(session:Session,pending:Pending):Promise<Binding>{
    return pending.published??=(Promise.resolve().then(()=>{
      this.live(session);
      const header=[...session.snapshotEvents()].reverse().find(event=>event.type==='request/header');
      if(!header||!callConfigEquals(header.data.header.config,pending.visible))throw new Error('MAIN_BINDING_HEADER_MISMATCH');
      const binding:Binding={version:1,headerSeq:header.seq,visible:pending.visible as Binding['visible'],native:pending.native};
      appendPluginRecord(session,'plugin:dsh-spaces/llm-binding',binding);return binding;
    }));
  }
  async capture(session:Session,source?:Route):Promise<AuxiliaryScope>{
    this.live(session);
    const pending=this.pending.get(session);
    if(pending?.published)await pending.published;
    const header=[...session.snapshotEvents()].reverse().find(event=>event.type==='request/header');
    const stored=session.snapshotEvents().map(pluginRecordOf).reverse().find(value=>value?.type==='plugin:dsh-spaces/llm-binding');
    let bound:Binding|undefined,bindingError:unknown;
    if(stored){try{bound=record.parse(stored.data);if(!header||bound.headerSeq!==header.seq||!callConfigEquals(bound.visible as LlmCallConfig,header.data.header.config))bound=undefined;}catch(error){bindingError=error;}}
    return {session,route:source,...bound?{bound}:{},...bindingError?{bindingError}:{}};
  }
  route(scope:AuxiliaryScope,requested:Route):Route{
    if(requested.provider==='spaces-main'&&requested.model==='default'&&scope.route?.provider===requested.provider&&scope.route.model===requested.model){
      if(scope.bindingError)throw scope.bindingError;
      if(!scope.bound)throw new Error('MAIN_BINDING_MISSING');
      return {provider:'spaces-main:'+scope.bound.native.provider,model:scope.bound.native.model};
    }
    return requested;
  }
  async run<T>(session:Session,source:Route|undefined,operation:(bound?:Route)=>Promise<T>):Promise<T>{
    const scope=await this.capture(session,source);return this.storage.run(scope,()=>operation(source&&scope.bound?this.route(scope,source):source));
  }
}
