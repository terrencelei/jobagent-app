import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {setCheckedControl,snapshot} from '../src/dashboard-worker.mjs';

// Keel 12694 (Paylocity): choosing "Other" under "How did you hear about us?" makes the page re-render
// the radio list to reveal "Please Specify". The clicked <input> is replaced by a new node without the
// snapshot's data-ja-control tag, so the readback after the click waited 10 s for a detached element
// and the run failed with "locator.isChecked: Timeout". The same input is now followed by name+value.
const fixture=`<div id="group">
 <p>How did you hear about us?</p>
 <label><input type="radio" name="info.howDidYouHearAboutUs" value="Online Job Board">Online Job Board</label>
 <label><input type="radio" name="info.howDidYouHearAboutUs" value="Other">Other</label>
</div>
<script>
 document.querySelector('#group').addEventListener('change',e=>{
  if(e.target.value!=='Other')return;
  // React-style re-mount: a fresh node carries the new state and none of the old attributes.
  const fresh=document.createElement('input');
  fresh.type='radio';fresh.name=e.target.name;fresh.value=e.target.value;fresh.checked=true;
  e.target.replaceWith(fresh);
  const specify=document.createElement('label');specify.innerHTML='Please Specify <input name="info.howDidYouHearAboutUsOther">';
  document.querySelector('#group').append(specify);
 });
</script>`;

test('a radio replaced by the page when clicked is still verified as selected',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.route('https://recruiting.example.com/**',r=>r.fulfill({contentType:'text/html',body:fixture}));
  await page.goto('https://recruiting.example.com/Recruiting/Jobs/Apply/1');
  const controls=(await snapshot(page)).frames[0].controls;
  const other=controls.find(c=>c.type==='radio'&&c.optionLabel==='Other');
  await setCheckedControl(page,page.locator(`[data-ja-control="${other.id}"]`),true);
  assert.equal(await page.locator('input[value="Other"]').isChecked(),true);
  assert.equal(await page.locator('input[name="info.howDidYouHearAboutUsOther"]').count(),1);
  const after=(await snapshot(page)).frames[0].controls.find(c=>c.type==='radio'&&c.optionLabel==='Other');
  assert.equal(after.value,'true');
 }finally{await browser.close();}
});

test('a replaced input that did not keep the choice is reported, not waited on',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.route('https://recruiting.example.com/**',r=>r.fulfill({contentType:'text/html',body:fixture.replace('fresh.checked=true;','fresh.checked=false;')}));
  await page.goto('https://recruiting.example.com/Recruiting/Jobs/Apply/1');
  const other=(await snapshot(page)).frames[0].controls.find(c=>c.type==='radio'&&c.optionLabel==='Other');
  const started=Date.now();
  await assert.rejects(setCheckedControl(page,page.locator(`[data-ja-control="${other.id}"]`),true),/did not retain/);
  assert.ok(Date.now()-started<2500,'no timeout wait on the detached node');
 }finally{await browser.close();}
});
