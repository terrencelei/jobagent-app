import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {safeNavigation,isApplicationEntry,isFinalControl,snapshot} from '../src/dashboard-worker.mjs';

// Hankook 12701: the Breezy HR posting page starts the application with an
// "Apply To Position" link; the runner rejected it and parked the role.
test('Breezy "Apply To Position" link on the posting page passes the click gate as an application entry',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const url='https://careers-hankooktire.breezy.hr/p/6f829b7570fb-entry-level-manufacturing-engineer';
  const HTML=`<html><body><div class="job-header"><h1>Entry Level Manufacturing Engineer</h1>
   <a class="button apply polygot button-full" href="/p/6f829b7570fb-entry-level-manufacturing-engineer/apply"><i class="fa fa-pencil"></i><span class="polygot">Apply To Position</span></a>
   <a href="/">View all positions</a></div></body></html>`;
  await page.route('https://careers-hankooktire.breezy.hr/**',r=>r.fulfill({contentType:'text/html',body:HTML}));
  await page.goto(url);
  const controls=(await snapshot(page)).frames.flatMap(f=>f.controls);
  const apply=controls.find(c=>/apply to position/i.test(c.label));
  assert.ok(apply,'the apply link is a control');
  const job={title:'Entry Level Manufacturing Engineer',url};
  assert.equal(safeNavigation(apply.label,job),true);
  assert.equal(isApplicationEntry(apply,[],job),true);
  assert.equal(isFinalControl(apply,[],job),false);
  assert.equal(safeNavigation('Apply To Position Later',job),false);
  const all=controls.find(c=>/view all positions/i.test(c.label));
  assert.ok(!all||!safeNavigation(all.label,job),'other links still fail the gate');
 }finally{await browser.close();}
});
