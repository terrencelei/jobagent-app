import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {openWorkdayBrowser} from '../src/workday-browser.mjs';
import {continueWorkdayPreparation} from '../src/workday-preparation.mjs';

async function fixture(run){
 const root=await mkdtemp(join(tmpdir(),'workday-menus-'));
 let context;
 try{
  context=await openWorkdayBrowser(chromium,join(root,'profile'),{headless:true,viewport:{width:1280,height:1000}});
  await run(await context.newPage());
 }finally{await context?.close();await rm(root,{recursive:true,force:true});}
}
const saved=`<div role="listbox" data-automation-id="selectedItemList"><div role="option" data-automation-id="selectedItem">Other</div></div>
 <div role="listbox" data-automation-id="selectedItemList"><div role="option" data-automation-id="selectedItem">Example country (+1)</div></div>`;
const footer='<button data-automation-id="pageFooterNextButton" onclick="window.advanced=(window.advanced||0)+1">Save and Continue</button>';

test('Continue accepts two permanent saved-choice listboxes from the Analog Devices failure',async()=>fixture(async page=>{
 await page.setContent(saved+footer);
 await continueWorkdayPreparation(page);
 assert.equal(await page.evaluate(()=>window.advanced),1);
 assert.deepEqual(await page.locator('[data-automation-id="selectedItem"]').allInnerTexts(),['Other','Example country (+1)']);
}));

test('Continue waits until every real menu closes when saved-choice lists also remain',async()=>fixture(async page=>{
 await page.setContent(saved+`<div role="listbox" id="first-menu">Menu one</div><div role="listbox" id="last-menu">Menu two</div>`+footer+`<script>
 document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){
   setTimeout(()=>document.querySelector('#first-menu').remove(),100);
   setTimeout(()=>document.querySelector('#last-menu').remove(),500);
  }
 });
 document.querySelector('button').addEventListener('click',()=>window.menuAtClick=!!document.querySelector('#last-menu'));
 </script>`);
 await continueWorkdayPreparation(page);
 assert.equal(await page.evaluate(()=>window.advanced),1);
 assert.equal(await page.evaluate(()=>window.menuAtClick),false);
 assert.equal(await page.locator('[data-automation-id="selectedItemList"]').count(),2);
}));
