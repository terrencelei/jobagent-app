import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot} from '../src/dashboard-worker.mjs';

// Collins Aerospace 15385 / 16670 (Phenom, lesson 487): the question text linked a PDF with <a type="url" ...>Right to
// Work</a>. An anchor's .type reflects that attribute, so the snapshot listed the link as a "url" text field, a scripted
// answer called fill("Yes") on it and Playwright's "Element is not an <input>" error failed the run.
test('a link carrying type="url" is listed as a link, never as a text field',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('https://fixture.test/',route=>route.fulfill({contentType:'text/html',body:`<form><p>Do you have the <a type="url" target="_blank" class="cke-link" href="https://example.test/RighttoWork.pdf">Right to Work</a> in the U.S.?</p>
   <label>Website <input type="url" name="site"></label><a href="/next">Plain link</a></form>`}));
  await page.goto('https://fixture.test/');
  const controls=(await snapshot(page)).frames.flatMap(f=>f.controls);
  const link=controls.find(c=>/Right to Work/.test(c.label));
  if(link)assert.equal(link.type,'a');
  assert.ok(!controls.some(c=>c.type==='url'&&/Right to Work/.test(c.label)));
  assert.equal(controls.find(c=>/Website/.test(c.label))?.type,'url');
  const plain=controls.find(c=>/Plain link/.test(c.label));if(plain)assert.equal(plain.type,'a');
 }finally{await browser.close();}
});
