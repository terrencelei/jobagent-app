import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {paycorPostingUnavailable} from '../src/paycor-availability.mjs';

// Campbell Scientific 12670: the posting page's Paycor frame (JobIntroduction.action?id=<gni>) said only
// "Sorry, this job is no longer active." and the run stopped as needs_human instead of being skipped.
const id='8a78859fa0f425c801a0feca9b1a4505';
const job={id:12670,title:'Mechanical Design Engineer',url:`https://www.campbellsci.com/open-positions?gnk=job&gni=${id}&gns=Indeed+Free`};
const closed='<table id="gnewtonConfirmation"><tr><td>Sorry, this job is no longer active. You can view our main careers page by clicking <a href="https://recruitingbypaycor.com/career/CareerHome.action?clientId=x">here</a></td></tr></table>';
const frameUrl=(jobId=id,host='recruitingbypaycor.com')=>`https://${host}/career/JobIntroduction.action?clientId=8acd&id=${jobId}&source=Indeed%20Free`;

async function check(t,{frame=frameUrl(),body=closed,posting=job}={}){
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('**/*',route=>{const u=route.request().url();
   if(u.startsWith('https://www.campbellsci.com/'))return route.fulfill({contentType:'text/html',body:`<h1>Current Career Opportunities</h1><iframe src="${frame}"></iframe>`});
   return route.fulfill({contentType:'text/html',body});});
  await page.goto(job.url);await page.waitForLoadState('load');
  return await paycorPostingUnavailable(page,posting);
 }finally{await browser.close();}
}

test('a closed Paycor job in the employer frame is posting_unavailable',async t=>{
 assert.match(await check(t),/no longer active/);
 assert.equal(await check(t,{frame:frameUrl('8a78859fa0f425c801a0feca9b1a9999')}),null,'another job id');
 assert.equal(await check(t,{frame:frameUrl(id,'recruitingbypaycor.evil.example')}),null,'another host');
 assert.equal(await check(t,{body:closed+'<a href="/apply">Apply</a>'}),null,'an Apply control');
 assert.equal(await check(t,{body:'<h1>Mechanical Design Engineer</h1><a href="/apply">Apply Now</a>'}),null,'an open job');
 assert.equal(await check(t,{posting:{...job,url:'https://www.campbellsci.com/open-positions'}}),null,'posting URL without an id');
});
