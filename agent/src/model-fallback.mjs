// When the step engine (Claude or Codex) reaches its plan limit, keep preparing applications on agy
// (Google's Antigravity CLI, signed in on this Mac) instead of stopping, as he asked on 2026-10-24.
// agy's models are used one after another: each is used until it reports its own limit, then the next.
// The engine goes back to Claude (or Codex) as soon as its reset time passes. Only when every agy
// model is also limited does the original "usage limit reached" error surface, so JobAgent pauses
// scheduling exactly as before.
//
// Limits are shared by every worker through state/model-limits.json:
//   {"engines": {"claude": {"until": ISO, "message": "..."}}, "agy": {"<model>": {"until": ISO, "message": "..."}}}
import {readFileSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {mkdir,writeFile,rename,mkdtemp,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setting} from './settings.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
// Under `node --test` nothing is persisted (null path): a fixture's fake limit once marked Claude limited
// for the live workers, and a file shared by one test file's tests leaks between them (2026-10-24).
export const LIMITS_PATH=process.env.MODEL_LIMITS_PATH||(process.env.NODE_TEST_CONTEXT?null:join(ROOT,'state','model-limits.json'));
export const AGY=process.env.AGY_BIN||join(homedir(),'.local','bin','agy');
// Fastest first (his choice, 2026-10-24). Every agy step's time is recorded in state/agy-speed.json and
// the models are ordered by their running average; SPEED_SEEDS stand in until a model has been timed:
// tools/agy-bench.mjs medians on one form step as workers call agy (no tools): flash-low 4.9 s,
// flash-medium 28.6 s, flash-high 51.5 s; sonnet-4-6 6.6 s in one earlier run. Opus and GPT-OSS were out
// of quota, so they start at a neutral 30 s and are placed by their real time after their first step.
// The JobAgent setting `agy.models` fixes the order by hand instead.
export const DEFAULT_AGY_MODELS=['gemini-3.8-flash-low','claude-sonnet-4-6','gemini-3.8-flash-medium','gpt-oss-120b-medium','claude-opus-4-6-thinking','gemini-3.8-flash-high'];
export const SPEED_SEEDS={'gemini-3.8-flash-low':4900,'claude-sonnet-4-6':6600,'gemini-3.8-flash-medium':28600,'gemini-3.8-flash-high':51500};
const UNTIMED_MS=30000;
export const SPEED_PATH=process.env.AGY_SPEED_PATH||(process.env.NODE_TEST_CONTEXT?null:join(ROOT,'state','agy-speed.json'));
const readSpeed=(path=SPEED_PATH)=>{if(!path)return {};try{return JSON.parse(readFileSync(path,'utf8'));}catch{return {};}};
export function orderBySpeed(models,speed=readSpeed()){
 const ms=m=>speed[m]?.avg_ms??SPEED_SEEDS[m]??UNTIMED_MS;
 return [...models].map((m,i)=>({m,i})).sort((a,b)=>ms(a.m)-ms(b.m)||a.i-b.i).map(x=>x.m);
}
// A running average weighted toward recent steps (load and agy's own capacity change through the day).
export async function recordSpeed(model,ms,{path=SPEED_PATH}={}){
 if(!path)return;
 const speed=readSpeed(path),old=speed[model];
 speed[model]={avg_ms:Math.round(old?old.avg_ms*0.7+ms*0.3:ms),last_ms:ms,steps:(old?.steps??0)+1,at:new Date().toISOString()};
 await mkdir(dirname(path),{recursive:true});
 const tmp=`${path}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(speed,null,1));await rename(tmp,path);
}
// Under `node --test` agy is tried only where a test passes its own models: a fixture's fake CLI is not agy.
export const ORDER_PATH=process.env.NODE_TEST_CONTEXT?null:join(ROOT,'state','agy-models.json');
// The order in use, for JobAgent's Applications page (how many agy models are left beside the engine menus).
export function publishOrder(order,{path=ORDER_PATH}={}){
 if(!path)return;
 try{
  if(JSON.parse(readFileSync(path,'utf8')).order?.join()===order.join())return;
 }catch{}
 try{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify({order,at:new Date().toISOString()}));}catch{}
}
export const agyModels=()=>{
 if(process.env.NODE_TEST_CONTEXT)return [];
 const fixed=setting('agy.models',null);
 const order=Array.isArray(fixed)&&fixed.length?fixed:orderBySpeed(DEFAULT_AGY_MODELS);
 publishOrder(order);
 return order;
};

const LIMIT=/(?:usage|session|weekly|daily|rate) limit|limit reached|reached your .{0,40}limit|quota|too many requests|resource.?exhausted|\b429\b|out of credits|exhausted/i;
export const isLimitText=text=>LIMIT.test(String(text??''));

// When a limit lifts: an ISO time, "resets 5pm" / "resets at 11:30 pm" (same reading as JobAgent's
// limit_resets_at), "resets in 2 hours" / "try again in 45 minutes"; otherwise check again in `fallbackMinutes`.
export function resetsAt(text,{now=new Date(),fallbackMinutes=30}={}){
 const s=String(text??'');
 const iso=s.match(/\b(20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)/);
 if(iso){const t=new Date(iso[1]);if(t>now)return t.toISOString();}
 // "resets in 4h34m15s" (agy), "try again in 2 hours", "in 45 minutes"
 const rel=s.match(/(?:resets?|try again|retry)\s+in\s+(?:about\s+)?((?:\d+\s*(?:h|hours?|m|min|minutes?|s|sec|seconds?)\s*)+)/i);
 if(rel){
  let ms=0;for(const [,n,u] of rel[1].matchAll(/(\d+)\s*(h|hours?|m|min|minutes?|s|sec|seconds?)/gi))ms+=Number(n)*(/^h/i.test(u)?3600e3:/^m/i.test(u)?60e3:1e3);
  if(ms)return new Date(now.getTime()+ms+60e3).toISOString();
 }
 const at=s.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
 if(at){
  let hour=Number(at[1]);const minute=Number(at[2]||0),mer=(at[3]||'').toLowerCase();
  if(mer.startsWith('p')&&hour<12)hour+=12;if(mer.startsWith('a')&&hour===12)hour=0;
  if(hour<=23&&minute<=59){const t=new Date(now);t.setHours(hour,minute,0,0);if(t<=now)t.setDate(t.getDate()+1);return new Date(t.getTime()+60e3).toISOString();}
 }
 return new Date(now.getTime()+fallbackMinutes*60e3).toISOString();
}

// "5:07pm" in this Mac's time zone.
export const clock=t=>{const h=t.getHours(),m=t.getMinutes();return `${h%12||12}:${String(m).padStart(2,'0')}${h<12?'am':'pm'}`;};

export function readLimits(path=LIMITS_PATH){
 if(!path)return {engines:{},agy:{},opencode:{}};
 try{const d=JSON.parse(readFileSync(path,'utf8'));return {engines:d.engines??{},agy:d.agy??{},opencode:d.opencode??{}};}catch{return {engines:{},agy:{},opencode:{}};}
}
async function writeLimits(limits,path=LIMITS_PATH){
 if(!path)return;
 await mkdir(dirname(path),{recursive:true});
 const tmp=`${path}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(limits,null,1));await rename(tmp,path);
}
// Read-modify-write; workers race only on separate keys, and a lost mark costs one extra failed call.
async function mark(kind,name,message,{path=LIMITS_PATH,now=new Date()}={}){
 const limits=readLimits(path);
 limits[kind][name]={until:resetsAt(message,{now}),message:String(message).slice(0,300),at:now.toISOString()};
 await writeLimits(limits,path);
 return limits[kind][name];
}
const active=(entry,now)=>Boolean(entry?.until&&new Date(entry.until)>now);
export const engineLimited=(engine,{path=LIMITS_PATH,now=new Date()}={})=>active(readLimits(path).engines[engine],now);

// agy's agent explores the machine when it may (measured 2026-10-24: Gemini ran `pwd`, `ls` and a dozen
// more shell commands before filling one email field, ~60 s, and some steps ended "interrupted"), so
// a step on agy says the JSON is all it needs and runs from an empty directory in agy's sandbox.
export const AGY_STEP_RULE='Everything you need is in the JSON below. Do not run commands, read files, browse or use any tool: reply with the action JSON at once.';

// One agy turn: the prompt as an argument (agy's stdin format needs an undocumented envelope), the
// action schema enforced by --json-schema. A limit is thrown as {limit:true}.
// agy's last stdout line is its one JSON result; anything else (or nothing) is not an answer.
function finalResult(stdout){
 try{const result=JSON.parse(String(stdout??'').trim().split('\n').filter(Boolean).pop());return result&&typeof result==='object'&&typeof result.status==='string'?result:null;}
 catch{return null;}
}
// agy's result when the worker's SIGTERM cut it off mid-turn (the model never answered).
const killedResult=result=>result.status!=='SUCCESS'&&(result.finished_reason==='interrupted'||/^(?:interrupted|context canceled)$/i.test(String(result.error??'').trim()));
export async function decideAgy({model,prompt,system='',schema,execImpl,command=AGY,cwd,timeoutSeconds}){
 const text=`${system}\n${AGY_STEP_RULE}\n\n${prompt}`;
 if(Buffer.byteLength(text)>900_000)throw new Error('The step prompt is too large to pass to agy');
 const args=['--output-format','json','--json-schema',JSON.stringify(schema),'--model',model,'--dangerously-skip-permissions','--sandbox','--disable-slash-commands'];
 if(timeoutSeconds)args.push('--print-timeout',`${timeoutSeconds}s`);
 args.push(`-p=${text}`);
 const dir=cwd??await mkdtemp(join(tmpdir(),'agy-step-'));
 let code,stdout,stderr;
 try{({code,stdout,stderr}=await execImpl(command,args,'',{cwd:dir}));}
 catch(error){
  // agy sometimes prints its complete final JSON and then never exits (Howmet 13039: three models in a row
  // "did not answer within 180s" with ~565 stdout bytes each). The answer was given; a result on stdout at
  // the timeout is read as the model's reply instead of counting as a timeout.
  const result=error?.code==='CLI_TIMEOUT'?finalResult(error.stdout):null;
  // The SIGTERM that ends the step makes agy print its own last result ({"status":"ERROR","error":"interrupted"
  // or "context canceled","finished_reason":"interrupted"}). That is the kill, not the model's reply: reporting
  // it as "agy <model> failed: interrupted" hid three plain 180 s timeouts (Honda 15037, lesson 447).
  if(!result||killedResult(result))throw error;
  code=0;stdout=error.stdout;stderr=error.stderr??'';
 }
 finally{if(!cwd)await rm(dir,{recursive:true,force:true}).catch(()=>{});}
 let result=finalResult(stdout);
 if(code!==0||!result||result.status!=='SUCCESS'){
  const why=`${result?.error??''} ${stderr??''}`.trim()||`exit ${code}`;
  throw Object.assign(new Error(`agy ${model} failed: ${why.slice(0,300)}`),{limit:isLimitText(why),unknownModel:/not recognized as a known model/i.test(why)});
 }
 // A SUCCESS turn can still carry no answer (seen 2026-10-24, job 13044: three models in a row returned
 // an empty response). That is this model failing, or its quota if stderr says so, never a bare
 // "Unexpected end of JSON input" that ends the run.
 let action=result.structured_output;
 if(action==null){try{action=JSON.parse(result.response);}catch{}}
 if(action==null||typeof action!=='object'){
  const why=`agy ${model} returned no action (${String(result.response??'').trim()?'unparseable response':'empty response'}). ${stderr??''}`.trim();
  throw Object.assign(new Error(why.slice(0,300)),{limit:isLimitText(why),unknownModel:false});
 }
 return {action,usage:{input_tokens:result.usage?.input_tokens??0,cache_read_input_tokens:result.usage?.cache_read_tokens??0,cache_creation_input_tokens:result.usage?.cache_creation_tokens??0,output_tokens:(result.usage?.output_tokens??0)+(result.usage?.thinking_tokens??0)},via:`agy:${model}`};
}

// Mailbox, verification and option-mapping calls need Claude or Codex (agy has no Gmail connector),
// so a run on the agy engine uses Claude for them, with Claude's own CLI and default model.
export const helperAgent=({engine,command,model}={})=>['agy','opencode'].includes(engine)?{engine:'claude',command:undefined,model:undefined}:{engine,command,model};

// Each worker process runs one application: tell its event log once which agy model took over.
const announced=new Set();

// Runs the engine unless its limit is still in force; on a limit, works through agy's models.
// onModel receives who answered each step: the engine name, or "agy:<model>", for the run's state.
export async function withAgyFallback(engine,primary,viaAgy,{path=LIMITS_PATH,now=()=>new Date(),models=agyModels(),log=()=>{},onModel=()=>{},speedPath=SPEED_PATH,openCodeModels=async()=>[],viaOpenCode=async()=>null}={}){
 let engineError=null;
 // The agy engine (chosen on the Applications page) has no primary: its models are the engine.
 if(engine==='agy')engineError=new Error('agy usage limit reached: every agy model is at its limit.');
 else if(!engineLimited(engine,{path,now:now()})){
  try{const result=await primary();await onModel(engine);return result;}
  catch(error){
   if(!isLimitText(error?.message))throw error;
   engineError=error;
   const entry=await mark('engines',engine,error.message,{path,now:now()});
   await log(`${engine} reached its usage limit (until ${entry.until}); continuing on agy.`);
  }
 }else{
  const stored=readLimits(path).engines[engine]?.message??'',head=`${engine==='codex'?'Codex':'Claude'} usage limit reached.`;
  engineError=new Error(stored.startsWith(head)?stored:`${head} ${stored}`.trim());
 }
 const failures=[];
 for(const model of models){
  if(active(readLimits(path).agy[model],now()))continue;
  try{
   const started=Date.now();
   const result=await viaAgy(model);
   await recordSpeed(model,Date.now()-started,{path:speedPath});
   await onModel(`agy:${model}`);
   if(engine!=='agy'&&!announced.has(model)){announced.add(model);await log(`${engine==='codex'?'Codex':'Claude'} is at its limit (${String(engineError.message).replace(/^(Claude|Codex) usage limit reached\.\s*/,'').slice(0,140)}); steps now run on agy ${model}.`);}
   return result;
  }
  catch(error){
   // Any other agy failure (bad output, a crash) is not that model's limit: note it and try the next one.
   if(!error?.limit&&!error?.unknownModel){failures.push(String(error?.message??error).slice(0,160));await log(`agy ${model} failed (${failures.at(-1)}); trying the next agy model.`);continue;}
   await mark('agy',model,error.unknownModel?`${error.message} (rechecked in a day)`:error.message,{path,now:now()});
   if(error.unknownModel){const l=readLimits(path);l.agy[model].until=new Date(now().getTime()+864e5).toISOString();await writeLimits(l,path);}
   await log(`agy ${model} ${error.unknownModel?'is not available':'reached its limit'}; trying the next agy model.`);
  }
 }
 // Keep the fallback ladder cheap: OpenCode is reached only after the selected provider and all
 // available agy models have hit their usage limits. Only the CLI's free models count: OpenCode keeps its
 // own provider logins, so a paid model listed there would bill outside the stripped API-key environment.
 if(!failures.length){
  let candidates=[];try{candidates=(await openCodeModels()).filter(model=>/-free$/i.test(model));}catch{}
  for(const model of candidates){
   if(active(readLimits(path).opencode[model],now()))continue;
   try{const result=await viaOpenCode(model);await onModel(`opencode:${model}`);await log(`agy models are at their limits; continuing on OpenCode ${model}.`);return result;}
   catch(error){
    // Any other failure is an ordinary step failure, never a limit that pauses every worker.
    if(!error?.limit){failures.push(`OpenCode ${model}: ${String(error?.message??error).slice(0,160)}`);await log(`OpenCode ${model} failed (${failures.at(-1)}); trying the next OpenCode model.`);continue;}
    await mark('opencode',model,error.message,{path,now:now()});
    await log(`OpenCode ${model} reached its usage limit; trying the next available model.`);
   }
  }
 }
 // Every agy model is limited too: surface the engine's own limit so JobAgent pauses, and name the
 // earliest time anything frees up in the "resets 5:07pm" form its limit_resets_at reads (within a day).
 const limits=readLimits(path);
 const next=[limits.engines[engine]?.until,...models.map(m=>limits.agy[m]?.until),...Object.values(limits.opencode).map(item=>item?.until)].filter(Boolean).map(t=>new Date(t)).sort((a,b)=>a-b)[0];
 const soon=next&&next-now()<864e5?` Next capacity: resets ${clock(next)}.`:'';
 // A model that failed for another reason (a crash, a timeout, "interrupted") is not a plan limit:
 // report an ordinary step failure, which the worker retries, instead of pausing every worker
 // until a reset (that happened once: three "interrupted" Gemini answers paused JobAgent for 4 h).
 if(failures.length)throw new Error(`agy${failures.some(f=>f.startsWith('OpenCode '))?' and OpenCode':''} could not answer this step: ${failures.join(' | ').slice(0,400)}`);
 throw Object.assign(new Error(`${engineError.message.slice(0,400)} All agy and available OpenCode models are also at their limits.${soon}`),{limit:true});
}
