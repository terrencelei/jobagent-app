import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withAgyFallback,decideAgy,resetsAt,readLimits,isLimitText,AGY_STEP_RULE} from '../src/model-fallback.mjs';

const tmp=async()=>join(await mkdtemp(join(tmpdir(),'limits-')),'model-limits.json');
const limitError=msg=>new Error(msg);

test('reset times are read the way JobAgent reads them, with relative and ISO forms', ()=>{
 const now=new Date(2026,9,24,14,0,0);
 assert.equal(new Date(resetsAt('You have hit your session limit · resets 5pm',{now})).getHours(),17);
 assert.equal(new Date(resetsAt('resets at 1:30 am',{now})).getDate(),25);
 assert.equal(new Date(resetsAt('try again in 2 hours',{now})).getTime(),now.getTime()+2*3600e3+60e3);
 assert.equal(resetsAt('quota until 2026-10-24T23:00:00Z',{now}),'2026-10-24T23:00:00.000Z');
 assert.equal(new Date(resetsAt('no time here',{now})).getTime(),now.getTime()+30*60e3);
 assert.ok(isLimitText('RESOURCE_EXHAUSTED: quota exceeded')&&isLimitText('Claude usage limit reached.')&&!isLimitText('Timeout 10000ms exceeded'));
});

test('Claude answers while it has capacity; agy is untouched', async ()=>{
 const path=await tmp();
 const r=await withAgyFallback('claude',async()=>({action:'claude'}),async()=>{throw new Error('agy should not run');},{path,models:['m1']});
 assert.deepEqual(r,{action:'claude'});
});

test('at the Claude limit the step goes to agy, and later steps skip Claude until its reset', async ()=>{
 const path=await tmp();let now=new Date(2026,9,24,14,0,0);let claudeCalls=0;const logs=[];
 const opts={path,models:['m1','m2'],now:()=>now,log:m=>logs.push(m)};
 const claude=async()=>{claudeCalls++;throw limitError("Claude usage limit reached. You've hit your session limit · resets 5pm");};
 const r=await withAgyFallback('claude',claude,async m=>({action:m}),opts);
 assert.deepEqual(r,{action:'m1'});assert.equal(claudeCalls,1);assert.match(logs[0],/claude reached its usage limit/);
 assert.equal(new Date(readLimits(path).engines.claude.until).getHours(),17);
 await withAgyFallback('claude',claude,async m=>({action:m}),opts);
 assert.equal(claudeCalls,1);                                   // still limited: not asked again
 now=new Date(2026,9,24,17,5,0);
 const back=await withAgyFallback('claude',async()=>({action:'claude'}),async()=>{throw new Error('no');},opts);
 assert.deepEqual(back,{action:'claude'});                      // reset passed: Claude again
});

test('agy models are used in turn as each reaches its limit', async ()=>{
 const path=await tmp();const tried=[];
 const opts={path,models:['m1','m2','m3']};
 const agy=async m=>{tried.push(m);if(m!=='m3')throw Object.assign(new Error(`agy ${m} failed: quota exhausted`),{limit:true});return {action:m};};
 const r=await withAgyFallback('claude',async()=>{throw limitError('Claude usage limit reached.');},agy,opts);
 assert.deepEqual(r,{action:'m3'});assert.deepEqual(tried,['m1','m2','m3']);
 tried.length=0;await withAgyFallback('claude',async()=>{throw new Error('skipped');},agy,opts);
 assert.deepEqual(tried,['m3']);                                // limited models are skipped while limited
});

test('with every agy model limited the engine limit surfaces so JobAgent pauses as before', async ()=>{
 const path=await tmp();
 const agy=async m=>{throw Object.assign(new Error(`agy ${m} failed: rate limit`),{limit:true});};
 await assert.rejects(withAgyFallback('claude',async()=>{throw limitError('Claude usage limit reached. resets 5pm');},agy,{path,models:['m1','m2']}),
  e=>/Claude usage limit reached\. resets 5pm.*All agy and available OpenCode models are also at their limits/.test(e.message)&&/(?:usage|session|weekly|daily) limit/i.test(e.message));
});

test('an ordinary engine error is not treated as a limit', async ()=>{
 const path=await tmp();
 await assert.rejects(withAgyFallback('claude',async()=>{throw new Error('Claude CLI failed (exit 1)');},async()=>({action:'x'}),{path,models:['m1']}),/Claude CLI failed/);
 assert.deepEqual(readLimits(path).engines,{});
});

test('decideAgy passes the prompt as -p, enforces the schema and reads structured output', async ()=>{
 let seen;
 const execImpl=async(cmd,args)=>{seen=args;return {code:0,stdout:JSON.stringify({status:'SUCCESS',response:'{"action":"fill"}',structured_output:{action:'fill',control:'f1'},usage:{input_tokens:10,output_tokens:2,thinking_tokens:3,cache_read_tokens:5}}),stderr:''};};
 const r=await decideAgy({model:'m1',prompt:'P',system:'S',schema:{type:'object'},execImpl,command:'agy'});
 assert.deepEqual(r,{action:{action:'fill',control:'f1'},usage:{input_tokens:10,cache_read_input_tokens:5,cache_creation_input_tokens:0,output_tokens:5},via:'agy:m1'});
 assert.equal(seen.at(-1),`-p=S\n${AGY_STEP_RULE}\n\nP`);assert.ok(seen.includes('--json-schema')&&seen.includes('m1')&&seen.includes('--sandbox'));
 const limited=async()=>({code:0,stdout:JSON.stringify({status:'ERROR',error:'RESOURCE_EXHAUSTED: You have exhausted your quota'}),stderr:''});
 await assert.rejects(decideAgy({model:'m1',prompt:'P',schema:{},execImpl:limited}),e=>e.limit===true);
});

test('decideAgy reports an empty SUCCESS answer as that model failing, or as its limit when agy says so', async ()=>{
 const empty=stderr=>async()=>({code:0,stdout:JSON.stringify({status:'SUCCESS',response:''}),stderr});
 await assert.rejects(decideAgy({model:'m1',prompt:'P',schema:{},execImpl:empty('')}),e=>/agy m1 returned no action \(empty response\)/.test(e.message)&&!e.limit);
 await assert.rejects(decideAgy({model:'m1',prompt:'P',schema:{},execImpl:empty('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h51m55s.')}),e=>e.limit===true);
 const fromResponse=async()=>({code:0,stdout:JSON.stringify({status:'SUCCESS',response:'{"action":"fill"}'}),stderr:''});
 assert.deepEqual((await decideAgy({model:'m1',prompt:'P',schema:{},execImpl:fromResponse})).action,{action:'fill'});
});

test('JobAgent\'s 80% mark sends steps to agy, and the all-limited error still reads as a usage limit with a reset time', async ()=>{
 const {writeFile}=await import('node:fs/promises');
 const path=await tmp();const now=new Date(2026,9,24,14,0,0);
 await writeFile(path,JSON.stringify({engines:{claude:{until:new Date(2026,9,28,22).toISOString(),message:'Claude usage 84% (seven-day window) reached your 80% limit; applications continue on agy until it resets',source:'usage_pause'}},
  agy:{m1:{until:new Date(2026,9,24,17,7).toISOString()}}}));
 let claude=0;
 const ok=await withAgyFallback('claude',async()=>{claude++;return {action:'claude'};},async m=>({action:m}),{path,models:['m1','m2'],now:()=>now});
 assert.deepEqual(ok,{action:'m2'});assert.equal(claude,0);
 const agy=async m=>{throw Object.assign(new Error(`agy ${m} failed: quota`),{limit:true});};
 await assert.rejects(withAgyFallback('claude',async()=>({}),agy,{path,models:['m1','m2'],now:()=>now}),
  e=>/^Claude usage limit reached\. Claude usage 84%/.test(e.message)&&/resets 2:30pm\.$/.test(e.message));  // m2 marked now with no stated reset: +30 min
});

test('an agy failure that is not a limit moves on to the next model; if none answers the engine limit stands', async ()=>{
 const path=await tmp();const tried=[];
 const agy=async m=>{tried.push(m);if(m==='m1')throw new Error('agy m1 failed: exit 0');return {action:m};};
 assert.deepEqual(await withAgyFallback('claude',async()=>{throw new Error('Claude usage limit reached.');},agy,{path,models:['m1','m2']}),{action:'m2'});
 assert.equal(readLimits(path).agy.m1,undefined);               // not marked: a one-off failure
 await assert.rejects(withAgyFallback('claude',async()=>{throw new Error('Claude usage limit reached.');},async()=>{throw new Error('broken');},{path,models:['m1']}),
  e=>/^agy could not answer this step: broken/.test(e.message)&&!e.limit&&!/usage limit/i.test(e.message));   // not a plan limit: no JobAgent pause
});

test('test processes never persist limits, so a fixture cannot mark the live engine limited', async ()=>{
 const {LIMITS_PATH}=await import('../src/model-fallback.mjs');
 assert.equal(LIMITS_PATH,null);
 await withAgyFallback('claude',async()=>{throw new Error('Claude usage limit reached.');},async()=>({action:'x'}),{models:['m1']});
 assert.deepEqual(readLimits(),{engines:{},agy:{},opencode:{}});
});

test('the run log says once which agy model took over', async ()=>{
 const logs=[];
 for(let i=0;i<2;i++)await withAgyFallback('claude',async()=>{throw new Error('Claude usage limit reached. resets 5pm');},async m=>({action:m}),{models:['m-log'],log:m=>logs.push(m)});
 assert.equal(logs.filter(m=>/steps now run on agy m-log/.test(m)).length,1);
});

test('each step reports which model answered, for the run state and the dashboard', async ()=>{
 const seen=[];const onModel=m=>seen.push(m);
 await withAgyFallback('claude',async()=>({action:'c'}),async m=>({action:m}),{models:['m1'],onModel});
 await withAgyFallback('claude',async()=>{throw new Error('Claude usage limit reached.');},async m=>({action:m}),{models:['m1'],onModel});
 assert.deepEqual(seen,['claude','agy:m1']);
});

test('the agy engine runs on agy models from the start; mailbox helpers stay on Claude', async ()=>{
 const {helperAgent}=await import('../src/model-fallback.mjs');
 const seen=[];
 const r=await withAgyFallback('agy',async()=>{throw new Error('primary must not run');},async m=>({action:m}),{models:['m1'],onModel:m=>seen.push(m)});
 assert.deepEqual(r,{action:'m1'});assert.deepEqual(seen,['agy:m1']);
 await assert.rejects(withAgyFallback('agy',async()=>({}),async m=>{throw Object.assign(new Error('quota'),{limit:true});},{models:['m1']}),
  e=>/^agy usage limit reached/.test(e.message)&&e.limit===true);
 assert.deepEqual(helperAgent({engine:'agy',command:'/x/agy',model:null}),{engine:'claude',command:undefined,model:undefined});
 assert.deepEqual(helperAgent({engine:'codex',command:'/x/codex',model:'m'}),{engine:'codex',command:'/x/codex',model:'m'});
});

test('agy models are tried fastest first, by measured step time', async ()=>{
 const {orderBySpeed,recordSpeed,DEFAULT_AGY_MODELS}=await import('../src/model-fallback.mjs');
 assert.equal(orderBySpeed(DEFAULT_AGY_MODELS,{})[0],'gemini-3.8-flash-low');
 assert.deepEqual(orderBySpeed(DEFAULT_AGY_MODELS,{}),DEFAULT_AGY_MODELS);              // the default list is already fastest first
 const order=orderBySpeed(['a','b','c'],{a:{avg_ms:9000},b:{avg_ms:2000}});      // c untimed: neutral 30 s
 assert.deepEqual(order,['b','a','c']);
 const path=join(await mkdtemp(join(tmpdir(),'speed-')),'agy-speed.json');
 await recordSpeed('x',10000,{path});await recordSpeed('x',20000,{path});
 const {readFileSync}=await import('node:fs');
 assert.equal(JSON.parse(readFileSync(path,'utf8')).x.avg_ms,13000);
});

test('agy\'s "Resets in 4h34m15s" is read as a duration', ()=>{
 const now=new Date(2026,9,24,14,0,0);
 assert.equal(resetsAt('Individual quota reached. Resets in 4h34m15s.',{now}),new Date(now.getTime()+(4*3600+34*60+15)*1e3+60e3).toISOString());
});

test('the agy order in use is published for the Applications page, rewritten only when it changes', async ()=>{
 const {publishOrder}=await import('../src/model-fallback.mjs');
 const {readFileSync,statSync}=await import('node:fs');
 const path=join(await mkdtemp(join(tmpdir(),'order-')),'agy-models.json');
 publishOrder(['a','b'],{path});const first=readFileSync(path,'utf8');
 publishOrder(['a','b'],{path});assert.equal(readFileSync(path,'utf8'),first);
 publishOrder(['b','a'],{path});assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).order,['b','a']);
});

test('an agy answer printed before the CLI hung is read at the timeout instead of failing the step', async ()=>{
 // Howmet 13039 (lesson 367): agy wrote its whole JSON result, then never exited, so execCLI killed it at 180 s.
 const result=JSON.stringify({status:'SUCCESS',response:'{"action":"fill"}',structured_output:{action:'fill',control:'f1'},usage:{input_tokens:1,output_tokens:1}});
 const hung=stdout=>async()=>{throw Object.assign(new Error('agy did not answer within 180s. CLI progress: 565 stdout bytes, 19 stderr bytes, 0 recognized events, last stage none'),{code:'CLI_TIMEOUT',processClosed:true,stdout,stderr:'x'.repeat(19)});};
 assert.deepEqual((await decideAgy({model:'m1',prompt:'P',schema:{},execImpl:hung(result)})).action,{action:'fill',control:'f1'});
 // A hung quota answer is still that model's limit; partial or empty output stays a timeout.
 await assert.rejects(decideAgy({model:'m1',prompt:'P',schema:{},execImpl:hung(JSON.stringify({status:'ERROR',error:'RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h'}))}),e=>e.limit===true);
 await assert.rejects(decideAgy({model:'m1',prompt:'P',schema:{},execImpl:hung('{"status":"SUCC')}),e=>e.code==='CLI_TIMEOUT');
 await assert.rejects(decideAgy({model:'m1',prompt:'P',schema:{},execImpl:hung('')}),e=>e.code==='CLI_TIMEOUT');
});

test('agy\'s own "interrupted" result at the step timeout stays a timeout, not a model answer', async ()=>{
 // Honda 15037 (lesson 447): execCLI's SIGTERM at 180 s made agy print {"status":"ERROR","error":"interrupted"} (or
 // "context canceled" when killed earlier), and three plain timeouts were reported as "agy <model> failed: interrupted".
 const killed=(error,finished_reason)=>async()=>{throw Object.assign(new Error('agy did not answer within 180s. CLI progress: 240 stdout bytes, 19 stderr bytes, 0 recognized events, last stage none'),{code:'CLI_TIMEOUT',processClosed:true,stdout:JSON.stringify({conversation_id:'',status:'ERROR',response:'',error,duration_seconds:0,num_turns:0,finished_reason}),stderr:`error: ${error}`});};
 await assert.rejects(decideAgy({model:'m1',prompt:'P',schema:{},execImpl:killed('interrupted','interrupted')}),e=>e.code==='CLI_TIMEOUT'&&/did not answer within 180s/.test(e.message)&&!e.limit);
 await assert.rejects(decideAgy({model:'m1',prompt:'P',schema:{},execImpl:killed('context canceled','interrupted')}),e=>e.code==='CLI_TIMEOUT'&&!e.limit);
 // A real model error written before the kill is still that model's own failure (and its limit when it says so).
 await assert.rejects(decideAgy({model:'m1',prompt:'P',schema:{},execImpl:killed('RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h','stop')}),e=>e.limit===true);
});

test('OpenCode is tried only on free models, and its crashes are a step failure, not a limit that pauses workers', async ()=>{
 const path=await tmp();const tried=[];
 const agy=async m=>{throw Object.assign(new Error(`agy ${m} failed: rate limit`),{limit:true});};
 const viaOpenCode=async m=>{tried.push(m);throw new Error('OpenCode failed: crashed');};
 await assert.rejects(withAgyFallback('claude',async()=>{throw limitError('Claude usage limit reached. resets 5pm');},agy,
  {path,models:['m1'],openCodeModels:async()=>['opencode/beam-free','anthropic/claude-opus-5-5'],viaOpenCode}),
  e=>!e.limit&&/agy and OpenCode could not answer this step: OpenCode opencode\/beam-free/.test(e.message));
 assert.deepEqual(tried,['opencode/beam-free']);
 assert.deepEqual(readLimits(path).opencode,{});
 assert.deepEqual(readLimits(null),{engines:{},agy:{},opencode:{}});
});
