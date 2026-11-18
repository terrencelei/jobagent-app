import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {findAutofillUpload} from '../src/dashboard-worker.mjs';

// His request (lesson 441): use the page's own resume autofill. Ashby opens its form with an "Autofill from resume"
// box holding a file input; the ordinary Resume field below it is a different control.
test('the resume-autofill box is found once; an ordinary Resume field and an account autofill button are not',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<div class="ashby-application-form-autofill-input-root"><p>Autofill from resume</p><p>Upload your resume here to autofill key application fields.</p>
   <button>Upload file</button><input type="file" id="auto" style="display:none"></div>
   <button>Autofill with MyGreenhouse</button>
   <form><label for="n">Name</label><input id="n"><label for="r">Resume</label><input type="file" id="r"></form>`);
  const found=await findAutofillUpload(page);
  assert.ok(found);assert.equal(await found.getAttribute('id'),'auto');
  assert.equal(await findAutofillUpload(page),null,'used once per page');
 }finally{await browser.close();}
});
