import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot,isFinalControl} from '../src/dashboard-worker.mjs';

// Keel 12694 (Paylocity): the page has no <form> and its buttons carry no type attribute, so the DOM
// reports "Select Resume to Upload", "Add Work History" and "Accept All Cookies" as type=submit. Each was
// taken for the final Submit, and the pre-submit required-field check failed the run on step 1.
test('untyped buttons outside any form are buttons, not submits',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.route('https://recruiting.example.com/**',r=>r.fulfill({contentType:'text/html',body:`<div><button data-automation-id="btn-resume">Select Resume to Upload</button>
   <label>Address Line 1<input required></label>
   <button>Add Work History</button><button id="btn-submit">Next Step</button>
   <button>Submit Application</button><button type="submit">Send</button></div>
   <form><button>Save</button></form>`}));
  await page.goto('https://recruiting.example.com/Recruiting/Jobs/Apply/1');
  const controls=(await snapshot(page)).frames[0].controls;
  const by=label=>controls.find(c=>c.label===label);
  const job={title:'Manufacturing Engineer I'};
  for(const label of ['Select Resume to Upload','Add Work History','Next Step']){
   assert.equal(by(label).type,'button',label);
   assert.equal(isFinalControl(by(label),[],job),false,label);
  }
  assert.equal(by('Submit Application').type,'button');
  assert.equal(isFinalControl(by('Submit Application'),[],job),true);
  // An explicit type=submit, or a button inside a form, keeps the browser's type.
  assert.equal(by('Send').type,'submit');
  assert.equal(by('Save').type,'submit');
 }finally{await browser.close();}
});
