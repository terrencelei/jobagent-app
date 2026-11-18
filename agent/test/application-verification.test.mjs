import test from 'node:test';import assert from 'node:assert/strict';import{chromium}from'playwright';
import{tmpdir}from'node:os';
import{verifiedApplicationCode,fetchApplicationCode,completeApplicationVerification}from'../src/application-verification.mjs';
const message={messageId:'abcdef1234567890',receivedAt:new Date().toISOString(),sender:'Greenhouse <no-reply@us.greenhouse-mail.io>',recipients:['fixture@example.com'],subject:'Security code for your application to Fixture',body:'Copy and paste this code into the security code field on your application: AB12CD34',code:'AB12CD34'};
test('application codes require the exact fresh employer email and trusted sender',()=>{
 assert.equal(verifiedApplicationCode(message,'Fixture').code,message.code);
 for(const change of[{sender:'evil@example.com'},{subject:'Security code for your application to Another'},{receivedAt:'2025-01-01'},{code:'invented'},{body:'AB12CD34 is an unrelated code'}])assert.equal(verifiedApplicationCode({...message,...change},'Fixture',{after:Date.now()/1000-60}),null);
});
test('mixed-case security codes are accepted verbatim without weakening email checks',()=>{
 const code='aB12cD34';const mixed={...message,code,body:`Copy and paste this code into the security code field on your application: ${code}`};
 assert.equal(verifiedApplicationCode(mixed,'Fixture').code,code);
 for(const change of[{code:'AB12CD34'},{code:'aB12cD3!'},{subject:'Security code for your application to Other'},{sender:'no-reply@greenhouse-mail.io.evil.example'},{receivedAt:'2025-01-01'}])assert.equal(verifiedApplicationCode({...mixed,...change},'Fixture',{after:Date.now()/1000-60}),null);
});
test('delayed security-code emails get bounded checks and preserve letter case',async()=>{
 const code='aB12cD34';const mixed={...message,code,body:`Copy and paste this code into the security code field on your application: ${code}`};
 let checks=0,waits=0;
 const result=await fetchApplicationCode({company:'Fixture'},{after:new Date().toISOString(),wait:async()=>{waits++;},execImpl:async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:++checks===1?'NONE':JSON.stringify(mixed)}})})});
 assert.equal(result.code,code);assert.equal(checks,2);assert.equal(waits,1);
 checks=0;
 assert.equal(await fetchApplicationCode({company:'Fixture'},{wait:async()=>{},execImpl:async()=>{checks++;return{code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'NONE'}})};}}),null);
 assert.equal(checks,8);  // ~2 minutes of mailbox reads before giving up (2026-10-18)
});
test('verification fills each code box with the original mixed-case characters',async()=>{
 const code='aB12cD34',values=Array(8).fill('');let clicked=0;
 const page={url:()=> 'https://job-boards.greenhouse.io/fixture/jobs/123',
  locator:selector=>selector==='body'?{innerText:async()=>clicked?'Application received':'A verification code was sent. To submit your application, enter the 8-character code.'}:{count:async()=>8,nth:i=>({fill:async value=>{values[i]=value;}})},
  getByLabel:()=>({count:async()=>0}),getByRole:()=>({count:async()=>1,click:async()=>{assert.equal(values.join(''),code);clicked++;}}),waitForTimeout:async()=>{}};
 const mixed={...message,code,body:`Copy and paste this code into the security code field on your application: ${code}`};
 const execImpl=async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(mixed)}})});
 assert.deepEqual(await completeApplicationVerification(page,{company:'Fixture'},{execImpl}),{needed:true,completed:true,messageId:message.messageId});
 assert.equal(clicked,1);
 clicked=0;values.fill('');
 const missing=async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'NONE'}})});
 let requested=0;
 assert.deepEqual(await completeApplicationVerification(page,{company:'Fixture'},{tries:1,execImpl:missing,requestCode:async()=>{requested++;return code;}}),{needed:true,completed:true,codeSource:'applicant'});
 assert.equal(requested,1);assert.equal(clicked,1);
 clicked=0;values.fill('');
 for(const supplied of[null,'bad-code']){
  assert.deepEqual(await completeApplicationVerification(page,{company:'Fixture'},{tries:1,execImpl:missing,requestCode:async()=>supplied}),{needed:true,completed:false,retrySafe:true});
  assert.equal(clicked,0);assert.equal(values.join(''),'');
 }
});
test('a redacted mailbox code goes directly to human handoff without repeated reads',async()=>{
 let checks=0;
 const result=await fetchApplicationCode({company:'Fixture'},{execImpl:async()=>{checks++;return{code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'The one-time authentication code withheld by the mailbox connector.'}})};}});
 assert.equal(result,null);assert.equal(checks,1);
});
test('Greenhouse emailed code completes only the already validated verification form',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.route('https://job-boards.greenhouse.io/**',route=>route.fulfill({contentType:'text/html',body:`<p>A verification code was sent to fixture@example.com. To submit your application, enter the 8-character code to confirm you're a human.</p>${Array.from({length:8},()=>'<input maxlength="1">').join('')}<button onclick="if([...document.querySelectorAll('input')].map(e=>e.value).join('')==='AB12CD34')document.body.innerHTML='Application received'">Submit application</button>`}));
  await page.goto('https://job-boards.greenhouse.io/fixture/jobs/123');
 const execImpl=async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(message)}})});
  assert.deepEqual(await completeApplicationVerification(page,{company:'Fixture'},{after:new Date().toISOString(),email:'fixture@example.com',execImpl}),{needed:true,completed:true,messageId:message.messageId});
  assert.equal(await page.locator('body').innerText(),'Application received');
 }finally{await browser.close();}
});
test('missing security-code mail never clicks submit and allows a reconciled retry',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.route('https://job-boards.greenhouse.io/**',route=>route.fulfill({contentType:'text/html',body:`<p>A verification code was sent. To submit your application, enter the 8-character code.</p>${Array.from({length:8},()=>'<input maxlength="1">').join('')}<button onclick="document.body.innerHTML='Unexpected submit'">Submit application</button>`}));
  await page.goto('https://job-boards.greenhouse.io/fixture/jobs/123');
  const execImpl=async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'NONE'}})});
  assert.deepEqual(await completeApplicationVerification(page,{company:'Fixture'},{tries:1,execImpl}),{needed:true,completed:false,retrySafe:true});
  assert.match(await page.locator('body').innerText(),/verification code was sent/);
  assert.deepEqual(await page.locator('input').evaluateAll(inputs=>inputs.map(input=>input.value)),Array(8).fill(''));
 }finally{await browser.close();}
});


test('security code employer names allow legal suffixes and a matching trusted posting board',()=>{
 const gotion={...message,subject:'Security code for your application to Gotion, Inc.'};
 assert.ok(verifiedApplicationCode(gotion,'Gotion'));
 const divergent={...message,subject:'Security code for your application to Divergent'};
 const job={company:'Divergent Technologies',url:'https://job-boards.greenhouse.io/divergent/jobs/123'};
 assert.ok(verifiedApplicationCode(divergent,job));
 for(const invalid of [{...job,url:'https://evil.example/divergent/jobs/123'},{...job,url:'https://job-boards.greenhouse.io/another/jobs/123'},{company:'Other Technologies',url:job.url}])assert.equal(verifiedApplicationCode(divergent,invalid),null);
 assert.equal(verifiedApplicationCode({...gotion,subject:'Security code for your application to Gotion Europe'},'Gotion'),null);
 assert.equal(verifiedApplicationCode(gotion,'Gotion',{email:'other@example.com'}),null);
 assert.ok(verifiedApplicationCode(gotion,'Gotion',{email:'fixture@example.com'}));
});
test('lookup searches verified aliases and keeps recipient and freshness validation',async()=>{
 const job={company:'Divergent Technologies',url:'https://job-boards.greenhouse.io/divergent/jobs/123'};
 const evidence={...message,subject:'Security code for your application to Divergent'};
 const logs=[];
 const result=await fetchApplicationCode(job,{email:'fixture@example.com',after:new Date().toISOString(),tries:1,log:m=>logs.push(m),execImpl:async(_command,_args,prompt,options)=>{
  assert.equal(options.cwd,tmpdir());
  assert.match(prompt,/"divergent technologies" OR "divergent"/);
  assert.match(prompt,/copy the actual To addresses/);
  return {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(evidence)}})};
 }});
 assert.equal(result.code,evidence.code);
 const rejected=await fetchApplicationCode(job,{email:'other@example.com',tries:1,log:m=>logs.push(m),execImpl:async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(evidence)}})})});
 assert.equal(rejected,null);assert.ok(logs.some(l=>/recipient/.test(l)));assert.ok(logs.every(l=>!l.includes(evidence.code)));
});

test('the code gate is found inside an employer page that embeds Greenhouse in an iframe (Zipline)',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.route('https://www.zipline.com/careers',r=>r.fulfill({contentType:'text/html',body:'<h1>Zipline</h1><iframe src="https://job-boards.greenhouse.io/embed/job_app?for=zipline"></iframe>'}));
  await page.route('https://job-boards.greenhouse.io/**',r=>r.fulfill({contentType:'text/html',body:'<p>A verification code was sent to you. To submit your application, enter the 8-character code.</p>'+'<input maxlength="1">'.repeat(8)+'<button>Submit application</button>'}));
  await page.goto('https://www.zipline.com/careers');
  const result=await completeApplicationVerification(page,{company:'Zipline'},{gateWaitMs:3000,tries:1,execImpl:async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'NONE'}})}),requestCode:async()=>null});
  assert.equal(result.needed,true,'gate detected inside the iframe');
 }finally{await browser.close();}
});
test('a Greenhouse board slug that begins with the dashboard employer name is the same employer',()=>{
 // Anduril 11394: the dashboard says "Anduril", the board is andurilindustries and the code email says "Anduril Industries".
 const job={company:'Anduril',url:'https://boards.greenhouse.io/andurilindustries/jobs/5136367007'};
 const anduril={...message,subject:'Security code for your application to Anduril Industries'};
 assert.equal(verifiedApplicationCode(anduril,job,{after:Date.now()/1000-60}).code,message.code);
 assert.equal(verifiedApplicationCode({...message,subject:'Security code for your application to Anduril Defense'},job,{after:Date.now()/1000-60}),null);
 // A short or unrelated dashboard name never adopts the slug, and a slug alias needs the posting's own board.
 assert.equal(verifiedApplicationCode(anduril,{company:'And',url:job.url},{after:Date.now()/1000-60}),null);
 assert.equal(verifiedApplicationCode(anduril,{company:'Anduril',url:'https://boards.greenhouse.io/other/jobs/1'},{after:Date.now()/1000-60}),null);
});
test('a code email naming the employer by its longer legal name is accepted, a different employer is not',()=>{
 // Varda 9948: the dashboard says "Varda Space", the board is vardaspace, the email says "Varda Space Industries".
 const job={company:'Varda Space',url:'https://job-boards.greenhouse.io/vardaspace/jobs/8017264003'};
 const varda={...message,subject:'Security code for your application to Varda Space Industries'};
 assert.equal(verifiedApplicationCode(varda,job).code,message.code);
 for(const subject of['Security code for your application to Varda Spacecraft','Security code for your application to Varda Space Europe','Security code for your application to Varda','Security code for your application to Space Industries'])assert.equal(verifiedApplicationCode({...varda,subject},job),null);
});
test('a code Greenhouse accepts a few seconds after the click still counts (Zipline 709)',async()=>{
 const code='aB12cD34';let clicked=0,polls=0;
 const page={url:()=> 'https://job-boards.greenhouse.io/fixture/jobs/123',
  locator:selector=>selector==='body'?{innerText:async()=>clicked&&polls++>=5?'Application received':'A verification code was sent. To submit your application, enter the 8-character code.'}:{count:async()=>8,nth:()=>({fill:async()=>{}})},
  getByLabel:()=>({count:async()=>0}),getByRole:()=>({count:async()=>1,click:async()=>{clicked++;}}),waitForTimeout:async()=>{}};
 const execImpl=async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({...message,code,body:`security code field on your application: ${code}`})}})});
 assert.deepEqual(await completeApplicationVerification(page,{company:'Fixture'},{execImpl}),{needed:true,completed:true,messageId:message.messageId});
 assert.equal(clicked,1,'submit is clicked once, never again while waiting');
});
