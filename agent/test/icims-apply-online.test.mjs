import test from 'node:test';
import assert from 'node:assert/strict';
import {safeNavigation,isApplicationEntry,isFinalControl} from '../src/dashboard-worker.mjs';

// Great Dane 13347: the iCIMS posting page starts the application with a link
// "Apply for this job online"; the runner rejected it and parked the role.
test('iCIMS "Apply for this job online" is the application entry, not a final submit',()=>{
 const job={title:'Process Engineer',url:'https://careers-greatdane.icims.com/jobs/4087/job'};
 const link={type:'a',label:'Apply for this job online',inForm:false,href:'https://careers-greatdane.icims.com/jobs/4087/process-engineer/login'};
 assert.equal(safeNavigation(link.label,job),true);
 assert.equal(isApplicationEntry(link,[],job),true);
 assert.equal(isFinalControl(link,[],job),false);
 assert.equal(safeNavigation('Apply for this job online today',job),false);
});

import {chromium} from 'playwright';
import {snapshot} from '../src/dashboard-worker.mjs';

// Fixture: the iCIMS posting overview as the runner sees it (a plain same-site link, outside any form).
test('snapshot of an iCIMS posting page yields an "Apply for this job online" link that passes the click gate',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const HTML=`<html><body><div class="iCIMS_JobOptions"><h1>Process Engineer</h1>
   <a class="iCIMS_ApplyOnlineButton" href="https://careers-greatdane.icims.com/jobs/4087/process-engineer/login" title="Apply for this job online">Apply for this job online</a>
   <a href="https://careers-greatdane.icims.com/jobs/4087/process-engineer/referral" title="Refer this job to a friend">Refer this job to a friend</a></div></body></html>`;
  await page.route('https://careers-greatdane.icims.com/**',r=>r.fulfill({contentType:'text/html',body:HTML}));
  await page.goto('https://careers-greatdane.icims.com/jobs/4087/job');
  const snap=await snapshot(page);
  const controls=snap.frames.flatMap(f=>f.controls);
  const apply=controls.find(c=>/apply for this job online/i.test(c.label));
  assert.ok(apply,'the apply link is a control');
  assert.equal(apply.inForm,false);
  const job={title:'Process Engineer',url:'https://careers-greatdane.icims.com/jobs/4087/job'};
  assert.equal(safeNavigation(apply.label,job),true);
  assert.equal(isApplicationEntry(apply,[],job),true);
  assert.equal(isFinalControl(apply,[],job),false);
  const refer=controls.find(c=>/refer this job/i.test(c.label));
  assert.ok(refer&&!safeNavigation(refer.label,job)&&!isApplicationEntry(refer,[],job),'the referral link still fails the gate');
 }finally{await browser.close();}
});
