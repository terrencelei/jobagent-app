import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot,pickOption} from '../src/dashboard-worker.mjs';

for(const aria of ['aria-autocomplete="list" aria-haspopup="true"','']) {
 test(`Greenhouse conditional race dropdown without a combobox role: ${aria||'structural fallback'}`,async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  try{
   await page.route('http://127.0.0.1/**',route=>route.fulfill({contentType:'text/html',body:'<body></body>'}));
   await page.goto('http://127.0.0.1/fixture');
   await page.setContent(`<form onsubmit="event.preventDefault();window.submissions++">
    <label for="ethnicity">Are you Hispanic/Latino?</label><select id="ethnicity"><option></option><option>No</option></select>
    <div id="conditional"></div><label for="ordinary">Ordinary text</label><input id="ordinary">
    <button type="submit">Submit application</button></form>
    <script>
    window.submissions=0;
    document.querySelector('#ethnicity').onchange=()=>{
     document.querySelector('#conditional').innerHTML='<div class="select"><label for="race">Please identify your race*</label><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div><div class="select__single-value"></div><input id="race" class="select__input" type="text" aria-required="true" ${aria} aria-expanded="false" aria-controls="choices"></div><button type="button" aria-label="Toggle flyout" tabindex="-1">▼</button></div><input required tabindex="-1" aria-hidden="true"><div id="choices" role="listbox" hidden><div role="option">Asian</div><div role="option">White</div></div></div>';
     const input=document.querySelector('#race'),box=document.querySelector('#choices');
     input.onfocus=()=>{box.hidden=false;input.setAttribute('aria-expanded','true');};
     for(const option of box.children)option.onclick=()=>{
      document.querySelector('.select__single-value').textContent=option.textContent;
      document.querySelector('.select__placeholder').remove();input.value='';box.hidden=true;
      input.setAttribute('aria-expanded','false');
     };
    };
    </script>`);
   assert.equal((await snapshot(page)).frames[0].controls.some(c=>c.label.includes('identify your race')),false);
   await page.locator('#ethnicity').selectOption('No');
   const controls=(await snapshot(page)).frames[0].controls;
   const race=controls.find(c=>c.label==='Please identify your race*');
   assert.ok(race);assert.equal(race.combobox,true);assert.equal(race.required,true);assert.equal(race.value,'');
   assert.equal(controls.find(c=>c.label==='Ordinary text').combobox,undefined);
   assert.equal(controls.some(c=>c.label==='Unlabelled field'),false);
   // The old role-only detector missed this actual Greenhouse input.
   assert.equal(await page.locator('#race').getAttribute('role'),null);
   const result=await pickOption(page.mainFrame(),page.locator('#race'),'Asian','Please identify your race*');
   assert.equal(result.ok,true);assert.equal(result.value,'Asian');
   assert.equal((await snapshot(page)).frames[0].controls.find(c=>c.label==='Please identify your race*').value,'Asian');
   assert.equal(await page.locator('#race').inputValue(),'');
   assert.equal(await page.evaluate(()=>window.submissions),0);
  }finally{await browser.close();}
 });
}
