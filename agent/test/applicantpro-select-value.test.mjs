import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot,alreadyHolds} from '../src/dashboard-worker.mjs';

// X-Bow 12727 (ApplicantPro): the registration page's native <select>s carry role="combobox", so the snapshot
// reported every option's text as their value (3 KB of countries per step) and never the chosen option.
test('a native select with role=combobox reports its chosen option, not the option list',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.route('https://employer.applicantpro.com/account/',r=>r.fulfill({contentType:'text/html',body:`<form><label for="state_id">State/Province*</label>
   <select id="state_id" name="state_id" role="combobox"><option value="">State/Province*</option><option value="5">California</option><option value="43">Texas</option></select>
   <label for="zip_code">Zip or Postal Code*</label><input id="zip_code" name="zip" type="text"></form>`}));
  await page.goto('https://employer.applicantpro.com/account/');
  const control=()=>snapshot(page).then(s=>s.frames.flatMap(f=>f.controls).find(c=>c.label==='State/Province*'));
  let state=await control();
  assert.equal(state.type,'select-one');
  assert.equal(state.value,'');
  assert.equal(state.options.length,3);
  await page.selectOption('#state_id',{label:'California'});
  state=await control();
  assert.equal(state.value,'5');
  assert.ok(!state.value.includes('Texas'));
 }finally{await browser.close();}
});

test('refilling a text control that already holds the same answered value is sent back',()=>{
 const zip={label:'Zip or Postal Code*',type:'text',value:'95008'};
 const answered=[{label:'Zip or Postal Code*',value:'95008'}];
 assert.equal(alreadyHolds(zip,'95008',answered),true);
 assert.equal(alreadyHolds(zip,'95008',[]),false,'a first fill is never a repeat');
 assert.equal(alreadyHolds({...zip,value:''},'95008',answered),false,'an emptied control is filled again');
 assert.equal(alreadyHolds({...zip,value:'93117'},'95008',answered),false,'a changed value is corrected');
 assert.equal(alreadyHolds({label:'State',type:'select-one',value:'5',options:[]},'California',[{label:'State',value:'California'}]),false,'selects keep their own matching');
 assert.equal(alreadyHolds({label:'Phone*',type:'tel',value:'(555) 010-0147'},'555-010-0147',[{label:'Phone*',value:'555-010-0147'}]),true,'a reformatted phone still counts as held');
});
