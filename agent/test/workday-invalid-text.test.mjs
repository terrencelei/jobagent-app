import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openWorkdayBrowser} from '../src/workday-browser.mjs';
import {readWorkdayFields} from '../src/workday-controls.mjs';
import {needsWorkdayAnswer} from '../src/workday.mjs';

test('known text marked invalid is refilled even when its visible value already matches',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workday-invalid-text-'));
 let context;
 try{
  context=await openWorkdayBrowser(chromium,join(root,'profile'),{headless:true,viewport:{width:1280,height:1000}});
  const page=context.pages()[0];
  // Saved RTX failure shape: both displayed values match approved answers,
  // but the employer's form model still rejects them as missing. Synthetic
  // answers exercise normal input events; no applicant data or network needed.
  await page.setContent(`<main>Application Questions 2 of 2</main>
   <div data-automation-id="formField-credit"><label for="credit">Credit hours *</label>
    <textarea id="credit" aria-required="true" aria-invalid="true">120</textarea></div>
   <div data-automation-id="formField-address"><label for="address">Permanent address *</label>
    <input id="address" type="text" aria-required="true" aria-invalid="true" value="Example address"></div>
   <button data-automation-id="pageFooterNextButton">Save and Continue</button>
   <script>
    window.model={};window.saves=0;
    // Controlled inputs may ignore an input event whose value has not changed.
    window.tracked={credit:'120',address:'Example address'};
    document.addEventListener('input',e=>{
     if(tracked[e.target.id]!==e.target.value){
      tracked[e.target.id]=e.target.value;model[e.target.id]=e.target.value;
     }
    });
    document.querySelector('button').onclick=()=>{
     saves++;
     if(model.credit==='120'&&model.address==='Example address'){
      document.querySelectorAll('[aria-invalid]').forEach(e=>e.removeAttribute('aria-invalid'));
      document.querySelector('main').textContent='Voluntary Disclosures';
     }
    };
   </script>`);
  const approved={credit:'120',address:'Example address'};
  for(const field of await readWorkdayFields(page)){
   const resolved={source:'approved',candidates:[approved[field.id]]};
   assert.equal(field.value,approved[field.id]);
   assert.equal(needsWorkdayAnswer(field,resolved),true,'a rejected matching value must be re-entered');
   const input=page.locator(`[id="${field.id}"]`);
   // Mirrors tools/workday-run.mjs (invalid-value clear, verbatim fill, Tab); this checks needsWorkdayAnswer, not the runner itself.
   if(field.invalid)await input.fill('');
   await input.fill(resolved.candidates[0]);await input.press('Tab');
   assert.equal(await input.inputValue(),approved[field.id]);
  }
  await page.getByRole('button',{name:'Save and Continue',exact:true}).click();
  assert.equal(await page.locator('main').innerText(),'Voluntary Disclosures');
  assert.equal(await page.evaluate(()=>saves),1);
  for(const field of await readWorkdayFields(page))assert.equal(needsWorkdayAnswer(field,{source:'approved',candidates:[approved[field.id]]}),false);
 }finally{await context?.close();await rm(root,{recursive:true,force:true});}
});

test('invalid controls do not authorize unknown answers or change non-text choices',()=>{
 assert.equal(needsWorkdayAnswer({kind:'textarea',value:'Existing unknown text',invalid:true,label:'Unknown'},null),false);
 assert.equal(needsWorkdayAnswer({kind:'listbox',value:'Yes',invalid:true,label:'Choice'},{candidates:['Yes'],source:'approved'}),false);
 assert.equal(needsWorkdayAnswer({kind:'textarea',value:'Approved',label:'Known'},{candidates:['Approved'],source:'approved'}),false);
});
