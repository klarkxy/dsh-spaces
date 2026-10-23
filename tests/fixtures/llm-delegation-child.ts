import {connectOwnedLlmChannel} from '../../packages/llm-bridge/src/delegation-channel.ts';
const channel=await connectOwnedLlmChannel(async (request,signal)=>{signal.throwIfAborted();return {source:channel.bootstrap.spaceId,sessionId:request.sessionId,ref:request.ref};},()=>process.send?.({test:'catalog-updated'}));
let release=await channel.grantSession('owned-session');
process.send?.({test:'bootstrap',value:channel.bootstrap});
process.on('message',(m:any)=>{
  if(m?.test==='close'){channel.dispose();process.disconnect?.();}
  else if(m?.test==='release-session')void release().then(()=>process.send?.({test:'session-released'}));
  else if(m?.test==='grant-session')void channel.grantSession('owned-session').then(value=>{release=value;process.send?.({test:'session-granted'});});
});
