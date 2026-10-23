import {appendPluginRecord,pluginRecordOf,type Session} from '@deepseek-ai/dsh-session';
import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import type {MainLlmFacade} from './main-facade';
import {z} from 'zod';

const failureRecord=z.object({version:z.literal(1),error:z.object({name:z.string(),message:z.string()}).strict()}).strict();
const started=z.object({compactionId:z.string()});
const ended=z.object({compactionId:z.string(),turn:z.number().nullable(),error:z.string().optional()});
type FailureRecord=z.infer<typeof failureRecord>;
declare module '@deepseek-ai/dsh-session' {interface PluginRecordMap {'plugin:dsh-spaces/automatic-compaction-failure':FailureRecord}}

/** A failed automatic operation stays failed for this Session; there is no reset or repair entrypoint. */
export class AutomaticCompactionFailures {
  private readonly failures=new WeakMap<Session,unknown>();
  assertClean(session:Session){
    if(this.failures.has(session))throw this.failures.get(session);
    const events=session.snapshotEvents(),stored=events.map(pluginRecordOf).find(e=>e?.type==='plugin:dsh-spaces/automatic-compaction-failure');
    if(stored){const data=failureRecord.parse(stored.data),error=new Error(data.error.message);error.name=data.error.name;this.failures.set(session,error);throw error;}
    const open=new Set<string>();
    for(const event of events as readonly {type:string;data:unknown}[]){
      if(event.type==='compaction/start')open.add(started.parse(event.data).compactionId);
      if(event.type==='compaction/end'){
        const data=ended.parse(event.data);open.delete(data.compactionId);
        if(data.turn!==null&&data.error!==undefined)throw new Error(data.error);
      }
    }
    if(open.size)throw new Error('AUTOMATIC_COMPACTION_INCOMPLETE');
  }
  record(session:Session,error:unknown){
    if(this.failures.has(session))return this.failures.get(session);
    this.failures.set(session,error);
    try{appendPluginRecord(session,'plugin:dsh-spaces/automatic-compaction-failure',{version:1,error:{name:error instanceof Error?error.name:'Error',message:error instanceof Error?error.message:String(error)}});}
    catch(persistence){const combined=new AggregateError([error,persistence],'AUTOMATIC_COMPACTION_FAILURE_RECORD_FAILED',{cause:error});this.failures.set(session,combined);return combined;}
    return error;
  }
}

type NativeConstructor=new(ctx:Context,config:unknown)=>{compactIfNeeded(agent:Agent,trigger:unknown,signal:AbortSignal):Promise<unknown>};
/** The official class explicitly supports dynamic compactIfNeeded overrides; all engine work remains native. */
export function guardedCompaction(Native:NativeConstructor,llm:MainLlmFacade){
  return class SpacesGuardedCompaction extends Native {
    override compactIfNeeded(agent:Agent,trigger:unknown,signal:AbortSignal){
      return llm.guardAutomaticCompaction(agent,()=>super.compactIfNeeded(agent,trigger,signal));
    }
  };
}
