import test from 'node:test';import assert from 'node:assert/strict';
import{chromium}from'playwright';import{monitorLeverSubmission,leverSubmissionOutcome,leverVerificationFailure}from'../src/lever-submission.mjs';
const job={id:1,company:'Fixture',url:'https://jobs.lever.co/fixture/00000000-0000-4000-8000-000000000001/apply'};
test('verification rejection is explicit and a solved CAPTCHA alone is not acceptance',()=>{
 assert.match(leverVerificationFailure('Unable to verify your application. Please try again.'),/Unable to verify/);
 assert.equal(leverVerificationFailure('There was an error verifying your application. Please try again.'),'There was an error verifying your application');
 for(const text of ['CAPTCHA verified','Thank you for applying','Submit Application','Checking your application'])assert.equal(leverVerificationFailure(text),null);
});
test('normal Lever POST error is captured without saving submitted values or CAPTCHA tokens',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();
  await page.route('https://jobs.lever.co/**',route=>route.request().method()==='POST'
   ?route.fulfill({status:400,body:'Unable to verify your application. fixture-private-token must never be retained.'})
   :route.fulfill({contentType:'text/html',body:'<body><button onclick="fetch(location.href,{method:\'POST\',body:\'fixture-personal-value\'}).then(r=>r.text()).then(t=>document.body.innerText=t)">Submit Application</button></body>'}));
  await page.goto(job.url);const captured=[],monitor=monitorLeverSubmission(page,job,{onEvidence:e=>captured.push(e)});
  await page.getByRole('button').click();const result=await leverSubmissionOutcome(page,job,{monitor});
  assert.equal(result.status,'verification_rejected');assert.equal(result.retrySafe,true);assert.equal(captured.length,1);
  assert.equal(captured[0].status,400);assert.equal(monitor.requests().length,1);assert.doesNotMatch(JSON.stringify(monitor.requests()),/fixture-personal-value/);assert.doesNotMatch(JSON.stringify(result),/fixture-private-token|fixture-personal-value/);
  monitor.stop();
 }finally{await browser.close();}
});
test('other postings and a closed challenge do not establish acceptance or authorize retry',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();
  await page.route('https://jobs.lever.co/**',r=>r.fulfill({contentType:'text/html',body:'CAPTCHA verified. Submit Application'}));
  await page.goto(job.url);const monitor=monitorLeverSubmission(page,job);
  assert.equal(await leverSubmissionOutcome(page,job,{monitor,timeoutMs:0}),null);
  assert.equal(monitor.responses().length,0);monitor.stop();
 }finally{await browser.close();}
});

import{waitForManualLeverRetry}from'../src/lever-submission.mjs';
test('rejected verification waits for an applicant-initiated normal retry and never clicks',async()=>{
 let time=0,posts=[{status:400,verificationError:'Unable to verify your application'}],clicks=0;
 const page={isClosed:()=>false,url:()=>job.url,locator:()=>({innerText:async()=>posts.length>1?'Application submitted':'Unable to verify your application'}),click:()=>clicks++};
 const result=await waitForManualLeverRetry(page,job,{monitor:{responses:()=>posts},now:()=>time,wait:async ms=>{time+=ms;posts.push({status:200,verificationError:null});}});
 assert.equal(result.completed,true);assert.equal(result.by,'manual_post');assert.equal(clicks,0);
});
test('rejected verification times out without another normal POST or a receipt claim',async()=>{
 let time=0;const page={isClosed:()=>false,url:()=>job.url};
 const result=await waitForManualLeverRetry(page,job,{monitor:{responses:()=>[{status:400,verificationError:'Unable to verify your application'}]},timeoutMs:1000,now:()=>time,wait:async ms=>{time+=ms;}});
 assert.equal(result.completed,false);assert.match(result.reason,/not completed/);
});


import{leverChallengePending}from'../src/lever-submission.mjs';
test('a new empty widget on a rejected application page does not trap the old CAPTCHA handoff',async()=>{
 let text='Submit Application',checks=0;const page={url:()=>job.url,locator:()=>({innerText:async()=>text})};
 const pending=async()=>{checks++;return true;};
 assert.equal(await leverChallengePending(page,job,{pending}),true);
 text='There was an error verifying your application. Please try again.';
 assert.equal(await leverChallengePending(page,job,{pending}),false);
 assert.equal(checks,1);
});
