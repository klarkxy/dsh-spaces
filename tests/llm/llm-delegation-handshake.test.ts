import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {LLM_DELEGATION_CHANNEL} from '../../src/shared/llm-delegation.ts';

const fixture=resolve('tests/fixtures/llm-handshake-child.ts');
const bootstrap={channel:LLM_DELEGATION_CHANNEL,kind:'bootstrap',origin:'http://127.0.0.1:1234',bearer:'a'.repeat(64),spaceId:'space-a',generation:1,serviceEpoch:'e',instanceId:'i'} as const;

async function run(scenario:string,options:{reply?:(child:ChildProcess)=>void,onFirstLine?:(child:ChildProcess)=>void}={}){
  const child=fork(fixture,[scenario],{stdio:['ignore','pipe','pipe','ipc']});
  let hellos=0,buffer='',stderr='';const lines:Record<string,unknown>[]=[];
  child.stdout!.setEncoding('utf8');child.stderr!.setEncoding('utf8');
  child.stdout!.on('data',(chunk:string)=>{
    buffer+=chunk;const parts=buffer.split('\n');buffer=parts.pop()??'';
    for(const raw of parts){const trimmed=raw.trim();if(!trimmed)continue;lines.push(JSON.parse(trimmed));if(lines.length===1)options.onFirstLine?.(child);}
  });
  child.stderr!.on('data',(chunk:string)=>{stderr+=chunk;});
  child.on('message',(m:{channel?:unknown;kind?:unknown})=>{
    if(m?.channel===LLM_DELEGATION_CHANNEL&&m.kind==='hello'){hellos++;options.reply?.(child);}
  });
  const [code]=await once(child,'exit');
  return {lines,hellos,code,stderr};
}

test('a blocked event loop still accepts the supervisor bootstrap that beat the timeout',{timeout:15000},async()=>{
  const r=await run('block',{reply:child=>child.send(bootstrap)});
  assert.equal(r.code,0,r.stderr);
  assert.equal(r.hellos,1);
  assert.deepEqual(r.lines,[{ok:true}]);
});

test('no supervisor reply keeps the single timeout failure and clean listeners',{timeout:15000},async()=>{
  const r=await run('block');
  assert.equal(r.code,0,r.stderr);
  assert.equal(r.hellos,1);
  assert.deepEqual(r.lines,[{error:'SUPERVISOR_BOOTSTRAP_TIMEOUT',messageDelta:0,disconnectDelta:0}]);
});

test('refused, malformed and disconnected supervisor replies keep their real failure',async t=>{
  const cases=[
    ['refused',(child:ChildProcess)=>child.send({channel:LLM_DELEGATION_CHANNEL,kind:'refused'}),'SUPERVISOR_REFUSED'],
    ['malformed bootstrap',(child:ChildProcess)=>child.send({...bootstrap,bearer:'bad'}),'INVALID_SUPERVISOR_BOOTSTRAP'],
    ['disconnect',(child:ChildProcess)=>child.disconnect(),'SUPERVISOR_DISCONNECTED'],
  ] as const;
  for(const [name,reply,error] of cases)await t.test(name,{timeout:15000},async()=>{
    const r=await run('plain',{reply});
    assert.equal(r.code,0,r.stderr);
    assert.equal(r.hellos,1);
    assert.deepEqual(r.lines,[{error,messageDelta:0,disconnectDelta:0}]);
  });
});

test('a bootstrap delivered after the timeout does not unsettle or resend hello',{timeout:15000},async()=>{
  const r=await run('late',{onFirstLine:child=>child.send(bootstrap)});
  assert.equal(r.code,0,r.stderr);
  assert.equal(r.hellos,1);
  assert.deepEqual(r.lines,[
    {error:'SUPERVISOR_BOOTSTRAP_TIMEOUT',messageDelta:0,disconnectDelta:0},
    {afterLate:true,settledError:'SUPERVISOR_BOOTSTRAP_TIMEOUT',messageDelta:0,disconnectDelta:0},
  ]);
});
