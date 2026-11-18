import test from 'node:test';import assert from 'node:assert/strict';import{chromium}from'playwright';import{snapshot}from'../src/dashboard-worker.mjs';
// Amazon 15083: a visibility:hidden twin of the city input (class="invisible") was listed as a question and
// fill() timed out on it. Only the rendered input is a control.
test('a visibility:hidden twin input is not offered as a control',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<html></html>'}));await page.goto('http://localhost/fixture');
  await page.setContent('<style>.invisible{visibility:hidden}</style><form><label>City <input name="city" aria-label="city"></label><input class="invisible" name="city" aria-label="city"></form>');
  const fields=(await snapshot(page)).frames[0].controls.filter(c=>c.type==='text');
  assert.equal(fields.length,1);
  await page.locator(`[data-ja-control="${fields[0].id}"]`).fill('Springfield');
 }finally{await browser.close();}
});
