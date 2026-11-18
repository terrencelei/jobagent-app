import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {decide,execCLI,snapshot} from '../src/dashboard-worker.mjs';

// Claude step 11832 (CFS) stalled with 0 bytes under buffered json output, so the stall could never be judged replay-safe.
const init=JSON.stringify({type:'system',subtype:'init',session_id:'fixture'})+'\n';
const hang=prefix=>`process.stdout.write(${JSON.stringify(prefix)});setInterval(()=>{},1000)`;
async function run(firstPrefix){
 const browser=await chromium.launch({headless:true});
 try{
  const page=await (await browser.newContext()).newPage();let posts=0,calls=0;const argsSeen=[];
  await page.route('**/*',route=>{if(route.request().method()!=='GET')posts++;return route.fulfill({contentType:'text/html',body:'<form><label>First name<input value="Fixture"></label><button type="submit">Submit application</button></form>'})});
  await page.goto('https://fixture.example.test/job');
  const snap=await snapshot(page),action={action:'review',control:snap.frames[0].controls.find(c=>c.type==='submit').id,fact:'',message:''};
  const done=init+JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:action,usage:{input_tokens:5,output_tokens:2}})+'\n';
  const outcome=await decide({engine:'claude',snap,profile:{answers:{}},bank:{},job:{company:'Fixture',title:'Engineer'},history:[],execImpl:async(command,args)=>{
   calls++;argsSeen.push(args);
   const script=calls===1?hang(firstPrefix):`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(done)}))`;
   return execCLI(process.execPath,['-e',script],'fixture',{timeout:700});
  }}).then(r=>({result:r}),error=>({error}));
  return {...outcome,calls,posts,argsSeen,action,value:await page.locator('input').inputValue()};
 }finally{await browser.close();}
}
test('a Claude step that stalls after only its init event is replayed once and the streamed result is parsed',async()=>{
 const r=await run(init);
 assert.equal(r.error,undefined);assert.deepEqual(r.result.action,r.action);assert.equal(r.calls,2);assert.equal(r.posts,0);assert.equal(r.value,'Fixture');
 assert.ok(r.argsSeen[0].includes('stream-json'));assert.deepEqual(r.argsSeen[0],r.argsSeen[1]);
});
test('a Claude step stalled on API retry/status notices after init is replayed once',async()=>{
 // Anduril 11394: init plus one ~500-byte system notice, then silence for 180s.
 const notices=[{type:'system',subtype:'api_retry',attempt:1,max_retries:10,retry_delay_ms:500,error_status:529,error:'overloaded'},{type:'system',subtype:'status',status:'requesting'},{type:'rate_limit_event',rate_limit_info:{status:'allowed'}}];
 const r=await run(init+notices.map(e=>JSON.stringify(e)+'\n').join(''));
 assert.equal(r.error,undefined);assert.deepEqual(r.result.action,r.action);assert.equal(r.calls,2);assert.equal(r.posts,0);
});
test('a Claude stall after model or tool output is never replayed',async()=>{
 for(const prefix of [init+JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Bash'}]}})+'\n','',init+'partial',init+JSON.stringify({type:'system',subtype:'hook_response'})+'\n',JSON.stringify({type:'system',subtype:'api_retry'})+'\n']){
  const r=await run(prefix);
  assert.match(String(r.error?.message),/did not answer within/);assert.equal(r.calls,1);assert.equal(r.posts,0);
 }
});

test('a Claude run that printed its final result and then hung is read as answered, not timed out (Rocket Lab 15245)',async()=>{
 const {execWithStallRetry}=await import('../src/cli-service-retry.mjs');
 const done='{"type":"system"}\n'+JSON.stringify({type:'result',is_error:false,structured_output:{action:'review'},usage:{}})+'\n';
 let calls=0;
 const hung=async()=>{calls++;throw Object.assign(new Error('claude did not answer within 180s.'),{code:'CLI_TIMEOUT',processClosed:true,stdout:done,stderr:''});};
 const r=await execWithStallRetry(hung,'claude',[],'p',{});
 assert.equal(r.code,0);assert.equal(r.stdout,done);assert.equal(calls,1);
 const noResult=async()=>{throw Object.assign(new Error('timeout'),{code:'CLI_TIMEOUT',processClosed:true,stdout:'{"type":"system"}\n',stderr:''});};
 await assert.rejects(execWithStallRetry(noResult,'claude',[],'p',{}),/timeout/);
});
