import test from 'node:test';import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {formValidationGaps} from '../src/dashboard-worker.mjs';
// RAVE 10572 (Workable): required YES/NO radios were unanswered, the browser refused to submit,
// and the run was still recorded as submitted.
test('required radios the browser would refuse are reported before Submit',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.setContent(`<form><fieldset><legend>Are you authorized to legally work in the US?</legend>
   <input type="radio" name="auth" value="yes" required><input type="radio" name="auth" value="no" required></fieldset>
   <label>Email<input name="email" value="a@b.co" required></label><button type="submit">Submit application</button></form>`);
  const submit=page.locator('button');
  assert.deepEqual(await formValidationGaps(submit),['Are you authorized to legally work in the US?']);
  await page.check('input[value="yes"]');
  assert.deepEqual(await formValidationGaps(submit),[]);
  await page.setContent('<form novalidate><input required><button>Submit</button></form>');
  assert.deepEqual(await formValidationGaps(page.locator('button')),[]);
  await page.setContent('<div><input required><button>Submit</button></div>');
  assert.deepEqual(await formValidationGaps(page.locator('button')),[]);
 }finally{await browser.close();}
});
