import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {waitForStep} from '../src/workday-navigation.mjs';

const before={n:6,name:'Self Identify'};
const fixture=`<main style="white-space:pre-line">current step 6 of 7\nSelf Identify</main>
<div role="alert">Errors Found: Please check one of the boxes below</div>
<button data-automation-id="pageFooterNextButton" disabled>Save and Continue</button>`;

test('Workday waits through a stale validation banner while saving a corrected form',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(fixture);
  let waits=0;
  const text=await waitForStep(page,before,{wait:async()=>{
   waits++;
   // Saved failure shape: old required-choice error remains while Save is
   // disabled. It may even outlive the first enabled footer render.
   if(waits===2)await page.locator('button').evaluate(el=>el.disabled=false);
   if(waits===3)await page.evaluate(()=>{
    document.querySelector('[role="alert"]').remove();
    document.querySelector('main').textContent='current step 7 of 7\nReview';
   });
  }});
  assert.match(text,/Review/);
  assert.equal(waits,4);
 }finally{await browser.close();}
});

test('Workday still returns a persistent validation rejection after the footer settles',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(fixture);
  let waits=0;
  const text=await waitForStep(page,before,{wait:async()=>{
   waits++;
   if(waits===2)await page.locator('button').evaluate(el=>el.disabled=false);
  }});
  assert.match(text,/Errors Found/);
  assert.equal(waits,3);
 }finally{await browser.close();}
});
