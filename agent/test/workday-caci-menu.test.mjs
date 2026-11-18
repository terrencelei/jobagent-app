import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {openWorkdayBrowser} from '../src/workday-browser.mjs';
import {continueWorkdayPreparation} from '../src/workday-preparation.mjs';

test('CACI saved education portal closes before Continue without altering either degree or prompt chips',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'workday-caci-menu-'));
 let context;
 try{
  context=await openWorkdayBrowser(chromium,directory,{headless:true,viewport:{width:1280,height:1000}});
  const page=context.pages()[0];
  // Reduced saved failure structure: repeated degree controls, a separate
  // persistent portal, and permanent selection lists. No applicant data.
  await page.setContent(`<div data-automation-id="formField-degree">
   <button id="education-4--degree" aria-haspopup="listbox" aria-expanded="true" aria-controls="plosa" value="bachelors">Bachelor's Degree</button></div>
   <div data-automation-id="formField-degree">
   <button id="education-5--degree" aria-haspopup="listbox" value="bachelors">Bachelor's Degree</button></div>
   <div role="listbox" id="plosa"><div role="option">Select One</div><div role="option" aria-selected="true">Bachelor's Degree</div><div role="option">Master's Degree</div></div>
   ${['Saved field one','Saved field two','Saved skill'].map(text=>`<ul role="listbox" data-automation-id="selectedItemList"><li role="presentation"><div role="option" data-automation-id="selectedItem">${text}</div></li></ul>`).join('')}
   <button data-automation-id="pageFooterNextButton">Save and Continue</button>`);
  await page.evaluate(()=>{
   document.getElementById('education-4--degree').onclick=event=>{
    document.getElementById('plosa').remove();
    event.currentTarget.setAttribute('aria-expanded','false');
    window.ownerClicks=(window.ownerClicks||0)+1;
   };
   document.getElementById('education-5--degree').onclick=()=>{window.wrongDegree=true;};
   for(const option of document.querySelectorAll('#plosa [role="option"]'))option.onclick=()=>{window.changedAnswer=true;};
   document.querySelector('[data-automation-id="pageFooterNextButton"]').onclick=()=>{
    if(!document.getElementById('plosa'))window.continues=(window.continues||0)+1;
   };
  });
  await continueWorkdayPreparation(page);
  assert.equal(await page.evaluate(()=>window.ownerClicks),1);
  assert.equal(await page.evaluate(()=>window.continues),1);
  assert.equal(await page.evaluate(()=>window.wrongDegree||window.changedAnswer),undefined);
  assert.deepEqual(await page.locator('[data-automation-id="formField-degree"] button').evaluateAll(buttons=>buttons.map(button=>button.value)),['bachelors','bachelors']);
  assert.deepEqual(await page.locator('[data-automation-id="selectedItem"]').allTextContents(),['Saved field one','Saved field two','Saved skill']);
 }finally{
  if(context)await context.close();
  await rm(directory,{recursive:true,force:true});
 }
});
