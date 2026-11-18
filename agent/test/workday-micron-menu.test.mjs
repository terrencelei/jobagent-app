import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {continueWorkdayPreparation} from '../src/workday-preparation.mjs';

test('Micron degree portal closes without disturbing two degrees or permanent skill lists',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'workday-degree-menu-'));
 let context;
 try{
  context=await chromium.launchPersistentContext(directory,{headless:true,viewport:{width:1280,height:1000}});
  const page=await context.newPage();
  // Structure from the saved failure: the first degree owns a separate portal,
  // while several unrelated selected-item listboxes remain permanently visible.
  await page.setContent(`<div data-automation-id="formField-degree">
   <button id="education-5--degree" aria-haspopup="listbox" aria-expanded="true" aria-controls="c7mag" value="bachelors">Bachelor's Level Degree</button>
   </div><div data-automation-id="formField-degree">
   <button id="education-6--degree" aria-haspopup="listbox" value="bachelors">Bachelor's Level Degree</button></div>
   ${['Statistics','Mechanical Engineering','Example skill'].map(label=>`<div role="listbox" data-automation-id="selectedItemList"><div role="option" data-automation-id="selectedItem">${label}</div></div>`).join('')}
   <div role="listbox" id="c7mag"><div role="option">Select One</div><div role="option" aria-selected="true">Bachelor's Level Degree</div><div role="option">Master's Level Degree</div></div>
   <button data-automation-id="pageFooterNextButton">Save and Continue</button>`);
  await page.evaluate(()=>{
   document.getElementById('education-5--degree').onclick=event=>{
    document.getElementById('c7mag').remove();
    event.currentTarget.setAttribute('aria-expanded','false');
   };
   document.querySelector('[data-automation-id="pageFooterNextButton"]').onclick=()=>{
    if(!document.getElementById('c7mag'))window.advanced=true;
   };
  });
  await continueWorkdayPreparation(page);
  assert.equal(await page.evaluate(()=>window.advanced),true);
  assert.equal(await page.locator('#c7mag').count(),0);
  assert.deepEqual(await page.locator('[data-automation-id="formField-degree"] button').evaluateAll(buttons=>buttons.map(button=>button.value)),['bachelors','bachelors']);
  assert.deepEqual(await page.locator('[data-automation-id="selectedItem"]').allTextContents(),['Statistics','Mechanical Engineering','Example skill']);
 }finally{
  if(context)await context.close();
  await rm(directory,{recursive:true,force:true});
 }
});
