import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {openWorkdayBrowser} from '../src/workday-browser.mjs';
import {readWorkdayFields} from '../src/workday-controls.mjs';
import {resolveQuestion,needsWorkdayAnswer,stepOf} from '../src/workday.mjs';
import {settleWorkdayQuestions,continueWorkdayPreparation} from '../src/workday-preparation.mjs';
import {waitForStep} from '../src/workday-navigation.mjs';

// Synthetic values; the saved employer rejected SMS-consent prose in this input.
const consent='Yes - I consent to receiving text messages';
const phone='2025550199';
for(const source of ['Handshake','LinkedIn'])test(`Analog Devices My Information repairs rejected consent text while preserving approved ${source}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'workday-analog-phone-'));
 let context;
 try{
  context=await openWorkdayBrowser(chromium,join(root,'profile'),{headless:true,viewport:{width:1280,height:1000}});
  const page=context.pages()[0];
  await page.setContent(`<main style="white-space:pre-line">current step 1 of 7\nMy Information</main>
   <div role="alert" id="error">Error - Phone Number: Enter a valid format for Phone Number.</div>
   <div data-automation-id="formField-source"><label for="source--source">How Did You Hear About Us? *</label>
    <input id="source--source" data-uxi-widget-type="selectinput" aria-required="true">
    <ul role="listbox" data-automation-id="selectedItemList"><li data-automation-id="selectedItem">${source}</li></ul></div>
   <div data-automation-id="formField-phoneNumber"><label for="phoneNumber--phoneNumber">Phone Number *</label>
    <input id="phoneNumber--phoneNumber" type="text" aria-required="true" aria-invalid="true" value="${consent}"></div>
   <button data-automation-id="pageFooterNextButton">Save and Continue</button>
   <script>document.querySelector('#phoneNumber--phoneNumber').onchange=event=>{
    if(/^\\d{10}$/.test(event.target.value))event.target.setAttribute('aria-invalid','false');
   };
   window.saves=0;document.querySelector('button').onclick=()=>{
    window.saves++;
    if(/^\\d{10}$/.test(document.querySelector('#phoneNumber--phoneNumber').value)){
     document.querySelector('main').textContent='current step 2 of 7\\nMy Experience';
     document.querySelector('#error').remove();
    }
   };</script>`);
  const bank={'phone number':{question:'Phone Number',answer:consent,type:'select',approvedFor:'other-employer'}};
  const approvedAnswers=[{question:'How Did You Hear About Us?',answer:source}];
  const ctx={company:'Analog Devices',answers:{phone},approvedAnswers};
  const snapshot=JSON.stringify({bank,approvedAnswers});
  const pending=await settleWorkdayQuestions(page,()=>readWorkdayFields(page),async()=>{
   for(const field of await readWorkdayFields(page)){
    const known=resolveQuestion(field.label,bank,{...ctx,options:field.options});
    if(!needsWorkdayAnswer(field,known))continue;
    assert.equal(field.id,'phoneNumber--phoneNumber');
    assert.deepEqual(known?.candidates,[phone]);
    assert.equal(known.source,'profile');
    const input=page.locator('[id="phoneNumber--phoneNumber"]');
    if(field.invalid)await input.fill('');
    await input.fill(known.candidates[0]);await input.press('Tab');
   }
   return [];
  },{wait:async()=>{}});
  assert.deepEqual(pending,[]);
  await continueWorkdayPreparation(page);
  const text=await waitForStep(page,{n:1,of:7,name:'My Information'},{wait:async()=>{}});
  assert.equal(stepOf(text)?.name,'My Experience');
  assert.equal(await page.evaluate(()=>window.saves),1);
  assert.equal(await page.locator('[data-automation-id="selectedItem"]').innerText(),source);
  assert.equal(JSON.stringify({bank,approvedAnswers}),snapshot);
 }finally{await context?.close();await rm(root,{recursive:true,force:true});}
});
