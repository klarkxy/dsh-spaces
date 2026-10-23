import {Service,type Context} from '@deepseek-ai/cordis';
import type {Session} from '@deepseek-ai/dsh-session';
import type {MainLlmFacade} from './main-facade';
import type {Route} from './auxiliary-context';
import {guardedCompaction} from './automatic-compaction';
import {singleAuxiliaryPolicy} from './auxiliary-policy';

type TitleRequest={session:Session;route?:Route;[key:string]:unknown};
type TitleProvider={generate(request:TitleRequest):Promise<unknown>;[key:string]:unknown};
type Source={llm:MainLlmFacade};
type NativeTitle={register(provider:TitleProvider):()=>Promise<void>};
type Command={name:string;handler:(invocation:any)=>Promise<unknown>;[key:string]:unknown};
type NativeCommands={register(definition:Command):()=>void};
declare module '@deepseek-ai/cordis' {interface Context {spacesAuxiliarySources:Source;spacesTitleSource:{realm:symbol};spacesCommandsSource:{realm:symbol}}}

export const name='spaces-auxiliary-services';
export const inject=['spacesAuxiliarySources','loader'];
class ScopedTitle extends Service {
  constructor(ctx:Context,private readonly realm:symbol,private readonly llm:MainLlmFacade){super(ctx,'sessionTitle');}
  register(provider:TitleProvider){
    const original=this.ctx.isolate('sessionTitle',this.realm).get('sessionTitle') as NativeTitle;
    return original.register({...provider,generate:(request:TitleRequest)=>this.llm.withAuxiliary(request.session,request.route,bound=>provider.generate({...request,...bound?{route:bound}:{}}))});
  }
}
class ScopedCommands extends Service {
  constructor(ctx:Context,private readonly realm:symbol,private readonly llm:MainLlmFacade){super(ctx,'commands');}
  register(definition:Command){
    if(definition.name!=='compact')throw new Error('EXACT_AUXILIARY_COMMAND_REQUIRED');
    const original=this.ctx.isolate('commands',this.realm).get('commands') as NativeCommands;
    return original.register({...definition,handler:invocation=>this.llm.withAuxiliary(invocation.agent.session,invocation.agent.session.requestHeader()?.config,()=>definition.handler(invocation))});
  }
}
/** Each alias owns a new Service identity; it never republishes an existing SDK Service instance. */
export async function apply(ctx:Context,config:{role:'title'|'commands'|'compaction';options?:unknown}){
  if(!['title','commands','compaction'].includes(config.role))throw new Error('INVALID_AUXILIARY_ROLE');
  const {llm}=ctx.spacesAuxiliarySources;
  if(config.role==='compaction'){
    const native=await ctx.loader.import('@deepseek-ai/dsh-compaction-basic');
    if(typeof native.BasicCompactionEngine!=='function')throw new Error('OFFICIAL_COMPACTION_CONTRACT_MISSING');
    await ctx.plugin(guardedCompaction(native.BasicCompactionEngine,llm),singleAuxiliaryPolicy(config.options));return;
  }
  if(config.role==='title')ctx.inject(['spacesTitleSource'],ready=>{new ScopedTitle(ready,ready.spacesTitleSource.realm,llm);});
  else ctx.inject(['spacesCommandsSource'],ready=>{new ScopedCommands(ready,ready.spacesCommandsSource.realm,llm);});
}
export default {name,inject,apply};
