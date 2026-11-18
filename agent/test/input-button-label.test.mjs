import test from 'node:test';import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot,isFinalControl} from '../src/dashboard-worker.mjs';

// Siemens 6654: an Avature wizard's <input type=submit name=submit value=Continue> was labelled
// "submit" from its name, passed finalButton, and its step advance was recorded as a submission.
test('input buttons are labelled by their visible value, so a wizard Continue is not final',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  // A secure origin: snapshot uses crypto.randomUUID, which about:blank lacks.
  await page.route('https://jobs.example.com/**',r=>r.fulfill({contentType:'text/html',body:'<form><input name="first" required><input type="submit" name="submit" value="Continue"><input type="submit" name="go" value="Submit application"></form>'}));
  await page.goto('https://jobs.example.com/apply');
  const controls=(await snapshot(page)).frames.flatMap(f=>f.controls);
  const step=controls.find(c=>c.label==='Continue'),real=controls.find(c=>c.label==='Submit application');
  assert.ok(step,'Continue input is labelled by its value');assert.equal(isFinalControl(step),false);
  assert.ok(real);assert.equal(isFinalControl(real),true);
 }finally{await browser.close();}
});
