import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readWorkdayFields} from '../src/workday-controls.mjs';
import {settleWorkdayQuestions,continueWorkdayPreparation} from '../src/workday-preparation.mjs';

test('conditional required questions are answered before a mounted dropdown can swallow Continue',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<div data-automation-id="formField-parent"><label for="parent">U.S. Person? *</label><input id="parent" type="text"></div>
   <button data-automation-id="pageFooterNextButton" onclick="window.advanced=true">Save and Continue</button>`);
  let reveal=false;
  const pending=await settleWorkdayQuestions(page,()=>readWorkdayFields(page),async()=>{
   for(const f of await readWorkdayFields(page))if(!f.value){
    await page.locator(`[id="${f.id}"]`).fill('Yes');
    if(f.id==='parent')reveal=true;
   }
   return [];
  },{wait:async()=>{
   if(reveal){
    reveal=false;
    await page.evaluate(()=>{
     const field=document.createElement('div');
     field.dataset.automationId='formField-followup';
     field.innerHTML='<label for="followup">U.S. citizen? *</label><input id="followup" type="text">';
     document.body.append(field);
    });
   }
  }});
  assert.deepEqual(pending,[]);
  assert.equal(await page.locator('#followup').inputValue(),'Yes');
  await page.evaluate(()=>{
   const menu=document.createElement('div');
   menu.setAttribute('role','listbox');
   menu.style='position:fixed;inset:0;background:white';
   menu.textContent='Selected option';
   menu.onclick=()=>menu.remove();
   document.body.append(menu);
  });
  await continueWorkdayPreparation(page);
  assert.equal(await page.evaluate(()=>window.advanced),true);
 }finally{await browser.close();}
});

test('unknown follow-up is returned for approval and unstable questions stop',async()=>{
 let fields=[{id:'parent',value:''}];
 const unknown={question:'Unknown required commitment',required:true};
 const pending=await settleWorkdayQuestions({},async()=>fields,async()=>{
  if(fields.length===2)return [unknown];
  fields=[{id:'parent',value:'Yes'},{id:'followup',value:''}];return [];
 },{wait:async()=>{}});
 assert.deepEqual(pending,[unknown]);
 let revision=0;
 await assert.rejects(settleWorkdayQuestions({},async()=>[{revision:revision++}],async()=>[],{passes:3,wait:async()=>{}}),/did not settle/);
});

test('preparation navigation refuses Submit and waits for enabled Continue',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<button data-automation-id="pageFooterNextButton" onclick="window.submitted=true">Submit</button>');
  await assert.rejects(continueWorkdayPreparation(page),/cannot click/);
  assert.equal(await page.evaluate(()=>window.submitted),undefined);
  await page.setContent('<button disabled data-automation-id="pageFooterNextButton" onclick="window.advanced=true">Save and Continue</button>');
  await page.evaluate(()=>setTimeout(()=>document.querySelector('button').disabled=false,150));
  await continueWorkdayPreparation(page);
  assert.equal(await page.evaluate(()=>window.advanced),true);
 }finally{await browser.close();}
});


test('Continue preserves saved prompt selections while dismissing multiple real dropdowns',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<div data-automation-id="formField-countryPhoneCode">
   <ul role="listbox" data-automation-id="selectedItemList" aria-label="items selected">
    <li role="presentation"><div role="option" data-automation-id="selectedItem">
     <p data-automation-id="promptOption">Example country (+1)</p>
    </div></li>
   </ul></div>
   <div role="listbox" id="dropdown-one">First actual dropdown</div>
   <div role="listbox" id="dropdown-two">Second actual dropdown</div>
   <button data-automation-id="pageFooterNextButton" onclick="window.advanced=true">Save and Continue</button>
   <script>document.addEventListener('keydown',event=>{
    if(event.key==='Escape')setTimeout(()=>{
     document.querySelector('#dropdown-one').remove();
     document.querySelector('#dropdown-two').remove();
    },100);
   });</script>`);
  await continueWorkdayPreparation(page);
  assert.equal(await page.evaluate(()=>window.advanced),true);
  assert.equal(await page.locator('[data-automation-id="selectedItem"]').innerText(),'Example country (+1)');
  assert.equal(await page.locator('[role="listbox"]').count(),1);
 }finally{await browser.close();}
});

test('Continue stops if an actual dropdown remains alongside saved selections',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<ul role="listbox" data-automation-id="selectedItemList"><li>Saved choice</li></ul>
   <div role="listbox">Stuck dropdown</div>
   <button data-automation-id="pageFooterNextButton" onclick="window.advanced=true">Continue</button>`);
  await assert.rejects(continueWorkdayPreparation(page),/Timeout|timed out/i);
  assert.equal(await page.evaluate(()=>window.advanced),undefined);
 }finally{await browser.close();}
});


test('Continue does not wait for the permanent phone selection list to disappear',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<ul role="listbox" data-automation-id="selectedItemList" aria-label="items selected">
   <li role="presentation"><div role="option" data-automation-id="selectedItem">Example country (+1)</div></li></ul>
   <button data-automation-id="pageFooterNextButton" onclick="window.advanced=true">Save and Continue</button>`);
  await continueWorkdayPreparation(page);
  assert.equal(await page.evaluate(()=>window.advanced),true);
  assert.equal(await page.locator('[data-automation-id="selectedItem"]').innerText(),'Example country (+1)');
 }finally{await browser.close();}
});
