import test from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';
import {amazonSigninPage,verifiedSigninCode,completeSigninVerification} from '../src/signin-verification.mjs';
const now=Date.now(),after=new Date(now-30000).toISOString();
const message={messageId:'abcdef1234567890',receivedAt:new Date(now-10000).toISOString(),sender:'noreply@portal-na.idprism-auth.amazon.dev',recipients:['fixture@example.com'],subject:'Your Amazon A to Z verification code',body:'Your verification code is: <div>123456</div> This code expires in <strong>3 minutes</strong>.'};
const job={url:'https://account.amazon.jobs/jobs/123/apply'};
const url='https://atozpublic.idprism-auth.amazon.com/';
const options={email:'fixture@example.com',after,now:()=>now,wait:async()=>{}};
const execFor=value=>async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}})});
test('sign-in codes require exact host, sender, recipient, freshness and verification body',()=>{
 assert.equal(amazonSigninPage(url,job.url),true);
 for(const invalid of[url.replace('amazon.com','amazon.com.evil.example'),url.replace('https:','http:')])assert.equal(amazonSigninPage(invalid,job.url),false);
 assert.equal(amazonSigninPage(url,'https://evil.example/jobs/123'),false);
 assert.equal(verifiedSigninCode(message,{...options,now}),'123456');
 for(const change of[{sender:'noreply@evil.example'},{recipients:['another@example.com']},{subject:'Other code'},{receivedAt:new Date(now-181000).toISOString()},{receivedAt:new Date(now+1000).toISOString()},{receivedAt:new Date(now-40000).toISOString()},{body:'123456 unrelated'},{body:'Your verification code is: [one-time authentication code withheld] This code expires in 3 minutes.'}])assert.equal(verifiedSigninCode({...message,...change},{...options,now}),null);
});
test('local Amazon six-box fixture verifies sign-in once and never submits an application',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});let posts=0,lookups=0;
  await page.route('**/*',route=>{if(route.request().method()==='POST')posts++;return route.fulfill({contentType:'text/html',body:`<h1>Verify your email</h1><p>Enter verification code</p>${'<input maxlength="1">'.repeat(6)}<button onclick="if([...document.querySelectorAll('input')].map(x=>x.value).join('')==='123456')document.body.innerHTML='<h1>Candidate application form</h1>'">Verify</button>`});});
  await page.goto(url);
  const result=await completeSigninVerification(page,job,{...options,execImpl:async(...args)=>{lookups++;assert.match(args[2],/full-message read tool/);return execFor(message)();}});
  assert.deepEqual(result,{needed:true,completed:true});assert.equal(lookups,1);assert.equal(posts,0);
  assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:()=>assert.fail('no repeat lookup')}),{needed:false});
  for(const evidence of[{...message,recipients:['other@example.com']},{...message,body:'code withheld'}]){
   await page.goto(url);
   assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:execFor(evidence)}),{needed:true,completed:false,reason:'mailbox result failed the sender, recipient, freshness or code checks'});
   assert.deepEqual(await page.locator('input').evaluateAll(xs=>xs.map(x=>x.value)),Array(6).fill(''));
  }
  await page.goto('https://evil.example/');
  assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:()=>assert.fail('foreign host')}),{needed:false});
 }finally{await browser.close();}
});

test('sign-in bridge reads the page directly without supplied form controls and leaves incomplete gates untouched',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  let boxes=6,verifyClicks=0,resends=0,lookups=0;
  await page.exposeFunction('verified',()=>verifyClicks++);
  await page.exposeFunction('resent',()=>resends++);
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<h1>Verify your email</h1><p>Enter verification code</p>${'<input maxlength="1">'.repeat(boxes)}<button onclick="verified();document.body.innerHTML='<h1>Signed in</h1>'">Verify</button><button onclick="resent()">Resend code</button>`}));
  // The model's supplied-controls list is deliberately absent: this hook runs before decisions.
  for(const count of [5,7]){
   boxes=count;await page.goto(url);
   assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:()=>assert.fail('ambiguous gate must not read mail')}),{needed:true,completed:false});
   assert.deepEqual(await page.locator('input').evaluateAll(xs=>xs.map(x=>x.value)),Array(count).fill(''));
  }
  boxes=6;await page.goto(url);
  assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:async()=>{lookups++;return execFor(message)();}}),{needed:true,completed:true});
  assert.equal(lookups,1);assert.equal(verifyClicks,1);assert.equal(resends,0);
 }finally{await browser.close();}
});

test('a code email that arrives after the first lookup is found on a later one (Amazon 11836)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();let lookups=0,waited=0;
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<h1>Verify your email</h1>${'<input maxlength="1">'.repeat(6)}<button onclick="document.body.innerHTML='<h1>Signed in</h1>'">Verify</button>`}));
  await page.goto(url);
  const result=await completeSigninVerification(page,job,{...options,wait:async ms=>{waited+=ms;},execImpl:async()=>{lookups++;return execFor(lookups<2?{}:message)();}});
  assert.deepEqual(result,{needed:true,completed:true});assert.equal(lookups,2);assert.equal(waited,15000);
  await page.goto(url);lookups=0;
  assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:async()=>{lookups++;return execFor({})();}}),{needed:true,completed:false,reason:'mailbox result failed the sender, recipient, freshness or code checks'});
  assert.equal(lookups,3);
 }finally{await browser.close();}
});

test('a failed mailbox lookup names its cause without mail content (Amazon 11843, Gmail connector down)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<h1>Verify your email</h1>${'<input maxlength="1">'.repeat(6)}<button onclick="document.body.innerHTML='<h1>Signed in</h1>'">Verify</button>`}));
  const run=async execImpl=>{await page.goto(url);return completeSigninVerification(page,job,{...options,attempts:1,execImpl});};
  assert.deepEqual(await run(async()=>({code:1,stdout:'',stderr:'MCP server claude_ai_Gmail unavailable\n'})),{needed:true,completed:false,reason:'mailbox lookup exited 1: MCP server claude_ai_Gmail unavailable'});
  assert.deepEqual(await run(async()=>({code:2,stdout:'',stderr:''})),{needed:true,completed:false,reason:'mailbox lookup exited 2: no error output'});
  assert.deepEqual(await run(async()=>{const e=new Error('spawn timed out');e.code='ETIMEDOUT';throw e;}),{needed:true,completed:false,reason:'mailbox lookup failed: ETIMEDOUT'});
  assert.deepEqual(await run(async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'NONE'}})})),{needed:true,completed:false,reason:'mailbox reported no matching mail'});
  // A non-JSON answer is never echoed: it could contain the code itself.
  const leaked=await run(async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Your verification code is: 123456'}})}));
  assert.deepEqual(leaked,{needed:true,completed:false,reason:'mailbox result was not JSON'});
  assert.deepEqual(await page.locator('input').evaluateAll(xs=>xs.map(x=>x.value)),Array(6).fill(''));
  // The last attempt's outcome is reported when a later one differs.
  let n=0;await page.goto(url);
  assert.deepEqual(await completeSigninVerification(page,job,{...options,attempts:2,execImpl:async()=>++n===1?{code:1,stdout:'',stderr:'down'}:execFor({})()}),{needed:true,completed:false,reason:'mailbox result failed the sender, recipient, freshness or code checks'});
 }finally{await browser.close();}
});
