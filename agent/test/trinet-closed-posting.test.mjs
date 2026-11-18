import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {trinetPostingUnavailable} from '../src/trinet-availability.mjs';

// KUNZ 6951 (lesson 467): a closed TriNet Hire job keeps its description and swaps Apply for a notice.
const url='https://app.trinethire.com/companies/691974-kunz/jobs/123371-mechanical-design-engineer-production-design-san-francisco';
const job={title:'Mechanical Design Engineer',url};
const closed='<h1>Mechanical Design Engineer</h1><p>Description</p><p>This job is currently not open for applications. <a href="/companies/691974-kunz/jobs">Would you like to see our other open positions?</a></p><a href="/privacy">Privacy Policy</a>';
const live='<h1>Mechanical Design Engineer</h1><p>Description</p><a href="/apply">Apply</a>';

test('TriNet Hire closed posting is unavailable; open, other job, other host are not',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const open=async(target,body)=>{await page.unroute('**/*');await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body}));await page.goto(target);};
  await open(url,closed);
  assert.match(await trinetPostingUnavailable(page,job),/not open for applications/);
  await open(url,live);
  assert.equal(await trinetPostingUnavailable(page,job),null,'open job');
  await open(url,closed+'<button>Apply Now</button>');
  assert.equal(await trinetPostingUnavailable(page,job),null,'Apply control');
  await open(url.replace('123371','999999'),closed);
  assert.equal(await trinetPostingUnavailable(page,job),null,'another job');
  await open('https://app.trinethire.com/companies/691974-kunz/jobs',closed);
  assert.equal(await trinetPostingUnavailable(page,job),null,'jobs list');
  await open('https://evil.example/companies/691974-kunz/jobs/123371-x',closed);
  assert.equal(await trinetPostingUnavailable(page,{...job,url:'https://evil.example/companies/691974-kunz/jobs/123371-x'}),null,'other host');
 }finally{await browser.close();}
});
