import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {llnlPostingUnavailable} from '../src/posting-availability.mjs';

// LLNL 12783 (lesson 464): a closed requisition keeps its own URL and answers 200 with this notice.
const url='https://www.llnl.gov/join-our-team/careers/find-your-job/all/all/3743990016156496';
const job={title:'Mechanical Engineer – Generalist',company:'Lawrence Livermore National Laboratory',url};
const filters='<form><h1>For Current Employees</h1><label><input type="checkbox"> None, U.S. Citizenship (4)</label><button type="button">Filters</button></form>';
const closed=`${filters}<a href="/join-our-team/careers/find-your-job/all/all" class="m-t-md">Back to open positions</a><h2 class="open-pos">This position is no longer posted</h2><div class="row job-post"><div class="col-md-12 post-details" id="3743990016156496"><p><a href="/join-our-team/careers/find-your-job">View other opportunities</a> to join our team.</p></div></div>`;
const live=`${filters}<div class="row job-post"><div class="col-md-12 post-details" id="3743990016156496"><h2>Mechanical Engineer – Generalist</h2><a href="https://jobs.smartrecruiters.com/LLNL/3743990016156496-mechanical-engineer-generalist?oga=true" target="_blank" class="btn btn-warning">Apply Now&nbsp;&nbsp;</a></div></div>`;

async function open(page,target,body){
 await page.unroute('**/*');
 await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body}));
 await page.goto(target);
}

test('LLNL closed posting at its own URL is unavailable (12783)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await open(page,url,closed);
  assert.match(await llnlPostingUnavailable(page,job),/This position is no longer posted/);
 }finally{await browser.close();}
});

test('a live LLNL posting, another id, a search page or another host is not a closure',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await open(page,url,live);
  assert.equal(await llnlPostingUnavailable(page,job),null,'Apply Now present');
  await open(page,url,closed.replace('id="3743990016156496"','id="3743990016150000"'));
  assert.equal(await llnlPostingUnavailable(page,job),null,'details block for another id');
  await open(page,'https://www.llnl.gov/join-our-team/careers/find-your-job/all/all/3743990016150000',closed);
  assert.equal(await llnlPostingUnavailable(page,job),null,'different posting id in the URL');
  await open(page,'https://www.llnl.gov/join-our-team/careers/find-your-job/all/all',closed);
  assert.equal(await llnlPostingUnavailable(page,job),null,'filtered search without a posting');
  await open(page,'https://careers.example.com/join-our-team/careers/find-your-job/all/all/3743990016156496',closed);
  assert.equal(await llnlPostingUnavailable(page,{...job,url:'https://careers.example.com/join-our-team/careers/find-your-job/all/all/3743990016156496'}),null,'different host');
 }finally{await browser.close();}
});
