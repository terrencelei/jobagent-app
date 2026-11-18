import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {retryableCodexServiceFailure,execCodexWithServiceRetry} from '../src/cli-service-retry.mjs';
import {decide,execCLI,snapshot} from '../src/dashboard-worker.mjs';

const failure={code:1,stdout:'',stderr:'Reconnecting... 2/5 (unexpected status 503 Service Unavailable: An error occurred while processing your request.'};
test('service retries are bounded and preserve identical request and final failure',async()=>{
 const waits=[],calls=[];
 const result=await execCodexWithServiceRetry(async(...args)=>{calls.push(args);return failure;},'codex',['exec'],'prompt',{}, {wait:async ms=>waits.push(ms)});
 assert.equal(result,failure);assert.equal(calls.length,3);assert.deepEqual(waits,[1000,3000]);assert.deepEqual(calls[0],calls[2]);
});
test('never replay tools, partial answers, unknown output, auth, quota, timeout or employer errors',async()=>{
 for(const stdout of ['not json',JSON.stringify({type:'item.started',item:{type:'command_execution'}}),JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{}'}}),JSON.stringify({type:'future.event'})])assert.equal(retryableCodexServiceFailure({...failure,stdout}),false);
 for(const stderr of ['HTTP 401 Unauthorized','rate limit 429','did not answer within 180s','employer 403','502 Bad Gateway'])assert.equal(retryableCodexServiceFailure({...failure,stderr}),false);
 assert.equal(retryableCodexServiceFailure({...failure,code:0}),false);
 assert.equal(retryableCodexServiceFailure({...failure,code:null}),false);
 assert.equal(retryableCodexServiceFailure({...failure,stderr:failure.stderr+' quota exceeded'}),false);
 assert.equal(retryableCodexServiceFailure({...failure,stdout:JSON.stringify({type:'turn.failed',error:{message:'503 Service Unavailable'}})}),true);
 let calls=0;await assert.rejects(execCodexWithServiceRetry(async()=>{calls++;throw Error('timeout');},'codex',[],''),/timeout/);assert.equal(calls,1);
});
test('worker Chromium email modal survives CLI subprocess 503; recovered decision has zero browser actions or posts',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();let posts=0,calls=0;
  await page.route('**/*',route=>{if(route.request().method()!=='GET')posts++;return route.fulfill({contentType:'text/html',body:'<div role="dialog"><label>Email<input type="email" value="applicant@example.test"></label><button onclick="window.clicked=true">Continue</button></div>'});});
  await page.goto('https://fixture.example.test/job');
  const snap=await snapshot(page),button=snap.frames.flatMap(f=>f.controls).find(c=>c.text==='Continue'||c.label==='Continue');assert.ok(button);
  const action={action:'click',control:button.id,fact:'',message:''};
  const result=await decide({engine:'codex',snap,profile:{answers:{email:'applicant@example.test'}},bank:{},job:{company:'Fixture',title:'Engineer'},history:[],execImpl:async()=>{
   calls++;
   const output=calls===1?{code:1,stdout:'',stderr:failure.stderr}:{code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(action)}})+'\n',stderr:''};
   return execCLI(process.execPath,['-e',`process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(output.stdout)});process.stderr.write(${JSON.stringify(output.stderr)});process.exitCode=${output.code};});`],'fixture',{timeout:10000});
  }});
  assert.deepEqual(result.action,action);assert.equal(calls,2);assert.equal(posts,0);assert.equal(await page.evaluate(()=>Boolean(window.clicked)),false);assert.equal(await page.locator('input').inputValue(),'applicant@example.test');
 }finally{await browser.close();}
});

test('startup-only stalls retry once after confirmed exit; partial tools and unknown timeouts never replay',async()=>{
 const error=Object.assign(Error('timeout'),{code:'CLI_TIMEOUT',processClosed:true,progress:{replaySafe:true}});
 let calls=0;const waits=[];
 await assert.rejects(execCodexWithServiceRetry(async()=>{calls++;throw error},'codex',[],'',{}, {wait:async ms=>waits.push(ms)}),e=>e===error);
 assert.equal(calls,2);assert.deepEqual(waits,[1000]);
 for(const e of [Error('timeout'),{...error,code:'OTHER'},{...error,processClosed:false},{...error,progress:{replaySafe:false}}]){
  calls=0;await assert.rejects(execCodexWithServiceRetry(async()=>{calls++;throw e},'codex',[],'',{}, {wait:async()=>{}}));assert.equal(calls,1);
 }
});

test('worker Chromium preserves a prepared form through actual startup-only CLI timeout and recovery',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();let posts=0,calls=0;
  await page.route('**/*',route=>{if(route.request().method()!=='GET')posts++;return route.fulfill({contentType:'text/html',body:'<form><label>First name<input value="Fixture"></label><button type="submit">Submit application</button></form>'})});
  await page.goto('https://fixture.example.test/job');
  const snap=await snapshot(page),action={action:'review',control:snap.frames[0].controls.find(c=>c.type==='submit').id,fact:'',message:''};
  const result=await decide({engine:'codex',snap,profile:{answers:{}},bank:{},job:{company:'Fixture',title:'Engineer'},history:[],execImpl:async()=>{
   calls++;const script=calls===1?`process.stdout.write('{"type":"thread.started","thread_id":"fixture"}\\n{"type":"turn.started"}\\n');setInterval(()=>{},1000)`:`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(action)}})+'\n')}))`;
   // The first call must hit the short startup timeout; the retry gets room for a slow CI runner.
   return execCLI(process.execPath,['-e',script],'fixture',{timeout:calls===1?700:5000});
  }});
  assert.deepEqual(result.action,action);assert.equal(calls,2);assert.equal(posts,0);assert.equal(await page.locator('input').inputValue(),'Fixture');
 }finally{await browser.close()}
});

test('OpenCode runs standalone so the agent config applies, and a free-usage error event is reported as a limit', async ()=>{
 let args;
 await assert.rejects(decide({engine:'opencode',model:'opencode/beam-free',snap:{},profile:{answers:{}},bank:{},job:{company:'Fixture',title:'Engineer'},history:[],execImpl:async(_c,a)=>{args=a;return{code:1,stdout:'{"type":"error","error":{"type":"provider.free-limit","message":"Free usage limit reached."}}\n',stderr:''};}}),
  e=>e.limit===true&&/Free usage limit reached/.test(e.message));
 assert.ok(args.includes('--standalone'));
});
