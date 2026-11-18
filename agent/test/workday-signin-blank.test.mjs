import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {openSignInForm} from '../src/workday.mjs';

// Boeing 14453: the apply page stayed completely blank after a browser disconnect and the
// sign-in form never appeared. A blank page is reloaded once instead of waited on.
test('a blank Workday page is reloaded once and the sign-in form then opens',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  let loads=0;
  await page.route('http://workday.test/**',r=>r.fulfill({contentType:'text/html',body:++loads===1?'<html><body></body></html>':'<input data-automation-id=email><input data-automation-id=password type=password>'}));
  await page.goto('http://workday.test/apply');
  assert.equal(await openSignInForm(page,{tries:6,wait:ms=>page.waitForTimeout(Math.min(ms,300))}),true);
  assert.equal(loads,2);
 } finally {await browser.close();}
});
