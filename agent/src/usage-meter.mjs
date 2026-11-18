// Model usage from any CLI reply (2026-11-02, lesson 433). Workday runs consult a model for unknown questions and
// education rows through execCLI but never recorded what those calls used, so 62 Workday applications showed
// $0.00 on the cost page despite up to 18 model calls each. meterExec wraps an execImpl and reports each reply's
// usage, keyed the way the dashboard's model_usage is (`engine:model`).

// Claude `-p --output-format json` (one object with usage), Codex `--json` (turn.completed event lines),
// OpenCode `--format json` (step_finish tokens). Returns null when the reply carries no usage.
export function cliUsage(stdout){
 const text=String(stdout??'').trim();if(!text)return null;
 const objects=[];
 try{objects.push(JSON.parse(text));}catch{for(const line of text.split('\n')){try{objects.push(JSON.parse(line));}catch{}}}
 for(const o of objects.slice().reverse()){
  if(o?.type==='turn.completed'&&o.usage){const u=o.usage;return {input_tokens:Math.max(0,(u.input_tokens??0)-(u.cached_input_tokens??0)),cache_read_input_tokens:u.cached_input_tokens??0,cache_creation_input_tokens:0,output_tokens:(u.output_tokens??0)+(u.reasoning_output_tokens??0)};}
  if((o?.type==='step_finish'||o?.type==='turn.completed')&&(o.tokens||o.usage)){const t=o.tokens||o.usage;return {input_tokens:t.input??t.input_tokens??0,cache_read_input_tokens:t.cache?.read??t.cached_input_tokens??0,cache_creation_input_tokens:t.cache?.write??0,output_tokens:(t.output??t.output_tokens??0)+(t.reasoning??0)};}
  if(o?.usage&&(o.type==='result'||o.usage.input_tokens!==undefined)){const u=o.usage;return {input_tokens:u.input_tokens??0,cache_read_input_tokens:u.cache_read_input_tokens??0,cache_creation_input_tokens:u.cache_creation_input_tokens??0,output_tokens:u.output_tokens??0};}
 }
 return null;
}

// Adds one call's usage into {usage, model_usage} in place, the shape dashboard-worker keeps in state.json.
export function addUsage(totals,via,usage){
 if(!usage)return totals;
 totals.usage??={input_tokens:0,output_tokens:0};totals.model_usage??={};
 totals.usage.input_tokens+=(usage.input_tokens??0)+(usage.cache_read_input_tokens??0)+(usage.cache_creation_input_tokens??0);
 totals.usage.output_tokens+=usage.output_tokens??0;
 const m=totals.model_usage[via]??={calls:0,input_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0};
 m.calls++;for(const k of ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'])m[k]+=usage[k]??0;
 return totals;
}

// execImpl wrapper: every reply's usage goes to onUsage(via, usage). via is `${engine}:${model}`; the command name
// stands in for the engine (claude / codex / opencode / agy).
export function meterExec(execImpl,onUsage,{engine,model}={}){
 return async(command,args,...rest)=>{
  const result=await execImpl(command,args,...rest);
  try{
   const usage=cliUsage(result?.stdout);
   if(usage){
    const argModel=(()=>{const a=args??[];const i=a.findIndex(x=>x==='--model'||x==='-m');return i>=0?a[i+1]:null;})();
    const eng=engine||String(command??'').split('/').pop()||'cli';
    await onUsage(`${eng}:${argModel||model||'default'}`,usage);
   }
  }catch{}
  return result;
 };
}
