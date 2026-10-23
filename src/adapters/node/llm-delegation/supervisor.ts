import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { LLM_DELEGATION_PREFIX, LLM_DELEGATION_CHANNEL } from '../../../shared/llm-delegation';
export { LLM_DELEGATION_PREFIX, LLM_DELEGATION_CHANNEL };
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const token = z.string().regex(/^[a-f0-9]{64}$/);
const configSchema = z.object({ provider: id, model: z.string().min(1).max(256) }).catchall(z.unknown());
const registrationSchema = z.object({ origin: z.string().url(), bearer: token, home: z.string(), profile: id,
  allowedSpaces: z.array(id).max(128), allowNewSpaces:z.boolean().optional(),liveCatalog:z.boolean().optional(), routes: z.array(z.object({provider:id,model:z.string().min(1).max(256)}).strict()).max(128) }).strict();
type Main = z.infer<typeof registrationSchema> & { registrationId: string; epoch: string };
type Source = { id: string; generation: number; instanceId: string; epoch: string; child: ChildProcess;
  digest: Buffer; sessions: Map<string, Set<string>>; dispose(): void };
type Lease = { id: string; source: Source; main: Main; remote: string; sessionId: string; config: unknown;
  requestId: string; used: boolean; complete: boolean; released: boolean; cleanup?: Promise<void>; expires: number; abort: AbortController };
type ImageScope = { lease: Lease; digest: Buffer; refs: unknown[] };
type Pending = { source: Source; resolve(value: unknown): void; reject(error: Error): void };
export interface DelegationSupervisorPorts {
  home: string;
  origin(): string;
  epoch(): string;
  hostBearerEquals(value: string): boolean;
  assertOwner(): void;
  assertSource(id: string, generation: number, child: ChildProcess): void;
  assertMainProfile(profile: string): void;
  assertAllowedSpace(spaceId: string): void;
  inheritsMain?(spaceId: string): boolean;
  reportCleanupFailure?(reason: string): void;
}
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function fault(code: string, status = 403): never { throw Object.assign(new Error(code), { status }); }
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) fault('INVALID_CONTENT_TYPE',400);
  const chunks: Buffer[] = []; let bytes = 0;
  const timer = setTimeout(() => req.destroy(new Error('BODY_TIMEOUT')),5000);
  try { for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024*1024) fault('BODY_TOO_LARGE',413); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally { clearTimeout(timer); }
}
function loopback(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fault('INVALID_MAIN_ORIGIN',400);
  return url.origin;
}
/** Actual Supervisor composition. Main authority is the existing Host bearer;
 * source authority is the exact spawned IPC descriptor, generation and Home lease.
 * No default provider, reconnect, retry, or replacement registration is selected.
 */
export class SupervisorLlmDelegation {
  private main?: Main;
  private readonly sources = new Map<string, Source>();
  private readonly leases = new Map<string, Lease>();
  private readonly images = new Map<string, ImageScope>();
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private cleanupFailure?: string;
  private readonly cleanups = new Set<Promise<void>>();
  private readonly sourceCleanups = new Map<string, Set<Promise<void>>>();
  private readonly failedCleanupSources = new Set<string>();
  private unregistering = false;
  private inFlight = 0;
  constructor(private readonly ports: DelegationSupervisorPorts) {}
  attachChild(spaceId: string, child: ChildProcess, generation: number): void {
    void this.retire(spaceId).catch(() => {}); // release() records and blocks an unconfirmed cleanup.
    if (!child.connected || !child.send) return;
    let source: Source | undefined;
    const receive = (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || (raw as {channel?: unknown}).channel !== LLM_DELEGATION_CHANNEL) return;
      const message = raw as Record<string, unknown>;
      if (message.kind === 'hello') {
        if (source || this.closed) return;
        try {
          this.ports.assertOwner(); this.ports.assertSource(spaceId,generation,child);
          if (this.sources.size >= 128) fault('SOURCE_LIMIT',429);
          const bearer = randomBytes(32).toString('hex');
          source = {id:spaceId,generation,instanceId:randomUUID(),epoch:this.ports.epoch(),child,digest:digest(bearer),sessions:new Map(),dispose};
          this.sources.set(spaceId,source);
          child.send!({channel:LLM_DELEGATION_CHANNEL,kind:'bootstrap',origin:this.ports.origin(),spaceId,generation,
            serviceEpoch:source.epoch,instanceId:source.instanceId,bearer});
        } catch { child.send!({channel:LLM_DELEGATION_CHANNEL,kind:'refused'}); }
      } else if (source && message.kind === 'session') {
        try { this.current(source); const session = id.parse(message.sessionId), requestId = id.parse(message.requestId);
          if (source.sessions.size >= 256 && !source.sessions.has(session)) fault('SESSION_LIMIT',429);
          const grants = source.sessions.get(session) ?? new Set<string>();
          if (grants.size >= 256 && !grants.has(requestId)) fault('SESSION_GRANT_LIMIT',429);
          grants.add(requestId);source.sessions.set(session,grants);
          child.send!({channel:LLM_DELEGATION_CHANNEL,kind:'session-granted',requestId,sessionId:session});
        } catch { child.send!({channel:LLM_DELEGATION_CHANNEL,kind:'session-refused',requestId:message.requestId}); }
      } else if (source && message.kind === 'session-release') {
        try { this.current(source); } catch { return; }
        const session = id.safeParse(message.sessionId), requestId = id.safeParse(message.requestId);
        if (!session.success || !requestId.success) return;
        const grants = source.sessions.get(session.data);
        grants?.delete(requestId.data);
        if (grants?.size === 0) source.sessions.delete(session.data);
      } else if (source && message.kind === 'image-result' && typeof message.requestId === 'string') {
        const pending = this.pending.get(message.requestId);
        if (pending?.source !== source) return;
        if (message.error) pending.reject(new Error('SOURCE_IMAGE_REFUSED'));
        else pending.resolve(message.value);
      }
    };
    const dispose = () => {
      child.off('message',receive); child.off('exit',dispose); child.off('disconnect',dispose); child.off('error',dispose);
      if (source && this.sources.get(spaceId) === source) {
        this.sources.delete(spaceId);
        for (const lease of [...this.leases.values()]) if (lease.source === source) void this.release(lease,'SOURCE_RETIRED');
        for (const p of this.pending.values()) if (p.source === source) p.reject(new Error('SOURCE_RETIRED'));
      }
    };
    child.on('message',receive);child.once('exit',dispose);child.once('disconnect',dispose);child.once('error',dispose);
    // Disposal also has to remove listeners when hello has not arrived yet.
    const waiting = { id:spaceId,generation,instanceId:'',epoch:'',child,digest:Buffer.alloc(32),sessions:new Map<string, Set<string>>(),dispose };
    this.sources.set(spaceId,waiting);
  }
  async retire(spaceId: string): Promise<void> {
    const source=this.sources.get(spaceId);source?.dispose();this.sources.delete(spaceId);
    await Promise.all(this.sourceCleanups.get(spaceId)??[]);
    if(this.failedCleanupSources.has(spaceId))fault('CLEANUP_UNCONFIRMED',503);
  }
  private current(source: Source): void {
    this.ports.assertOwner();
    if (this.closed || this.sources.get(source.id) !== source || source.epoch !== this.ports.epoch()) fault('STALE_SOURCE',401);
    this.ports.assertSource(source.id,source.generation,source.child);
  }
  private native(req: IncomingMessage): string {
    this.ports.assertOwner();
    if (this.closed) fault('UNAVAILABLE',503);
    if (this.cleanupFailure) fault('CLEANUP_UNCONFIRMED',503);
    if (req.headers.host !== new URL(this.ports.origin()).host || req.headers.origin !== undefined || req.headers.cookie !== undefined || req.headers['sec-fetch-site'] !== undefined) fault('NATIVE_AUTH_REQUIRED');
    for (const name of ['host','authorization']) if(req.rawHeaders.filter((_,i)=>!(i%2)).filter(h=>h.toLowerCase()===name).length!==1) fault('UNAUTHENTICATED',401);
    const auth = req.headers.authorization;
    if (!auth || !/^Bearer [a-f0-9]{64}$/.test(auth)) fault('UNAUTHENTICATED',401);
    return auth.slice(7);
  }
  private source(req: IncomingMessage): Source {
    const hash = digest(this.native(req)); let matched: Source | undefined;
    for (const source of this.sources.values()) if (timingSafeEqual(hash,source.digest)) matched=source;
    if (!matched || req.headers['x-dsh-instance'] !== matched.instanceId) fault('UNAUTHENTICATED',401);
    this.current(matched); return matched;
  }
  private async upstream(main: Main, operation: string, input: unknown, signal?: AbortSignal): Promise<Response> {
    this.ports.assertOwner();
    if (this.main !== main || main.epoch !== this.ports.epoch()) fault('MAIN_UNAVAILABLE',503);
    const response = await fetch(main.origin+'/'+operation,{method:'POST',redirect:'error',signal,
      headers:{Authorization:`Bearer ${main.bearer}`,'Content-Type':'application/json'},body:JSON.stringify(input)});
    if (!response.ok) { await response.body?.cancel(); fault('MAIN_REQUEST_REFUSED',502); }
    if (this.main !== main) { await response.body?.cancel(); fault('MAIN_UNAVAILABLE',503); }
    return response;
  }
  private release(lease: Lease, reason: string): Promise<void> {
    if(lease.released)return lease.cleanup??Promise.resolve();
    lease.released=true;
    lease.abort.abort(new Error(reason)); this.leases.delete(lease.id);
    for (const [key,scope] of this.images) if (scope.lease===lease) this.images.delete(key);
    if(lease.complete)return Promise.resolve();
    // A separate once-only cancellation releases this request, including a lost
    // prepare response. It never resends preparation or a provider request.
    const cleanup=(async()=>{
      const response=await fetch(lease.main.origin+'/cancel',{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
        headers:{Authorization:`Bearer ${lease.main.bearer}`,'Content-Type':'application/json'},
        body:JSON.stringify({requestId:lease.requestId,sessionId:lease.sessionId,...lease.remote?{lease:lease.remote}:{}})});
      try{if(!response.ok)throw new Error('MAIN_CANCEL_UNCONFIRMED');}finally{await response.body?.cancel();}
    })();
    lease.cleanup=cleanup;this.cleanups.add(cleanup);
    const sourceCleanups=this.sourceCleanups.get(lease.source.id)??new Set<Promise<void>>();
    this.sourceCleanups.set(lease.source.id,sourceCleanups);sourceCleanups.add(cleanup);
    const settled=()=>{this.cleanups.delete(cleanup);sourceCleanups.delete(cleanup);if(!sourceCleanups.size)this.sourceCleanups.delete(lease.source.id);};
    void cleanup.then(settled,()=>{
      settled();this.cleanupFailure??='LLM delegation cancellation was not confirmed; further delegation is blocked.';
      this.failedCleanupSources.add(lease.source.id);
      try{this.ports.reportCleanupFailure?.(this.cleanupFailure);}catch{console.error(this.cleanupFailure);}
    });
    return cleanup;
  }
  private async image(source: Source, input: unknown, signal: AbortSignal): Promise<unknown> {
    this.current(source);if(this.pending.size>=32)fault('IMAGE_LIMIT',429);
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const finish=(error?:Error,value?:unknown)=>{
        if(!this.pending.delete(requestId))return;clearTimeout(timer);signal.removeEventListener('abort',abort);
        error?reject(error):resolve(value);
      };
      const cancel=()=>{if(source.child.connected)source.child.send?.({channel:LLM_DELEGATION_CHANNEL,kind:'image-cancel',requestId},()=>{});};
      const abort=()=>{cancel();finish(new Error('IMAGE_CANCELED'));};
      const timer=setTimeout(()=>{cancel();finish(new Error('IMAGE_TIMEOUT'));},5000);
      this.pending.set(requestId,{source,resolve:value=>finish(undefined,value),reject:error=>finish(error)});
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
      source.child.send?.({channel:LLM_DELEGATION_CHANNEL,kind:'image-read',requestId,input},error=>{if(error)finish(new Error('SOURCE_DISCONNECTED'));});
    });
  }
  async handle(req: IncomingMessage,res: ServerResponse): Promise<boolean> {
    if(!req.url?.startsWith(LLM_DELEGATION_PREFIX))return false;
    let admitted=false;
    let consumed: Lease | undefined;
    try {
      const bearer=this.native(req);
      if(req.method!=='POST')fault('METHOD_NOT_ALLOWED',405);
      if(this.inFlight>=32)fault('REQUEST_LIMIT',429);this.inFlight++;admitted=true;
      const input=await body(req);this.native(req);
      const op=req.url.slice(LLM_DELEGATION_PREFIX.length);
      if(op==='register') {
        if(!this.ports.hostBearerEquals(bearer))fault('HOST_REQUIRED',401);
        if(this.main)fault('MAIN_ALREADY_REGISTERED',409);
        if(this.unregistering||this.cleanups.size)fault('MAIN_DRAINING',409);
        const registration=registrationSchema.parse(input);
        if(registration.home!==this.ports.home)fault('FOREIGN_HOME');
        this.ports.assertMainProfile(registration.profile);
        for(const space of registration.allowedSpaces)this.ports.assertAllowedSpace(space);
        registration.origin=loopback(registration.origin);
        if(registration.origin===this.ports.origin())fault('INVALID_MAIN_ORIGIN',400);
        const nonce=randomBytes(32).toString('hex');
        const response=await fetch(registration.origin+'/identity',{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
          headers:{Authorization:`Bearer ${registration.bearer}`,'Content-Type':'application/json'},body:JSON.stringify({nonce})});
        const proof=await response.json() as Record<string,unknown>;
        if(!response.ok||proof.nonce!==nonce||proof.home!==registration.home||proof.profile!==registration.profile)fault('MAIN_IDENTITY_MISMATCH');
        this.ports.assertOwner();if(this.closed)fault('UNAVAILABLE',503);if(this.cleanupFailure)fault('CLEANUP_UNCONFIRMED',503);
        if(this.main)fault('MAIN_ALREADY_REGISTERED',409);if(this.unregistering||this.cleanups.size)fault('MAIN_DRAINING',409);
        this.main={...registration,registrationId:randomUUID(),epoch:this.ports.epoch()};
        json(res,200,{registrationId:this.main.registrationId,serviceEpoch:this.main.epoch});
      } else if(op==='catalog-updated') {
        const bearer=this.native(req);
        if(!this.ports.hostBearerEquals(bearer))fault('HOST_AUTH_REQUIRED',401);
        const parsed=z.object({registrationId:id}).strict().parse(input),main=this.main;
        if(!main||main.registrationId!==parsed.registrationId||main.epoch!==this.ports.epoch())fault('MAIN_NOT_REGISTERED',409);
        for(const source of this.sources.values()) {
          if(!source.child.connected||!(main.allowedSpaces.includes(source.id)||(main.allowNewSpaces&&this.ports.inheritsMain?.(source.id))))continue;
          this.current(source);
          source.child.send?.({channel:LLM_DELEGATION_CHANNEL,kind:'catalog-updated'},error=>{if(error)this.ports.reportCleanupFailure?.('CATALOG_NOTIFICATION_FAILED');});
        }
        json(res,200,{notified:true});
      } else if(op==='unregister') {
        if(!this.ports.hostBearerEquals(bearer))fault('HOST_REQUIRED',401);
        const parsed=z.object({registrationId:id}).strict().parse(input);
        if(this.main?.registrationId!==parsed.registrationId)fault('STALE_MAIN',409);
        this.unregistering=true;this.main=undefined;
        try{for(const lease of [...this.leases.values()])void this.release(lease,'MAIN_RETIRED');await Promise.all([...this.cleanups]);json(res,200,{unregistered:true});}
        finally{this.unregistering=false;}
      } else if(op==='image') {
        const scope=[...this.images.values()].find(s=>timingSafeEqual(s.digest,digest(bearer)));
        if(!scope||scope.lease.abort.signal.aborted)fault('IMAGE_SCOPE_MISSING',401);
        const parsed=z.object({ref:z.unknown(),target:z.unknown()}).strict().parse(input);
        if(!scope.refs.some(ref=>equal(ref,parsed.ref)))fault('IMAGE_NOT_GRANTED');
        const value=await this.image(scope.lease.source,{sessionId:scope.lease.sessionId,...parsed},scope.lease.abort.signal);
        this.current(scope.lease.source);
        if(this.images.get(scope.lease.id)!==scope||scope.lease.abort.signal.aborted)fault('IMAGE_SCOPE_MISSING',401);
        json(res,200,value);
      } else {
        const source=this.source(req),main=this.main;
        if(!main||!(main.allowedSpaces.includes(source.id)||(main.allowNewSpaces&&this.ports.inheritsMain?.(source.id))))fault('MAIN_NOT_GRANTED',503);
        if(op==='describe') {
          z.object({}).strict().parse(input);
          const response=await this.upstream(main,'describe',{},AbortSignal.timeout(10000));
          const description=await response.json();this.current(source);if(this.main!==main)fault('MAIN_UNAVAILABLE',503);
          json(res,200,description);
        } else if(op==='resolve-config') {
          const parsed=z.object({config:configSchema}).strict().parse(input);
          if(!main.liveCatalog&&!main.routes.some(r=>r.provider===parsed.config.provider&&r.model===parsed.config.model))fault('ROUTE_NOT_GRANTED');
          const response=await this.upstream(main,'resolve-config',parsed,AbortSignal.timeout(5000));this.current(source);json(res,200,await response.json());
        } else if(op==='model-info') {
          const parsed=z.object({provider:id,model:z.string().min(1).max(256)}).strict().parse(input);
          if(!main.liveCatalog&&!main.routes.some(r=>r.provider===parsed.provider&&r.model===parsed.model))fault('ROUTE_NOT_GRANTED');
          const response=await this.upstream(main,'model-info',parsed,AbortSignal.timeout(5000));json(res,200,await response.json());
        } else if(op==='prepare') {
          const parsed=z.object({sessionId:id,config:configSchema,expectedModel:z.unknown().optional(),defaultReasoning:z.boolean().optional()}).strict().parse(input);
          if(!source.sessions.has(parsed.sessionId))fault('SESSION_NOT_GRANTED');
          if(!main.liveCatalog&&!main.routes.some(r=>r.provider===parsed.config.provider&&r.model===parsed.config.model))fault('ROUTE_NOT_GRANTED');
          for(const lease of [...this.leases.values()])if(!lease.used&&lease.expires<Date.now())await this.release(lease,'PREPARE_EXPIRED');
          if(res.destroyed)fault('PREPARE_DISCONNECTED',400);
          this.current(source);this.native(req);
          if(this.main!==main||this.unregistering)fault('MAIN_UNAVAILABLE',503);
          if([...this.leases.values()].filter(l=>l.source===source).length>=4)fault('LEASE_LIMIT',429);
          const lease:Lease={id:randomBytes(32).toString('hex'),requestId:randomUUID(),source,main,remote:'',sessionId:parsed.sessionId,config:undefined,
            used:false,complete:false,released:false,expires:Date.now()+10000,abort:new AbortController()};
          this.leases.set(lease.id,lease); // reserve before awaiting any main work
          const disconnect=()=>{if(!res.writableEnded)void this.release(lease,'PREPARE_DISCONNECTED');};res.once('close',disconnect);
          try{
            const response=await this.upstream(main,'prepare',{...parsed,requestId:lease.requestId},AbortSignal.any([lease.abort.signal,AbortSignal.timeout(10000)]));
            const remote=await response.json() as Record<string,unknown>;
            lease.remote=token.parse(remote.lease);lease.config=remote.config;
            this.current(source);if(this.main!==main||this.leases.get(lease.id)!==lease)fault('MAIN_UNAVAILABLE',503);
            json(res,200,{...remote,lease:lease.id});
          }catch(error){await this.release(lease,'PREPARE_FAILED');throw error;}finally{res.off('close',disconnect);}
        } else if(op==='stream'||op==='cancel') {
          const parsed=z.object({sessionId:id,lease:token,options:z.record(z.string(),z.unknown()).optional()}).strict().parse(input);
          const lease=this.leases.get(parsed.lease);
          if(!lease||lease.source!==source||lease.sessionId!==parsed.sessionId||lease.main!==main)fault('LEASE_NOT_OWNED');
          if(op==='cancel') {await this.release(lease,'CALLER_CANCELED');json(res,200,{canceled:true});}
          else {
            if(lease.used||lease.expires<Date.now())fault('LEASE_NOT_ACTIVE');lease.used=true;consumed=lease;
            if(!parsed.options||parsed.options.sessionId!==lease.sessionId)fault('SESSION_MISMATCH');
            const refs:unknown[]=[];
            for(const message of z.array(z.object({content:z.array(z.record(z.string(),z.unknown()))}).passthrough()).parse(parsed.options.messages))for(const block of message.content){
              if(block.type==='file')fault('UNPROJECTED_FILE');if(block.type==='image')refs.push(block.attachment);
            }
            const imageBearer=randomBytes(32).toString('hex');this.images.set(lease.id,{lease,digest:digest(imageBearer),refs});
            const disconnect=()=>{if(!res.writableEnded)void this.release(lease,'TRANSPORT_DISCONNECTED');};res.once('close',disconnect);
            try {
              const upstream=await this.upstream(main,'stream',{sessionId:lease.sessionId,lease:lease.remote,options:parsed.options,
                source:{spaceId:source.id,generation:source.generation,instanceId:source.instanceId,serviceEpoch:source.epoch},
                images:{origin:this.ports.origin()+LLM_DELEGATION_PREFIX+'image',bearer:imageBearer,refs}},lease.abort.signal);
              res.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'});
              if(!upstream.body)fault('EMPTY_MAIN_STREAM',502);
              const reader=upstream.body.getReader();
              try{while(true){const {value,done}=await reader.read();if(done)break;this.current(source);if(!res.write(value))await once(res,'drain',{signal:lease.abort.signal});}}
              finally{await reader.cancel();reader.releaseLock();}
              lease.complete=true;res.end();
            } finally {res.off('close',disconnect);await this.release(lease,'STREAM_FINISHED');}
          }
        } else fault('UNKNOWN_OPERATION',404);
      }
    } catch(error) {
      if(!res.headersSent)json(res,(error as {status?:number}).status??400,{error:error instanceof z.ZodError?'INVALID_INPUT':error instanceof Error?error.message:'REQUEST_FAILED'});
      else res.destroy();
    } finally {try{if(consumed)await this.release(consumed,'REQUEST_FINISHED');}finally{if(admitted)this.inFlight--;}}
    return true;
  }
  async close(): Promise<void> {this.closed=true;this.main=undefined;for(const source of [...this.sources.values()])source.dispose();this.sources.clear();for(const lease of [...this.leases.values()])void this.release(lease,'SUPERVISOR_CLOSED');await Promise.all([...this.cleanups]);if(this.cleanupFailure)fault('CLEANUP_UNCONFIRMED',503);}
}
