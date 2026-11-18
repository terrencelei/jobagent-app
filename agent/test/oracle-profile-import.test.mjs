import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {resumeAttached} from '../src/dashboard-worker.mjs';

// NOV 13365: Oracle CX's "Import your profile" upload clears its input after parsing and shows only a success message.
test('an Oracle profile import is verified by its success message, not the file name',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<section><h2>Import your profile</h2><div id="box"><label>Upload Resume<input id="resume" type="file"></label></div></section>');
  await page.evaluate(()=>setTimeout(()=>{document.querySelector('#box').innerHTML='<p>Profile successfully imported.</p><button>Import Profile Again</button>';},150));
  assert.equal(await resumeAttached(page.mainFrame(),page.locator('#resume'),'Fixture_Resume.pdf',{wait:ms=>new Promise(r=>setTimeout(r,ms))}),true);
  await page.setContent('<section><h2>Import your profile</h2><label>Upload Resume<input id="resume" type="file"></label><p>We could not import your profile.</p></section>');
  assert.equal(await resumeAttached(page.mainFrame(),page.locator('#resume'),'Fixture_Resume.pdf',{tries:2,wait:async()=>{}}),false);
 }finally{await browser.close();}
});
