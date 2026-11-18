import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot} from '../src/dashboard-worker.mjs';
import {inactiveLocationExplanation} from '../src/conditional-fields.mjs';

test('always-required Greenhouse location explanation follows retained approved office only',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('https://example.test/**',route=>route.fulfill({body:'<html></html>',contentType:'text/html'}));
  await page.goto('https://example.test/');
  await page.setContent(`<form><fieldset><legend>Please select the office location(s) you are applying to work from *</legend><input id="office" name="offices[]" type="checkbox"><label for="office">Long Beach, CA</label><input id="other" name="offices[]" type="checkbox"><label for="other">N/A - Other Location</label></fieldset><label for="explain">If "N/A Other Location" selected above, please explain*</label><input id="explain" required></form>`);
  const read=async()=> (await snapshot(page)).frames[0].controls;
  assert.equal(inactiveLocationExplanation(await read(),'Long Beach, CA'),null);
  await page.locator('#office').check();
  const result=inactiveLocationExplanation(await read(),'Long Beach, CA');
  assert.equal(result.value,'N/A');
  assert.equal(result.control.domId,'explain');
  assert.equal(inactiveLocationExplanation(await read(),undefined),null);
  assert.equal(inactiveLocationExplanation(await read(),'Littleton, CO'),null);
  await page.locator('#other').check();
  assert.equal(inactiveLocationExplanation(await read(),'Long Beach, CA'),null);
  await page.locator('#office').uncheck();
  assert.equal(inactiveLocationExplanation(await read(),'N/A - Other Location'),null);
  await page.locator('#other').uncheck();await page.locator('#office').check();
  await page.locator('#explain').fill('Approved explanation');
  assert.equal(inactiveLocationExplanation(await read(),'Long Beach, CA'),null);
 }finally{await browser.close();}
});
