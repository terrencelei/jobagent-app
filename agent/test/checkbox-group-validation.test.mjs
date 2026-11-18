import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {formValidationGaps} from '../src/dashboard-worker.mjs';

const question='How did you hear about us?';
const fixture=`<form><fieldset class="checkbox" aria-required="true"><legend>${question}</legend>
 ${['Company Website','Career Fair / Event','LinkedIn','Referral / Friend'].map((label,i)=>`<label><input type="checkbox" name="source[]" description="${question}" required value="${i}">${label}</label>`).join('')}
 </fieldset><label><input name="consent" type="checkbox" required>Required consent</label>
 <fieldset><legend>Work authorization</legend><label><input type="radio" name="auth" required value="yes">Yes</label><label><input type="radio" name="auth" required value="no">No</label></fieldset>
 <button type="submit">Submit application</button></form>
 <script>window.accepted=0;document.querySelector('button').onclick=e=>{e.preventDefault();if(document.querySelector('input[name="source[]"]:checked')&&document.querySelector('[name=consent]').checked&&document.querySelector('[name=auth]:checked'))window.accepted++};</script>`;

test('Greenhouse array choice required alternatives respect one saved selection without hiding consent or radio gaps',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent(fixture);
  const submit=page.locator('button');
  assert.deepEqual(await formValidationGaps(submit),[question,'Required consent','Yes']);
  await page.check('input[value="0"]');
  assert.deepEqual(await formValidationGaps(submit),['Required consent','Yes']);
  await page.check('[name=consent]');await page.check('[name=auth][value=yes]');
  assert.deepEqual(await formValidationGaps(submit),[]);
  await submit.click();assert.equal(await page.evaluate(()=>window.accepted),1);
  await page.uncheck('input[value="0"]');assert.ok((await formValidationGaps(submit)).length>0);
  assert.equal(await page.evaluate(()=>window.accepted),1);
  // An unrelated checked box in another form cannot satisfy this question.
  await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<form><input type="checkbox" name="source[]" checked></form>'));
  assert.ok((await formValidationGaps(submit)).length>0);
  // Disabled or custom-invalid choices cannot satisfy an incomplete question.
  await page.check('input[value="0"]');await page.locator('input[value="0"]').evaluate(e=>e.disabled=true);
  assert.ok((await formValidationGaps(submit)).length>0);
  await page.locator('input[value="0"]').evaluate(e=>e.disabled=false);
  await page.locator('input[value="1"]').evaluate(e=>e.setCustomValidity('Employer-specific error'));
  assert.ok((await formValidationGaps(submit)).length>0);
 }finally{await browser.close();}
});

test('independent same-name consents remain individually required',async()=>{
 const browser=await chromium.launch();
 try{const page=await browser.newPage();await page.setContent('<form><fieldset><legend>Agreements</legend><label><input type="checkbox" name="consents[]" required checked>Privacy</label><label><input type="checkbox" name="consents[]" required>Terms</label></fieldset><button>Submit</button></form>');assert.deepEqual(await formValidationGaps(page.locator('button')),['Terms']);}finally{await browser.close();}
});
