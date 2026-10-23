/** The main delegation path admits one auxiliary call, never overflow recovery or repeated compaction. */
export function singleAuxiliaryPolicy(value:unknown):unknown{
  if(value===undefined)return {compactionRetries:0,maxOverflowRetries:0};
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const config=value as Record<string,unknown>;
  const check=(row:Record<string,unknown>)=>{for(const key of ['compactionRetries','maxOverflowRetries'])if(row[key]!==undefined&&row[key]!==0)throw new Error('SPACES_COMPACTION_RETRIES_UNSUPPORTED:'+key);};
  check(config);
  if(Array.isArray(config.modelPolicies))for(const row of config.modelPolicies)if(row&&typeof row==='object')check(row);
  return {...config,compactionRetries:0,maxOverflowRetries:0};
}

/** Native preset revisions share services across Agents. Carry the exact /compact invocation, not a session-id guess. */
export function scopeAuxiliaryCommands(value:unknown):unknown{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const visit=(rows:any[]):any[]=>rows.map(row=>{
    if(!row||typeof row!=='object')return row;
    if(row.name==='@deepseek-ai/dsh-compaction-basic')return {...row,name:'@dsh-spaces/llm-bridge/auxiliary',config:{role:'compaction',options:singleAuxiliaryPolicy(row.config)}};
    if(row.name==='@deepseek-ai/dsh-command-compact'){
      if(row.isolate?.commands&&row.isolate.commands!=='spaces-aux-commands')throw new Error('SPACES_COMPACT_COMMAND_REALM_CONFLICT');
      return {...row,isolate:{...row.isolate,commands:'spaces-aux-commands'}};
    }
    if(row.group&&Array.isArray(row.config))return {...row,config:visit(row.config)};
    return row;
  });
  const config=value as Record<string,unknown>;
  return Array.isArray(config.plugins)?{...config,plugins:visit(config.plugins)}:value;
}
