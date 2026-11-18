import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {continueWorkdayPreparation} from '../src/workday-preparation.mjs';

test('Continue closes a persistent education dropdown through its unique owner without changing degrees',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  await page.setContent(`<button id="education-1--degree" aria-haspopup="listbox" aria-expanded="true" aria-controls="degree-menu" value="bs" onclick="document.querySelector('#degree-menu').remove();this.setAttribute('aria-expanded','false');window.menuClosedCount=(window.menuClosedCount||0)+1">Bachelor of Science (BS)</button>
   <button id="education-2--degree" aria-haspopup="listbox" value="bs" onclick="window.wrongOwner=true">Bachelor of Science (BS)</button>
   <div role="listbox" id="degree-menu"><div role="option" id="bs" aria-selected="true">Bachelor of Science (BS)</div><div role="option" onclick="window.changedDegree=true">Other degree</div></div>
   <div role="listbox" data-automation-id="selectedItemList"><div role="option" data-automation-id="selectedItem">Saved school</div></div>
   <button data-automation-id="pageFooterNextButton" onclick="window.advanced=(window.advanced||0)+1">Save and Continue</button>`);
  await continueWorkdayPreparation(page);
  assert.equal(await page.evaluate(()=>window.menuClosedCount),1);
  assert.equal(await page.evaluate(()=>window.advanced),1);
  assert.equal(await page.evaluate(()=>window.wrongOwner||window.changedDegree),undefined);
  for(const id of ['education-1--degree','education-2--degree'])assert.equal(await page.locator(`[id="${id}"]`).getAttribute('value'),'bs');
  assert.equal(await page.locator('[data-automation-id="selectedItem"]').innerText(),'Saved school');
 }finally{await browser.close();}
});

test('Continue cannot choose between ambiguous dropdown owners',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`${[1,2].map(n=>`<button aria-haspopup="listbox" aria-expanded="true" aria-controls="menu" onclick="window.toggled=true">Degree ${n}</button>`).join('')}
   <div id="menu" role="listbox">Unowned choices</div>
   <button data-automation-id="pageFooterNextButton" onclick="window.advanced=true">Continue</button>`);
  await assert.rejects(continueWorkdayPreparation(page),/Timeout 3000ms/);
  assert.equal(await page.evaluate(()=>window.toggled||window.advanced),undefined);
 }finally{await browser.close();}
});
