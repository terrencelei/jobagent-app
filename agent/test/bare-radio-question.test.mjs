import test from 'node:test';import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot} from '../src/dashboard-worker.mjs';

// Cisco 12281: Yes/No radios outside any fieldset were labelled only "Yes"/"No", so a "No" fact
// unchecked the No radio and a stray "Yes" claimed a prior Cisco employee ID.
test('bare same-name radios take their question from the group container',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.route('https://jobs.example.com/**',r=>r.fulfill({contentType:'text/html',body:'<form><div><p>Have you ever been issued a Cisco Employee ID?</p><span>*</span><input type="radio" id="a" name="prev" value="true"><label for="a">Yes</label><input type="radio" id="b" name="prev" value="false"><label for="b">No</label></div></form>'}));
  await page.goto('https://jobs.example.com/apply');
  const radios=(await snapshot(page)).frames.flatMap(f=>f.controls).filter(c=>c.type==='radio');
  assert.deepEqual(radios.map(c=>[c.label,c.optionLabel]),[['Have you ever been issued a Cisco Employee ID?','Yes'],['Have you ever been issued a Cisco Employee ID?','No']]);
  assert.deepEqual(radios[0].choiceLabels,['Yes','No']);
 }finally{await browser.close();}
});
