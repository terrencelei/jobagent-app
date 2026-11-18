import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot,pickOption} from '../src/dashboard-worker.mjs';

const fixture=(tag='div',{retain=true,duplicate=false}={})=>`
<form><label id="country-label">Country</label>
<${tag} id="field-67" ${tag==='button'?'type="button"':''} tabindex="0" role="combobox" aria-labelledby="country-label" aria-label="Select" aria-required="true" aria-expanded="false" aria-haspopup="listbox" aria-autocomplete="list" aria-controls="countries">Select</${tag}>
<div id="countries" role="listbox" hidden></div></form>
<script>
const control=document.getElementById('field-67'),menu=document.getElementById('countries');
control.onclick=()=>{control.setAttribute('aria-expanded','true');menu.hidden=false;menu.innerHTML='';
for(const label of ['United Kingdom','United States'${duplicate?",'United States'":''}]){
const option=document.createElement('div');option.setAttribute('role','option');option.textContent=label;
option.onclick=()=>{${retain?'control.textContent=label;':''}control.setAttribute('aria-expanded','false');menu.hidden=true;};menu.appendChild(option);}};
control.onkeydown=e=>{if(e.key==='Escape'){menu.hidden=true;control.setAttribute('aria-expanded','false');}};
</script>`;

for(const tag of ['div','button'])test(`non-editable ${tag} combobox selects and verifies the saved country`,async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('https://fixture.invalid/',route=>route.fulfill({contentType:'text/html',body:'<body></body>'}));
  await page.goto('https://fixture.invalid/');await page.setContent(fixture(tag));
  const control=(await snapshot(page)).frames[0].controls.find(c=>c.label==='Country');
  assert.equal(control.combobox,true);assert.equal(control.required,true);assert.equal(control.value,'');
  // Reproduce the saved failure with the original text-input operation.
  const locator=page.locator(`[data-ja-control="${control.id}"]`);
  await assert.rejects(locator.fill('United States'));  // any refusal; Playwright's wording is not ours to pin
  assert.deepEqual(await pickOption(page.mainFrame(),locator,'United States','Country'),{ok:true,options:['United Kingdom','United States'],value:'United States'});
  assert.equal((await snapshot(page)).frames[0].controls.find(c=>c.label==='Country').value,'United States');
 }finally{await browser.close();}
});

test('non-editable combobox rejects a choice that did not persist or is ambiguous',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('https://fixture.invalid/',route=>route.fulfill({contentType:'text/html',body:'<body></body>'}));
  await page.goto('https://fixture.invalid/');
  for(const config of [{retain:false},{duplicate:true}]){
   await page.goto('https://fixture.invalid/');
   await page.setContent(fixture('div',config));
   const result=await pickOption(page.mainFrame(),page.locator('#field-67'),'United States','Country');
   assert.equal(result.ok,false);
   assert.equal(await page.locator('#field-67').innerText(),'Select');
  }
 }finally{await browser.close();}
});
