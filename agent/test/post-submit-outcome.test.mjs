import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {webpageAcceptance,collectWebpageRejection} from '../src/application-acceptance.mjs';

// His rule (2026-11-02, lesson 435): after Submit, a highlighted required field or an error is answered or goes to
// Needs help; a successful submission turns the page into a confirmation.
const base={url:'https://jobs.example.com/apply/1/done',submittedFromUrl:'https://jobs.example.com/apply/1',job:{url:'https://jobs.example.com/apply/1',id:1,company:'Example'},submittedAt:new Date(Date.now()-2000).toISOString()};
test('a page with no form left that reads as a confirmation is accepted; a page still holding fields is not',()=>{
 assert.ok(webpageAcceptance({...base,text:'Application received',fieldCount:0}));
 assert.ok(webpageAcceptance({...base,text:'Thank you!',fieldCount:0}));
 assert.equal(webpageAcceptance({...base,text:'Thank you for your interest. Name Email',fieldCount:2}),null);
 assert.equal(webpageAcceptance({...base,text:'ok',fieldCount:0}),null);
});
test("the browser's own required-field block is a rejection only when no page loaded after Submit",async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('https://jobs.example.com/**',r=>r.fulfill({contentType:'text/html',body:'<form><label for=q>Postal code</label><input id=q required><button type=submit>Submit application</button></form>'}));
  await page.goto('https://jobs.example.com/apply/1');
  const blocked=await collectWebpageRejection(page,{submittedFromUrl:'https://jobs.example.com/apply/1'});
  assert.equal(blocked?.outcome,'rejected');assert.deepEqual(blocked.invalidFields,['Postal code']);
  assert.equal(await collectWebpageRejection(page,{submittedFromUrl:'https://jobs.example.com/apply/1',sameDocument:false}),null,'a fresh blank form after a page load is not a rejection');
 }finally{await browser.close();}
});
