import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {setCheckedControl,snapshot} from '../src/dashboard-worker.mjs';

// Amazon 16226: the "previously employed by Amazon" radio kept its checked state for a moment, then the page
// rendered the follow-up question and cleared it. The readback straight after the click saw it checked, the
// next Continue found it empty. A selection must survive a short pause, or be clicked again.
const fixture=`<div id="g"><p>Previously employed by Amazon?</p>
<label><input type="radio" name="prev" value="No">No</label>
<label><input type="radio" name="prev" value="Yes">Yes</label></div>
<script>let reset=false;
document.querySelector('#g').addEventListener('change',e=>{
 if(reset)return;reset=true;
 setTimeout(()=>{e.target.checked=false;},150);
});</script>`;

test('a radio cleared shortly after the click is selected again',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.route('https://account.example.com/**',r=>r.fulfill({contentType:'text/html',body:fixture}));
  await page.goto('https://account.example.com/apply');
  const no=(await snapshot(page)).frames[0].controls.find(c=>c.type==='radio'&&c.optionLabel==='No');
  await setCheckedControl(page,page.locator(`[data-ja-control="${no.id}"]`),true);
  await page.waitForTimeout(600);
  assert.equal(await page.locator('input[value="No"]').isChecked(),true);
 }finally{await browser.close();}
});
