import test from 'node:test';import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {webpageRejection,collectWebpageRejection,webpageAcceptance} from '../src/application-acceptance.mjs';
const url='https://jobs.example.com/apply';
test('a form that stays open with field errors after Submit is a rejection, not a pending receipt',()=>{
 assert.equal(webpageRejection({url,submittedFromUrl:url,submitVisible:true,errors:['This field is required']}).outcome,'rejected');
 assert.deepEqual(webpageRejection({url,submittedFromUrl:url,submitVisible:true,invalid:['Phone']}).invalidFields,['Phone']);
 // No visible submit, another site, or no concrete error text: unresolved, never a rejection.
 assert.equal(webpageRejection({url,submittedFromUrl:url,submitVisible:false,errors:['This field is required']}),null);
 assert.equal(webpageRejection({url:'https://other.example/x',submittedFromUrl:url,submitVisible:true,errors:['required']}),null);
 assert.equal(webpageRejection({url,submittedFromUrl:url,submitVisible:true,errors:['Uploading…'],alerts:['Saved']}),null);
 // A thank-you page is still acceptance.
 assert.ok(webpageAcceptance({text:'Thank you for applying!',url,submittedFromUrl:url,submittedAt:new Date().toISOString()}));
});
test('the browser collector reads errors from a real page',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.route(url,r=>r.fulfill({contentType:'text/html',body:'<form><label>Phone<input aria-invalid="true" name="p"></label><span class="field-error">Phone is required</span><button>Submit application</button></form>'}));
  await page.goto(url);
  const r=await collectWebpageRejection(page,{submittedFromUrl:url});
  assert.deepEqual(r.messages,['Phone is required']);assert.deepEqual(r.invalidFields,['Phone']);
  await page.route(url+'/done',r=>r.fulfill({contentType:'text/html',body:'<h1>Thank you for applying!</h1>'}));
  await page.goto(url+'/done');
  assert.equal(await collectWebpageRejection(page,{submittedFromUrl:url}),null);
 }finally{await browser.close();}
});

test('a spam flag or an emailed security-code screen after Submit is not acceptance (Saronic, Zipline)',()=>{
 assert.equal(webpageRejection({url,submittedFromUrl:url,text:'Your application submission was flagged as possible spam.'}).outcome,'flagged_spam');
 assert.equal(webpageRejection({url,submittedFromUrl:url,text:'Enter the 8-character security code sent to you'}).outcome,'verification_code');
 assert.equal(webpageRejection({url,submittedFromUrl:url,text:'Thank you for applying!'}),null);
});

import {collectWebpageAcceptance} from '../src/application-acceptance.mjs';
test('a thank-you inside an embedded Greenhouse frame counts as webpage acceptance (Zipline 704)',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();const job={id:704,company:'Zipline',title:'ME',url:'https://www.zipline.com/careers/704'};
  await page.route('https://www.zipline.com/careers/704',r=>r.fulfill({contentType:'text/html',body:'<h1>Zipline</h1><iframe src="https://job-boards.greenhouse.io/embed/job_app?for=zipline"></iframe>'}));
  await page.route('https://job-boards.greenhouse.io/**',r=>r.fulfill({contentType:'text/html',body:'<h1>Thank you for applying.</h1><p>Your application has been received.</p>'}));
  await page.goto(job.url);await page.waitForTimeout(500);
  const e=await collectWebpageAcceptance(page,job,{submittedAt:new Date(Date.now()-60000).toISOString(),submittedFromUrl:job.url});
  assert.ok(e,'accepted');assert.match(e.quote,/thank you for applying/i);
 }finally{await browser.close();}
});
