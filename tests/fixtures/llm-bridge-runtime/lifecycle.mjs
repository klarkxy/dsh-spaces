import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file';
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model';
import * as bridge from '../../../packages/llm-bridge/src/plugin.ts';
import { compileManagedCredentialRef, compileManagedRecordKey, compileManagedRouteId } from '../../../src/core/domain/llm-connections.ts';
const testRoot=process.env.DSH_BRIDGE_TEST_ROOT; if(!testRoot) throw new Error('DSH_BRIDGE_TEST_ROOT is required');
const hash=()=>createHash('sha256').update(readFileSync('packages/llm-bridge/src/plugin.ts')).digest('hex');const before=hash();const results={before};
const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';const route=compileManagedRouteId(id);
async function setup(forged=false) {
 const home=mkdtempSync(join(resolve(testRoot),'bridge-edge-'));const ctx=new Context();
 const snapshot={catalogRevision:1,policyRevision:1,adapterVersion:'0.1.5-rc.2',defaultModel:{connectionId:id,modelId:'demo'},connections:[{id,revision:1,displayName:'test',enabled:true,backend:'llm-pi-ai',providerConfig:{api:'openai-completions',baseURL:'http://127.0.0.1:9/v1',models:[{id:'demo'}]},auth:{kind:'api-key',credentialRecordId:compileManagedRecordKey(id,1)},createdAt:'2026-09-21T00:00:00Z',updatedAt:'2026-09-21T00:00:00Z'}]};
 const file=join(home,'snapshot.json');writeFileSync(file,JSON.stringify({schemaVersion:1,snapshot}));const settings=join(home,'settings.yaml');
 if(forged)writeFileSync(settings,JSON.stringify({'llm-pi-ai':{providers:{[route]:{api:'openai-completions',baseURL:'http://127.0.0.1:9999/forged',models:[{id:'demo'}]}}}}));
 await ctx.plugin(FileSettingsProvider,{path:settings,dshHome:home,watch:false});await ctx.plugin(LocalCredentialProvider,{path:join(home,'local-credentials.yaml'),dshHome:home,watch:false});await ctx.plugin(LlmRuntime);
 const addBridge=()=>{process.env.DSH_SPACES_LLM_SNAPSHOT=file; process.env.DSH_SPACES_LLM_HOME=home; return ctx.plugin(bridge.default);};
 return {ctx,addBridge};
}
{
 const {ctx,addBridge}=await setup();
 try {const fiber=await addBridge();await ctx.plugin(PiAi,{providers:{}});await ctx.plugin(AgentDefaultModel,{provider:'composition',model:'baseline'});await new Promise(setImmediate);
  const beforeDispose=ctx.llm.listProviders().some(p=>p.id===route);await fiber.dispose();await new Promise(setImmediate);
  results.lateConsumerBridgeDispose={beforeDispose,providerStillPresent:ctx.llm.listProviders().some(p=>p.id===route),defaultAfterDispose:ctx.agentDefaultModel.currentSelection(),namespaceStillRegistered:ctx.settings.describe().some(s=>s.ns==='llm-pi-ai')};
 }catch(e){results.lateConsumerBridgeDispose={error:e.message};}finally{await ctx.fiber.dispose();}
}
{
 const {ctx,addBridge}=await setup(true);
 try {await ctx.plugin(PiAi,{providers:{}});await ctx.plugin(AgentDefaultModel,{provider:'composition',model:'baseline'});await addBridge();await new Promise(setImmediate);
  const provider=ctx.settings.get('llm-pi-ai').providers[route];let guard;
  try{guard=ctx.waterfall(ctx.llm,'llm/stream',{provider:route},()=> 'allowed-without-dispatch');}catch(e){guard=e.message;}
  results.forgedManagedRoute={baseURL:provider.baseURL,credentialRefIsShared:provider.apiKeyEnv===compileManagedCredentialRef(id,1),guard,providerPresent:ctx.llm.listProviders().some(p=>p.id===route)};
 }catch(e){results.forgedManagedRoute={error:e.message};}finally{await ctx.fiber.dispose();}
}
results.after=hash();results.sourceStable=results.before===results.after;
writeFileSync(join(resolve(testRoot),'bridge-lifecycle-conflict-final-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
