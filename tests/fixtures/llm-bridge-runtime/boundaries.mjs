import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file';
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import * as bridge from '../../../packages/llm-bridge/src/plugin.ts';
import { compileManagedRouteId, LLM_ERROR } from '../../../src/core/domain/llm-connections.ts';
const testRoot=process.env.DSH_BRIDGE_TEST_ROOT; if(!testRoot) throw new Error('DSH_BRIDGE_TEST_ROOT is required');
const hash=()=>createHash('sha256').update(readFileSync('packages/llm-bridge/src/plugin.ts')).digest('hex');const results={before:hash(),directDefaultPlugin:true};
const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';const route=compileManagedRouteId(id);const forged={api:'openai-completions',baseURL:'http://127.0.0.1:9999/forged',models:[{id:'demo'}]};
async function setup(){
 const home=mkdtempSync(join(resolve(testRoot),'bridge-boundary-'));const ctx=new Context();const settingsPath=join(home,'settings.yaml');
 const snapshot={catalogRevision:1,policyRevision:1,adapterVersion:'0.1.5-rc.2',defaultModel:null,connections:[{id,revision:1,displayName:'test',enabled:true,backend:'llm-pi-ai',providerConfig:{api:'openai-completions',baseURL:'http://127.0.0.1:9/v1',models:[{id:'demo'}]},auth:{kind:'none'},createdAt:'2026-09-21T00:00:00Z',updatedAt:'2026-09-21T00:00:00Z'}]};
 const file=join(home,'snapshot.json');writeFileSync(file,JSON.stringify({schemaVersion:1,snapshot}));
 await ctx.plugin(FileSettingsProvider,{path:settingsPath,dshHome:home,watch:false});await ctx.plugin(LocalCredentialProvider,{path:join(home,'local-credentials.yaml'),dshHome:home,watch:false});await ctx.plugin(LlmRuntime);await ctx.plugin(PiAi,{providers:{}});
 process.env.DSH_SPACES_LLM_SNAPSHOT=file; process.env.DSH_SPACES_LLM_HOME=home; await ctx.plugin(bridge.default);
 return {ctx,settingsPath};
}
for(const [label,ops] of [['sectionRoot',[{op:'set',path:[],value:{providers:{[route]:forged}}}]],['providersRoot',[{op:'set',path:['providers'],value:{[route]:forged}}]]]) {
 const {ctx,settingsPath}=await setup();
 try{const prior=existsSync(settingsPath)?readFileSync(settingsPath,'utf8'):null;await assert.rejects(async()=>ctx.settings.mutate('llm-pi-ai',ops),{code:LLM_ERROR.SHARED_CONNECTION_READ_ONLY});assert.equal(existsSync(settingsPath)?readFileSync(settingsPath,'utf8'):null,prior);results[label]={rejected:true,noFileChange:true};}finally{await ctx.fiber.dispose();}
}
{
 const {ctx,settingsPath}=await setup();
 try{ctx.settings.publish({'llm-pi-ai':{providers:{[route]:forged}}},'provider');let calls=0;
  await assert.rejects(async()=>ctx.waterfall(ctx.llm,'llm/stream',{provider:route},()=>{calls++;return 'would-dispatch';}),{code:LLM_ERROR.MANAGED_ROUTE_CONFLICT});assert.equal(calls,0);results.runtimeRawConflict={rejected:true,nextCalls:calls};
 }finally{await ctx.fiber.dispose();}
}
{
 const {ctx}=await setup();
 try{await ctx.credentials.set('REVIEW_LOCAL_KEY','local-fixture');assert.equal((await ctx.credentials.resolve('REVIEW_LOCAL_KEY')).value,'local-fixture');assert.equal((await ctx.credentials.describe('REVIEW_LOCAL_KEY')).configured,true);await ctx.credentials.unset('REVIEW_LOCAL_KEY');assert.equal(await ctx.credentials.resolve('REVIEW_LOCAL_KEY'),undefined);
 await ctx.credentials.modifyRecord('review/local',async()=>({kind:'api-key',key:'local-record-fixture'}));assert.equal((await ctx.credentials.readRecord('review/local')).key,'local-record-fixture');assert.equal((await ctx.credentials.describeRecord('review/local')).configured,true);await ctx.credentials.deleteRecord('review/local');assert.equal(await ctx.credentials.readRecord('review/local'),undefined);results.localDelegation={referenceReadWrite:true,recordReadWrite:true};
 }finally{await ctx.fiber.dispose();}
}
results.after=hash();results.sourceStable=results.before===results.after;
writeFileSync(join(resolve(testRoot),'bridge-boundary-final-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
