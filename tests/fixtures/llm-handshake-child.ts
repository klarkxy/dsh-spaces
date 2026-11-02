import {LLM_DELEGATION_CHANNEL} from '../../src/shared/llm-delegation.ts';
import {connectOwnedLlmChannel} from '../../packages/llm-bridge/src/delegation-channel.ts';
const scenario=process.argv[2];
const baseline={message:process.listenerCount('message'),disconnect:process.listenerCount('disconnect')};
const deltas=()=>({messageDelta:process.listenerCount('message')-baseline.message,disconnectDelta:process.listenerCount('disconnect')-baseline.disconnect});
const line=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
const done=()=>{try{process.disconnect?.();}catch{}};
const p=connectOwnedLlmChannel(async()=>({}));
if(scenario==='block')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5500);
try{
  const channel=await p;
  line({ok:true});
  channel.dispose();
  done();
}catch(error){
  const settledError=(error as Error).message;
  line({error:settledError,...deltas()});
  if(scenario==='late'){
    await new Promise<void>(resolve=>{
      const late=(m:unknown)=>{
        if(m&&typeof m==='object'&&(m as {channel?:unknown}).channel===LLM_DELEGATION_CHANNEL&&(m as {kind?:unknown}).kind==='bootstrap'){process.off('message',late);resolve();}
      };
      process.on('message',late);
    });
    await new Promise(r=>setTimeout(r,500));
    line({afterLate:true,settledError,...deltas()});
  }
  done();
}
