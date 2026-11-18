import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {openSignInForm} from '../src/workday.mjs';

// GM 12603: a blank dialog backdrop covered the header Sign In; the plain click waited 20 s and
// killed the run. The click must now fail fast and the loop wait for the overlay to clear.
test('a covered header Sign In does not abort the run; it retries once the overlay clears',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent(`<header><button data-automation-id="utilityButtonSignIn" onclick="document.querySelector('main').innerHTML='<input data-automation-id=email><input data-automation-id=password type=password>'">Sign In</button></header><main><h1>Create Account/Sign In</h1></main><div id=ov style="position:fixed;inset:0;background:#0006"></div>`);
  setTimeout(()=>page.evaluate(()=>document.getElementById('ov')?.remove()).catch(()=>{}),6000);
  const t0=Date.now();
  assert.equal(await openSignInForm(page,{tries:6,wait:ms=>page.waitForTimeout(Math.min(ms,500))}),true);
  assert.ok(Date.now()-t0<20000);
 } finally {await browser.close();}
});
