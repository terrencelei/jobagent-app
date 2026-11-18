import test from 'node:test';import assert from 'node:assert/strict';import{chromium}from'playwright';import{snapshot}from'../src/dashboard-worker.mjs';
test('Ashby date inputs use their own question heading rather than the generic date placeholder',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<html></html>'}));await page.goto('http://localhost/fixture');
  await page.setContent('<form><div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">What is the earliest date you are available to start this position?</label><input required placeholder="Pick date..."></div><div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Graduation Date</label><input placeholder="Pick date..."></div><div class="ashby-application-form-field-entry"><input placeholder="Unknown date"></div></form>');
  const fields=(await snapshot(page)).frames[0].controls.filter(c=>c.type==='text');
  assert.deepEqual(fields.map(c=>c.label),['What is the earliest date you are available to start this position?','Graduation Date','Unknown date']);
  assert.equal(fields[0].required,true);
 }finally{await browser.close();}
});
