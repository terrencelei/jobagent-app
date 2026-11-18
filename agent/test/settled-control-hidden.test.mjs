import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot,alreadyHolds,withoutSettled} from '../src/dashboard-worker.mjs';

// Hyundai 15303 (SuccessFactors career8, lesson 485): the model picked the filled "* Zip/Postal Code:" four times;
// every refill was sent back as "already holds that answer" until the rejection cap ended the run. A control sent
// back that way stays out of later snapshots while it still shows that value.
const page=`<form><label for="zip">*<br>&nbsp;Zip/Postal Code:</label><input id="zip" required value="93117">
<label for="sig">* Typed Signature</label><input id="sig" required>
<label for="ref">* 1. Were you referred by an employee? if yes, please enter their name.</label><textarea id="ref" required></textarea></form>`;
const labels=snap=>snap.frames.flatMap(f=>f.controls).map(c=>c.label);

test('a control rejected as already holding its answer is hidden from the next snapshot until its value changes',async()=>{
 const browser=await chromium.launch();
 try{
  const p=await browser.newPage();
  await p.route('https://career8.successfactors.com/apply',r=>r.fulfill({contentType:'text/html',body:page}));
  await p.goto('https://career8.successfactors.com/apply');
  const snap=await snapshot(p);
  const zip=snap.frames.flatMap(f=>f.controls).find(c=>/Zip\/Postal/.test(c.label));
  assert.ok(zip,'zip control in snapshot');
  assert.equal(alreadyHolds(zip,'93117',[{label:zip.label,value:'93117'}]),true);
  const settled=new Map([[zip.label,String(zip.value)]]);
  const hidden=labels(withoutSettled(snap,settled));
  assert.ok(!hidden.includes(zip.label),'filled zip no longer offered');
  assert.ok(hidden.some(l=>/Typed Signature/.test(l))&&hidden.some(l=>/referred by an employee/.test(l)),'open questions still offered');
  await p.fill('#zip','');
  assert.ok(labels(withoutSettled(await snapshot(p),settled)).includes(zip.label),'a cleared zip is offered again');
  await p.fill('#zip','94000');
  assert.ok(labels(withoutSettled(await snapshot(p),settled)).includes(zip.label),'a changed zip is offered again');
  assert.equal(withoutSettled(snap,new Map()),snap);
 }finally{await browser.close();}
});
