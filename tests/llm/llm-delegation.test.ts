import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fork,type ChildProcess} from 'node:child_process';
import {createServer,type Server,type ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import {once, EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import {SupervisorLlmDelegation,LLM_DELEGATION_PREFIX} from '../../src/adapters/node/llm/delegation.ts';
import type {LlmDelegationBootstrap} from '../../src/shared/llm-delegation.ts';
import {wrapMainReplay,unwrapMainReplay} from '../../src/shared/llm-replay-route.ts';
import {Context} from '@deepseek-ai/cordis';
import {LlmAdapter,type LlmResolvedModelInfo} from '@deepseek-ai/dsh-llm';
import {MainLlmFacade} from '../../packages/llm-bridge/src/main-facade.ts';
import {MainTransport} from '../../packages/llm-bridge/src/main-transport.ts';
import {MainLlmService} from '../../packages/plugin/src/host/llm-main.ts';
import {LLM_DELEGATION_CHANNEL} from '../../src/shared/llm-delegation.ts';
import {Session,SessionId,appendPluginRecord} from '@deepseek-ai/dsh-session';
import {AuxiliaryContext} from '../../packages/llm-bridge/src/auxiliary-context.ts';
import {singleAuxiliaryPolicy,scopeAuxiliaryCommands} from '../../packages/llm-bridge/src/auxiliary-policy.ts';
import {AutomaticCompactionFailures} from '../../packages/llm-bridge/src/automatic-compaction.ts';

test('Supervisor session grants release by request while preserving concurrent grants', async () => {
  const replies:any[]=[];
  const child=Object.assign(new EventEmitter(),{connected:true,send(value:unknown){replies.push(value);return true;}}) as unknown as ChildProcess;
  const broker=new SupervisorLlmDelegation({home:'unused',origin:()=> 'http://127.0.0.1:1234',epoch:()=> 'epoch',hostBearerEquals:()=>true,assertOwner(){},assertSource(){},assertMainProfile(){},assertAllowedSpace(){}});
  broker.attachChild('space-a',child,1);
  const send=(kind:string,sessionId:string,requestId:string)=>child.emit('message',{channel:LLM_DELEGATION_CHANNEL,kind,sessionId,requestId});
  child.emit('message',{channel:LLM_DELEGATION_CHANNEL,kind:'hello'});
  try {
    for(let i=0;i<300;i++) {
      send('session',`session-${i}`,`request-${i}`);
      assert.equal(replies.at(-1).kind,'session-granted');
      send('session-release',`session-${i}`,`request-${i}`);
    }
    send('session','shared','first');send('session','shared','second');
    send('session-release','shared','first');send('session-release','shared','first');
    for(let i=0;i<255;i++)send('session',`active-${i}`,`active-${i}`);
    send('session','over-limit','over-limit');assert.equal(replies.at(-1).kind,'session-refused');
    send('session-release','shared','wrong-request');
    send('session','still-over-limit','still-over-limit');assert.equal(replies.at(-1).kind,'session-refused');
    send('session-release','shared','second');
    send('session','after-release','after-release');assert.equal(replies.at(-1).kind,'session-granted');
  } finally { await broker.close(); }
});

test('automatic failure is durable, isolated and refuses unknown open compaction',()=>{
  const session=Session.create(SessionId('automatic-failed')),other=Session.create(SessionId('automatic-healthy')),failures=new AutomaticCompactionFailures(),error=new Error('original automatic failure');
  assert.strictEqual(failures.record(session,error),error);assert.throws(()=>failures.assertClean(session),value=>value===error);failures.assertClean(other);
  const restored=Session.create(session.id,JSON.parse(JSON.stringify(session.snapshotEvents())));
  assert.throws(()=>new AutomaticCompactionFailures().assertClean(restored),/original automatic failure/);
  (other.append as any)('compaction/start',{compactionId:'open',turn:1});assert.throws(()=>failures.assertClean(other),/INCOMPLETE/);
});

test('auxiliary bindings survive official replay and remain isolated across concurrent calls',async()=>{
  let live=Session.create(SessionId('binding-owner'));
  const scopes=new AuxiliaryContext(session=>assert.strictEqual(session,live));
  const visible={provider:'spaces-main',model:'default',maxTokens:21};
  live.append('request/header',{reason:'initial',header:{config:visible}});
  const missing=await scopes.capture(live,visible);
  assert.throws(()=>scopes.route(missing,visible),/MAIN_BINDING_MISSING/);
  assert.equal(await scopes.run(live,visible,async()=> 'ordinary step'),'ordinary step');
  assert.deepEqual(scopes.route(missing,{provider:'spaces-main:explicit',model:'chosen'}),{provider:'spaces-main:explicit',model:'chosen'});
  const first=scopes.stage(live,visible,{provider:'native-a',model:'a'});await scopes.publish(live,first);
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const pending=scopes.run(live,visible,async bound=>{entered();await gate;assert.equal(scopes.storage.getStore()?.bound?.native.provider,'native-a');return bound;});
  await ready;
  const second=scopes.stage(live,visible,{provider:'native-b',model:'b'});await scopes.publish(live,second);
  assert.equal((await scopes.run(live,visible,async bound=>bound))?.provider,'spaces-main:native-b');
  release();assert.equal((await pending)?.provider,'spaces-main:native-a');
  const seed=JSON.parse(JSON.stringify(live.snapshotEvents()));live=Session.create(SessionId('binding-owner'),seed);
  assert.equal((await scopes.capture(live,visible)).bound?.native.provider,'native-b');
  const forged=Session.create(SessionId('binding-owner'),seed);await assert.rejects(scopes.capture(forged,visible));
  live.append('request/header',{reason:'change',header:{config:{...visible,maxTokens:22}}});
  const stale=await scopes.capture(live,visible);assert.throws(()=>scopes.route(stale,visible),/MAIN_BINDING_MISSING/);
  appendPluginRecord(live,'plugin:dsh-spaces/llm-binding',{version:99} as never);
  const corrupt=await scopes.capture(live,visible);assert.throws(()=>scopes.route(corrupt,visible));
  assert.equal(await scopes.run(live,visible,async()=> 'explicit can decide'),'explicit can decide');
});

test('main auxiliary policy rejects overflow recovery and replay helper accepts plain summary instructions',()=>{
  assert.deepEqual(singleAuxiliaryPolicy(undefined),{compactionRetries:0,maxOverflowRetries:0});
  assert.deepEqual(singleAuxiliaryPolicy({auto:true,maxTokens:33}),{auto:true,maxTokens:33,compactionRetries:0,maxOverflowRetries:0});
  assert.throws(()=>singleAuxiliaryPolicy({maxOverflowRetries:1}),/RETRIES_UNSUPPORTED/);
  assert.throws(()=>singleAuxiliaryPolicy({modelPolicies:[{provider:'p',model:'m',compactionRetries:1}]}),/RETRIES_UNSUPPORTED/);
  const instruction={role:'user',content:[{type:'text',text:'summarize'}]};assert.strictEqual(unwrapMainReplay(instruction as never),instruction);
  const original={plugins:[{group:true,config:[{id:'compact',name:'@deepseek-ai/dsh-command-compact',isolate:{compaction:true}},{name:'other'}]}]};
  const scoped=scopeAuxiliaryCommands(original) as typeof original;
  assert.equal((scoped.plugins[0].config[0].isolate as any).commands,'spaces-aux-commands');
  assert.equal(scoped.plugins[0].config[0].isolate?.compaction,true);
  assert.equal((original.plugins[0].config[0].isolate as any).commands,undefined);
  assert.throws(()=>scopeAuxiliaryCommands({plugins:[{name:'@deepseek-ai/dsh-command-compact',isolate:{commands:'foreign'}}]}),/REALM_CONFLICT/);
});

test('facade preserves downstream proposals and disposes a refused initialization',async t=>{
  for(const mode of ['normal','refused','prepare-refused'])await t.test(mode,async()=>{
    let hello=0,describes=0,prepares=0,cancels=0,grants=0,releases=0;let child:ChildProcess;
    const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader('content-type','application/json');
      if(req.url?.endsWith('/describe')){describes++;res.writeHead(mode==='refused'?403:200);res.end(JSON.stringify(mode==='refused'?{error:'DENIED'}:{providers:[{id:'chosen',name:'Chosen'}],models:[],selection:{provider:'main-default',model:'other',reasoningEffort:'low'}}));}
      else if(req.url?.endsWith('/prepare')){prepares++;if(mode==='prepare-refused'){res.writeHead(403);res.end('{"error":"PREPARE_DENIED"}');return;}if(input.config.provider==='main-default')assert.equal(input.config.model,'other');else{assert.equal(input.config.provider,'chosen');assert.equal(input.config.model,'assembled');}assert.equal(input.config.temperature,0.25);assert.equal(input.config.reasoningEffort,'high');assert.equal(input.config.maxTokens,17);assert.deepEqual(input.config.stop,['END']);res.end(JSON.stringify({config:input.config,lease:'b'.repeat(64),adapterDefaults:{}}));}
      else if(req.url?.endsWith('/cancel')){cancels++;assert.equal(input.sessionId,'owned-session');assert.equal(input.lease,'b'.repeat(64));res.end('{}');child.send({test:'cancel-confirmed'});}
      else if(req.url?.endsWith('/stream')){res.setHeader('content-type','application/x-ndjson');res.end('{"type":"finish","reason":{"kind":"stop"}}\n');}
      else{res.writeHead(404);res.end('{}');}
    });server.listen(0,'127.0.0.1');await once(server,'listening');
    try{
      const outcome=new Promise<void>((accept,reject)=>{
        child=fork(resolve('tests/fixtures/llm-facade-child.ts'),[],{env:{...process.env,DSH_SPACES_LLM_INHERIT_MAIN:'1',FACADE_TEST_MODE:mode},stdio:['ignore','ignore','pipe','ipc']});
        child.on('message',(m:any)=>{if(m?.channel===LLM_DELEGATION_CHANNEL&&m.kind==='hello'){hello++;child.send({channel:LLM_DELEGATION_CHANNEL,kind:'bootstrap',origin:`http://127.0.0.1:${(server.address() as {port:number}).port}`,bearer:'a'.repeat(64),spaceId:'space-a',generation:1,instanceId:'instance',serviceEpoch:'epoch'});}
          else if(m?.channel===LLM_DELEGATION_CHANNEL&&m.kind==='session'){grants++;child.send({...m,kind:'session-granted'});}
          else if(m?.channel===LLM_DELEGATION_CHANNEL&&m.kind==='session-release')releases++;
          else if(m?.test==='initialized-failure-clean')child.send({channel:LLM_DELEGATION_CHANNEL,kind:'catalog-updated'});
          else if(m?.test==='failed')reject(new Error(m.error+'\n'+m.stack));});
        child.once('error',reject);child.once('exit',code=>code===0?accept():reject(new Error('FACADE_CHILD_EXIT:'+code)));
      });await outcome;assert.equal(hello,1);assert.equal(prepares,mode==='normal'?5:mode==='prepare-refused'?1:0);assert.equal(describes,mode==='normal'?4:mode==='prepare-refused'?2:1);assert.equal(cancels,mode==='normal'?1:0);
      assert.equal(grants,prepares);assert.equal(releases,grants);
    }finally{if(child!?.connected){child!.kill();await once(child!,'exit');}server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });
});

test('pre-dispatch cancellation is exact and cancellation failure preserves both errors',async()=>{
  for(const rejectCancel of [false,true]){
    let streams=0,cancels=0;const lease='b'.repeat(64),server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString());assert.equal(input.lease,lease);assert.equal(input.sessionId,'owned');
      if(req.url?.endsWith('/stream')){streams++;req.socket.destroy();return;}cancels++;res.writeHead(rejectCancel?503:200,{'content-type':'application/json'});res.end(JSON.stringify(rejectCancel?{error:'CANCEL_REFUSED'}:{canceled:true}));});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const transport=new MainTransport({origin:`http://127.0.0.1:${(server.address() as {port:number}).port}`,bearer:'a'.repeat(64),spaceId:'space-a',generation:1,instanceId:'instance',serviceEpoch:'epoch'});
    try{for(const preAborted of [true,false]){const abort=new AbortController();if(preAborted)abort.abort(new Error('PRE_CANCELED'));
      await assert.rejects(async()=>{for await(const _ of transport.stream('owned',{lease} as never,{provider:'test',model:'model',messages:[],signal:abort.signal})){}},error=>{if(rejectCancel){assert.ok(error instanceof AggregateError);assert.equal(error.errors.length,2);assert.match(String(error.errors[1]),/CANCEL_REFUSED/);}else if(preAborted)assert.match(String(error),/PRE_CANCELED/);return true;});}
      assert.equal(streams,1);assert.equal(cancels,2);
    }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  }
});

test('production main listener releases a refused registration and accepts cancel while disposing',async t=>{
  async function setup(refused:boolean){
    let registered:any,aborted=false;const ctx=new Context();
    ctx.provide('attachments',{} as never);ctx.provide('fs',{} as never);ctx.provide('profileContext',{home:'/isolated-test-home',name:'main'} as never);
    ctx.provide('llm',{prepareCall:async(config:any,signal:AbortSignal)=>{signal.addEventListener('abort',()=>{aborted=true;},{once:true});return {config,adapterDefaults:{},retryPolicy:{mode:'normal',maxRetries:0},stream:async function*(){}};}} as never);
    const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString());
      if(req.url?.endsWith('/register')){registered=input;res.writeHead(refused?409:200,{'content-type':'application/json'});res.end(JSON.stringify({registrationId:'registration'}));return;}
      if(req.url?.endsWith('/unregister')){const canceled=await fetch(registered.origin+'/cancel',{method:'POST',headers:{authorization:`Bearer ${registered.bearer}`},body:JSON.stringify({requestId:'prepared-request',sessionId:'owned'})});assert.equal(canceled.status,200);await canceled.body?.cancel();res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
      res.writeHead(404);res.end();
    });server.listen(0,'127.0.0.1');await once(server,'listening');
    const service=new MainLlmService(ctx),endpoint={origin:`http://127.0.0.1:${(server.address() as {port:number}).port}`,bearer:'a'.repeat(64),serviceEpoch:'epoch',homeId:'home',protocolVersion:2} as const;
    return {service,endpoint,registered:()=>registered,aborted:()=>aborted,async close(){await service.close().catch(()=>{});await ctx.fiber.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
  }
  await t.test('refused registration leaves no listening endpoint',async()=>{const h=await setup(true);try{await assert.rejects(h.service.attach(h.endpoint),/MAIN_REGISTRATION_REFUSED/);await assert.rejects(fetch(h.registered().origin+'/identity'));}finally{await h.close();}});
  await t.test('unregister can cancel the exact main request during close',async()=>{const h=await setup(false);try{await h.service.attach(h.endpoint);const r=await fetch(h.registered().origin+'/prepare',{method:'POST',headers:{authorization:`Bearer ${h.registered().bearer}`},body:JSON.stringify({requestId:'prepared-request',sessionId:'owned',config:{provider:'test',model:'model'}})});assert.equal(r.status,200);await r.body?.cancel();await h.service.close();assert.equal(h.aborted(),true);}finally{await h.close();}});
});

test('main registration stays failed until an explicit confirmed service replacement', async () => {
  const ctx = new Context();
  ctx.provide('attachments', {} as never); ctx.provide('fs', {} as never);
  ctx.provide('profileContext', { home: '/isolated-restart-home', name: 'desktop' } as never);
  const registrations: { origin: string; bearer: string }[] = [];
  let refuse = true;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url?.endsWith('/register')) registrations.push(input);
    res.writeHead(refuse ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ registrationId: 'new-registration' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const service = new MainLlmService(ctx);
  const endpoint = { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bearer: 'a'.repeat(64), serviceEpoch: 'old', homeId: 'home', protocolVersion: 2 } as const;
  try {
    await assert.rejects(service.attach(endpoint), /404/);
    refuse = false;
    await assert.rejects(service.attach(endpoint), /404/); assert.equal(registrations.length, 1);
    await assert.rejects(service.afterSupervisorStopped('foreign'), /CHANGED/);
    await service.afterSupervisorStopped('old');
    await service.attach({ ...endpoint, serviceEpoch: 'new' });
    assert.equal(registrations.length, 2); assert.notEqual(registrations[0].bearer, registrations[1].bearer);
    await service.attach({ ...endpoint, serviceEpoch: 'new' }); assert.equal(registrations.length, 2);
  } finally { await service.close(); await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('legacy local provider names remain native when main inheritance is disabled',async()=>{
  const prior=process.env.DSH_SPACES_LLM_INHERIT_MAIN;delete process.env.DSH_SPACES_LLM_INHERIT_MAIN;
  const ctx=new Context();try{
    class Local extends LlmAdapter{async resolveModel(provider:string,model:string):Promise<LlmResolvedModelInfo>{return {provider,id:model,name:model};}async *stream(){yield {type:'finish' as const,reason:{kind:'stop' as const}};}}
    const facade=new MainLlmFacade(ctx);await facade.initialize();facade.registerAdapter(['spaces-main'],new Local());
    assert.equal((await facade.resolveModelInfo('spaces-main','local')).id,'local');assert.equal((await facade.prepareCall({provider:'spaces-main',model:'local'})).config.model,'local');
  }finally{await ctx.fiber.dispose();if(prior===undefined)delete process.env.DSH_SPACES_LLM_INHERIT_MAIN;else process.env.DSH_SPACES_LLM_INHERIT_MAIN=prior;}
});

test('main transport rejects EOF without terminal and never resends an incomplete stream',async()=>{
  let calls=0;const server=createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/x-ndjson'});res.end('{"type":"text-delta","index":0,"text":"partial"}\n');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const transport=new MainTransport({origin:`http://127.0.0.1:${(server.address() as {port:number}).port}`,spaceId:'owned',generation:1,serviceEpoch:'epoch',instanceId:'instance',bearer:'a'.repeat(64)});
    const seen:any[]=[];await assert.rejects(async()=>{for await(const chunk of transport.stream('session',{lease:'b'.repeat(64)} as never,{provider:'test',model:'model',messages:[]}))seen.push(chunk);},/MAIN_INCOMPLETE_STREAM/);
    assert.equal(calls,1);assert.equal(seen.length,1);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('main facade replay preserves native bytes and rejects ambiguous or colliding local origins',()=>{
  const native={response:{kind:'deepseek-messages',opaque:['signed',42]},blocks:[{signature:'native-signature'}]};
  for(const route of [{provider:'spaces-main',model:'default'},{provider:'spaces-main:deepseek-official',model:'actual'}]){
    const message:any={id:'model-message',role:'assistant',content:[],source:{kind:'model',...route,replayState:wrapMainReplay(native,'deepseek-official','actual')}};
    const restored=unwrapMainReplay(structuredClone(message));assert.deepEqual((restored.source as any).replayState,native);assert.equal((restored.source as any).provider,'deepseek-official');assert.equal((restored.source as any).model,'actual');
    assert.equal(message.source.replayState.response.kind,'dsh-spaces-main-v1');
  }
  const local:any={id:'local',role:'assistant',content:[{type:'text',text:'local result'}],source:{kind:'model',provider:'deepseek-official',model:'actual',replayState:native}};
  assert.equal((unwrapMainReplay(local).source as any).replayState,undefined);assert.deepEqual(local.source.replayState,native);
  assert.throws(()=>unwrapMainReplay({...local,source:{...local.source,provider:'spaces-main:foreign',replayState:wrapMainReplay(native,'deepseek-official','actual')}}),/REPLAY_ORIGIN_MISMATCH/);
});

test('Supervisor LLM authority binds the real IPC source, single-use stream and image lifetime',async()=>{
  const hostKey=randomBytes(32).toString('hex'),mainKey=randomBytes(32).toString('hex');
  let origin='',owner=true,generation=1,child:ChildProcess|undefined,calls=0,forwarded:any,imageCapability:any;
  const preparedRequests:any[]=[], canceledRequests:any[]=[];
  const route={provider:'test',model:'model'},home=resolve('.sandbox/llm-delegation-contract');
  const broker=new SupervisorLlmDelegation({home,origin:()=>origin,epoch:()=> 'epoch',hostBearerEquals:key=>key===hostKey,
    assertOwner(){if(!owner)throw new Error('OWNER_LOST');},
    assertSource(id,gen,process){if(id!=='space-a'||gen!==generation||process!==child)throw new Error('STALE_INSTANCE');},
    assertMainProfile(profile){assert.equal(profile,'main');},assertAllowedSpace(id){assert.equal(id,'space-a');}});
  const gateway=createServer((req,res)=>{void broker.handle(req,res);});
  const upstream=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${mainKey}`);
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());
    const json=(value:unknown)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(req.url==='/identity')return json({nonce:body.nonce,home,profile:'main'});
    if(req.url==='/prepare'){preparedRequests.push(body);return json({lease:randomBytes(32).toString('hex'),config:body.config});}
    if(req.url==='/cancel'){canceledRequests.push(body);return json({canceled:true});}
    if(req.url==='/stream'){
      calls++;forwarded=body.source;imageCapability=body.images;
      const image=await fetch(body.images.origin,{method:'POST',headers:{authorization:`Bearer ${body.images.bearer}`,'content-type':'application/json'},body:JSON.stringify({ref:{attachmentId:'test-image'},target:{pixels:4}})});
      assert.equal(image.status,200);assert.deepEqual(await image.json(),{source:'space-a',sessionId:'owned-session',ref:{attachmentId:'test-image'}});
      res.writeHead(200,{'content-type':'application/x-ndjson'});res.end('{"type":"finish","reason":{"kind":"stop"}}\n');return;
    }
    res.writeHead(404);res.end();
  });
  async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
  const upstreamOrigin=await listen(upstream);origin=await listen(gateway);
  async function post(op:string,input:unknown,key=hostKey,instance?:string){const response=await fetch(origin+LLM_DELEGATION_PREFIX+op,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json',...(instance?{'x-dsh-instance':instance}:{})},body:JSON.stringify(input)});return {status:response.status,body:await response.text()};}
  try{
    const registration={origin:upstreamOrigin,bearer:mainKey,home,profile:'main',allowedSpaces:['space-a'],routes:[route]};
    assert.equal((await post('register',registration,'0'.repeat(64))).status,401);
    const registered=await post('register',registration);assert.equal(registered.status,200);
    const registrationId=JSON.parse(registered.body).registrationId;
    const ready=new Promise<LlmDelegationBootstrap>((accept,reject)=>{
      child=fork(resolve('tests/fixtures/llm-delegation-child.ts'),[],{stdio:['ignore','ignore','pipe','ipc']});
      child.once('error',reject);child.on('message',(m:any)=>{if(m?.test==='bootstrap')accept(m.value);});
      broker.attachChild('space-a',child,generation);
    });
    const source=await ready;
    const request=(op:string,input:unknown)=>post(op,input,source.bearer,source.instanceId);
    assert.equal((await request('catalog-updated',{registrationId})).status,401);
    assert.equal((await post('catalog-updated',{registrationId:'stale'})).status,409);
    const notification=new Promise<void>(accept=>{child!.on('message',function receive(m:any){if(m?.test==='catalog-updated'){child!.off('message',receive);accept();}});});
    assert.equal((await post('catalog-updated',{registrationId})).status,200);await notification;
    const transport=new MainTransport(source);
    for(let i=0;i<5;i++){
      const lease=JSON.parse((await request('prepare',{sessionId:'owned-session',config:route})).body);
      const abort=new AbortController();abort.abort(new Error('PRE_CANCELED'));
      await assert.rejects(async()=>{for await(const _ of transport.stream('owned-session',lease,{...route,messages:[],signal:abort.signal})){}},/PRE_CANCELED/);
    }
    assert.equal(calls,0);assert.equal(canceledRequests.length,5);
    assert.equal((await request('register',registration)).status,401);
    assert.equal((await request('prepare',{sessionId:'foreign',config:route})).status,403);
    assert.equal((await request('prepare',{sessionId:'owned-session',config:route,source:'space-b'})).status,400);
    const prepared=JSON.parse((await request('prepare',{sessionId:'owned-session',config:route})).body);
    async function sessionCommand(command:string,reply:string) {
      const done=new Promise<void>(resolve=>{child!.on('message',function receive(m:any){if(m?.test===reply){child!.off('message',receive);resolve();}});});
      child!.send({test:command});await done;
    }
    await sessionCommand('release-session','session-released');
    assert.equal((await request('prepare',{sessionId:'owned-session',config:route})).status,403);
    const input={sessionId:'owned-session',lease:prepared.lease,options:{...prepared.config,sessionId:'owned-session',messages:[{role:'user',content:[{type:'image',attachment:{attachmentId:'test-image'}}]}]}};
    assert.equal((await request('stream',input)).status,200);assert.equal(calls,1);
    assert.deepEqual(forwarded,{spaceId:'space-a',generation:1,instanceId:source.instanceId,serviceEpoch:'epoch'});
    assert.equal((await request('stream',input)).status,403);assert.equal(calls,1);
    const staleImage=await fetch(imageCapability.origin,{method:'POST',headers:{authorization:`Bearer ${imageCapability.bearer}`,'content-type':'application/json'},body:JSON.stringify({ref:{attachmentId:'test-image'},target:{}})});
    assert.equal(staleImage.status,401);await staleImage.body?.cancel();
    await sessionCommand('grant-session','session-granted');
    const unused=JSON.parse((await request('prepare',{sessionId:'owned-session',config:route})).body);
    assert.equal((await request('cancel',{sessionId:'owned-session',lease:unused.lease})).status,200);
    assert.equal(canceledRequests.length,6);assert.equal(canceledRequests.at(-1).requestId,preparedRequests.at(-1).requestId);
    assert.equal((await request('cancel',{sessionId:'owned-session',lease:unused.lease})).status,403);
    assert.equal(canceledRequests.length,6);
    generation=2;assert.notEqual((await request('prepare',{sessionId:'owned-session',config:route})).status,200);
    owner=false;assert.notEqual((await post('register',registration)).status,200);assert.equal(calls,1);
  }finally{
    await broker.close();if(child?.connected){const exited=once(child,'exit');child.send({test:'close'});await exited;}
    for(const server of [gateway,upstream]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  }
});

test('Supervisor cancellation barriers survive detached sources, expiry waits and failed cleanup',async t=>{
  async function harness(refuseCancel=false){
    const hostKey=randomBytes(32).toString('hex'),mainKey=randomBytes(32).toString('hex'),home=resolve('.sandbox/llm-cleanup-contract');
    const route={provider:'test',model:'model'};let origin='',child:ChildProcess|undefined,prepares=0,cancels=0;
    let acceptCancel!:()=>void,releaseCancel!:()=>void;
    const cancelStarted=new Promise<void>(r=>acceptCancel=r),cancelGate=new Promise<void>(r=>releaseCancel=r),reports:string[]=[];
    const broker=new SupervisorLlmDelegation({home,origin:()=>origin,epoch:()=> 'epoch',hostBearerEquals:key=>key===hostKey,
      assertOwner(){},assertSource(id,gen,process){assert.equal(id,'space-a');assert.equal(gen,1);assert.equal(process,child);},
      assertMainProfile(){},assertAllowedSpace(){},reportCleanupFailure:reason=>reports.push(reason)});
    let lastPrepareResponse:ServerResponse|undefined,lastPrepareHandled:Promise<boolean>|undefined;
    const gateway=createServer((req,res)=>{const handled=broker.handle(req,res);if(req.url?.endsWith('/prepare')){lastPrepareResponse=res;lastPrepareHandled=handled;}void handled;});
    const upstream=createServer(async(req,res)=>{
      assert.equal(req.headers.authorization,`Bearer ${mainKey}`);
      const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString());
      const json=(value:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
      if(req.url==='/identity')return json({nonce:input.nonce,home,profile:'main'});
      if(req.url==='/prepare'){prepares++;return json({lease:randomBytes(32).toString('hex'),config:input.config});}
      if(req.url==='/cancel'){cancels++;acceptCancel();await cancelGate;return json({canceled:!refuseCancel},refuseCancel?500:200);}
      json({},404);
    });
    async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
    const upstreamOrigin=await listen(upstream);origin=await listen(gateway);
    async function post(op:string,input:unknown,source?:LlmDelegationBootstrap,signal?:AbortSignal){const res=await fetch(origin+LLM_DELEGATION_PREFIX+op,{method:'POST',signal,headers:{authorization:`Bearer ${source?.bearer??hostKey}`,'content-type':'application/json',...(source?{'x-dsh-instance':source.instanceId}:{})},body:JSON.stringify(input)});return {status:res.status,body:await res.json() as any};}
    const registration={origin:upstreamOrigin,bearer:mainKey,home,profile:'main',allowedSpaces:['space-a'],routes:[route]};
    const registered=await post('register',registration);assert.equal(registered.status,200);
    const source=await new Promise<LlmDelegationBootstrap>((accept,reject)=>{
      child=fork(resolve('tests/fixtures/llm-delegation-child.ts'),[],{stdio:['ignore','ignore','pipe','ipc']});
      child.once('error',reject);child.on('message',(m:any)=>{if(m?.test==='bootstrap')accept(m.value);});broker.attachChild('space-a',child,1);
    });
    return {broker,source,post,route,registration,registered,cancelStarted,releaseCancel,reports,
      waitPrepareDisconnected:async()=>{if(!lastPrepareResponse?.destroyed)await once(lastPrepareResponse!,'close');},waitPrepareHandled:()=>lastPrepareHandled,
      counts:()=>({prepares,cancels}),disconnect:async()=>{const disconnected=once(child!,'disconnect');child!.disconnect();await disconnected;},
      async close(){releaseCancel();await broker.close().catch(()=>{});if(child?.connected){const exited=once(child,'exit');child.send({test:'close'});await exited;}
        else if(child?.exitCode===null&&child.signalCode===null)await once(child,'exit');
        for(const server of [gateway,upstream]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}}
    };
  }
  await t.test('unregister and retire wait for cancellation already detached from leases and sources',async()=>{
    const h=await harness();try{
      await h.post('prepare',{sessionId:'owned-session',config:h.route},h.source);
      await h.disconnect();await h.cancelStarted;
      let retired=false,unregistered=false;
      const retiring=h.broker.retire('space-a').then(()=>{retired=true;});
      const unregistering=h.post('unregister',{registrationId:h.registered.body.registrationId}).then(result=>{unregistered=true;return result;});
      assert.equal((await h.post('register',h.registration)).status,409);assert.equal(retired,false);assert.equal(unregistered,false);
      h.releaseCancel();await retiring;assert.equal((await unregistering).status,200);assert.deepEqual(h.counts(),{prepares:1,cancels:1});
    }finally{await h.close();}
  });
  await t.test('expiry cleanup cannot dispatch a new prepare after its source retires',async()=>{
    const h=await harness();try{
      await h.post('prepare',{sessionId:'owned-session',config:h.route},h.source);
      // Make this lease expired without a ten-second wall-clock wait.
      for(const lease of (h.broker as any).leases.values())lease.expires=0;
      const next=h.post('prepare',{sessionId:'owned-session',config:h.route},h.source);await h.cancelStarted;
      const retiring=h.broker.retire('space-a');h.releaseCancel();await retiring;
      assert.notEqual((await next).status,200);assert.deepEqual(h.counts(),{prepares:1,cancels:1});
    }finally{await h.close();}
  });
  await t.test('failed cancellation remains a terminal failure after its promise settles',async()=>{
    const h=await harness(true);try{
      const prepared=await h.post('prepare',{sessionId:'owned-session',config:h.route},h.source);
      const cancel=h.post('cancel',{sessionId:'owned-session',lease:prepared.body.lease},h.source);await h.cancelStarted;h.releaseCancel();
      assert.notEqual((await cancel).status,200);assert.equal(h.reports.length,1);
      assert.equal((await h.post('prepare',{sessionId:'owned-session',config:h.route},h.source)).status,503);
      await assert.rejects(h.broker.retire('space-a'),/CLEANUP_UNCONFIRMED/);
      await assert.rejects(h.broker.close(),/CLEANUP_UNCONFIRMED/);assert.deepEqual(h.counts(),{prepares:1,cancels:1});
    }finally{await h.close();}
  });
  await t.test('client disconnect during expiry cleanup cannot dispatch a new prepare',async()=>{
    const h=await harness();try{
      await h.post('prepare',{sessionId:'owned-session',config:h.route},h.source);
      for(const lease of (h.broker as any).leases.values())lease.expires=0;
      const abort=new AbortController(),next=h.post('prepare',{sessionId:'owned-session',config:h.route},h.source,abort.signal).catch(error=>({status:0,body:{error:error.name}}));
      await h.cancelStarted;abort.abort();assert.equal((await next).body.error,'AbortError');await h.waitPrepareDisconnected();
      h.releaseCancel();await h.waitPrepareHandled();assert.deepEqual(h.counts(),{prepares:1,cancels:1});
    }finally{await h.close();}
  });
});
