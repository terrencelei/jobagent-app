import test from 'node:test';import assert from 'node:assert/strict';import{chromium}from'playwright';import{snapshot}from'../src/dashboard-worker.mjs';
test('Ashby phone input sharing an entry with SMS-consent radios is still exposed',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<html></html>'}));await page.goto('http://localhost/fixture');
  await page.setContent('<form><div class="ashby-application-form-field-entry"><label for="p" class="ashby-application-form-question-title _required_x">Phone Number</label><input id="p" type="tel" required><label><input type="radio" name="c" value="Yes">Yes - I consent</label><label><input type="radio" name="c" value="No">No - I do not consent</label></div></form>');
  const controls=(await snapshot(page)).frames[0].controls;
  const phone=controls.find(c=>c.type==='tel');
  assert.equal(phone?.label,'Phone Number');assert.equal(phone.required,true);assert.equal(phone.value,'');
  assert.equal(controls.filter(c=>c.type==='choice').length,1);
  assert.equal(controls.filter(c=>c.type==='radio').length,0);
 }finally{await browser.close();}
});
