import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readWorkdayFields,verifyWorkdayCheckboxChoice} from '../src/workday-controls.mjs';
import {setCheckedControl} from '../src/dashboard-worker.mjs';

const want='No, I do not have a disability and have not had one in the past';
const fixture=`<div data-automation-id="formField-disabilityStatus">
 <legend>Please check one of the boxes below:*</legend>
 <fieldset id="status" data-automation-id="disabilityStatus-CheckboxGroup" aria-required="true">
 <input id="yes" type="checkbox"><label for="yes">Yes, I have a disability, or have had one in the past</label>
 <input id="no" type="checkbox"><label for="no">${want}</label>
 <input id="decline" type="checkbox"><label for="decline">I do not want to answer</label>
 </fieldset></div>`;

test('Workday checkbox readback waits for controlled state to settle after the click',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent(fixture);
  const [field]=await readWorkdayFields(page);
  for(const [i,id]of field.optionIds.entries())await setCheckedControl(page,page.locator(`[id="${id}"]`),i===1);
  // A controlled rerender can temporarily restore the old state while its
  // committed selection is pending. Reproduce the old immediate-read failure.
  await page.evaluate(()=>{
   document.querySelector('#no').checked=false;
   window.finishReconciliation=()=>{
    const group=document.querySelector('#status');
    group.replaceWith(group.cloneNode(true));
    document.querySelector('#no').checked=true;
    document.querySelector('#yes').disabled=true;
    document.querySelector('#decline').disabled=true;
   };
  });
  assert.notEqual((await readWorkdayFields(page))[0].value,want);
  await page.evaluate(()=>setTimeout(window.finishReconciliation,350));
  await verifyWorkdayCheckboxChoice(page,field.id,want);
  assert.equal((await readWorkdayFields(page))[0].value,want);
 } finally {await browser.close();}
});

test('Workday checkbox verification rejects discarded, wrong, multiple and briefly selected answers',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  for(const selected of [[],['yes'],['no','decline']]){
   await page.setContent(fixture);
   for(const id of selected)await page.locator(`#${id}`).check();
   await assert.rejects(verifyWorkdayCheckboxChoice(page,'status',want,{timeout:200,interval:50}),/did not retain/);
  }
  await page.setContent(fixture);
  await page.locator('#no').check();
  await page.evaluate(()=>setTimeout(()=>document.querySelector('#no').checked=false,50));
  await assert.rejects(verifyWorkdayCheckboxChoice(page,'status',want,{timeout:350,interval:100}),/did not retain/);
  // A removed group must never be treated as a retained answer.
  await page.locator('#status').evaluate(el=>el.remove());
  await assert.rejects(verifyWorkdayCheckboxChoice(page,'status',want,{timeout:100,interval:25}),/did not retain/);
 } finally {await browser.close();}
});
