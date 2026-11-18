import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {metaPostingUnavailable} from '../src/posting-availability.mjs';

const job={title:'Manufacturing Test Engineering Intern, Field Requirements & Feedback',company:'Meta',url:'https://www.metacareers.com/profile/job_details/940553205402689/'};
const profileGone='<nav>Jobs Teams</nav><main><div role="heading">The Perfect Job Exists, But This Page Doesn\'t</div><p>Please contact your recruiter for assistance</p><a href="/">Go to Home Page</a></main>';
const publicGone='<main><h2>Sorry, this job is no longer available</h2><p>It looks like the job description you were looking for has been removed.</p><input aria-label="Search Meta Careers"></main>';
const livePage='<main><h1>Manufacturing Test Engineering Intern</h1><button>Apply now</button></main>';
const redirect=location=>({status:301,headers:new Headers({location})});
const live={status:200,headers:new Headers()};

async function serve(page,routes){
 await page.route('**/*',route=>{const u=new URL(route.request().url());return route.fulfill({status:200,contentType:'text/html',body:routes[u.pathname]??'<html></html>'});});
}

test('Meta profile page for a removed job is unavailable when its public URL redirects to position-not-available (9850)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await serve(page,{'/profile/job_details/940553205402689/':profileGone,'/jobs/position-not-available/':publicGone});
  const fetched=[];
  await page.goto(job.url);
  assert.match(await metaPostingUnavailable(page,job,{fetch:async url=>{fetched.push(url);return redirect('https://www.metacareers.com/jobs/position-not-available/');}}),/Perfect Job Exists.*position-not-available/);
  assert.deepEqual(fetched,['https://www.metacareers.com/jobs/940553205402689/']);
  await page.goto('https://www.metacareers.com/jobs/position-not-available/');
  assert.match(await metaPostingUnavailable(page,{...job,url:'https://www.metacareers.com/jobs/940553205402689/'}),/Sorry, this job is no longer available/);
 }finally{await browser.close();}
});

test('a generic Meta missing page, a live posting, another role or another host is not a closure',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await serve(page,{'/profile/job_details/940553205402689/':profileGone,'/profile/job_details/111111111/':profileGone,'/jobs/940553205402689/':livePage});
  await page.goto(job.url);
  assert.equal(await metaPostingUnavailable(page,job,{fetch:async()=>live}),null,'public URL still live');
  assert.equal(await metaPostingUnavailable(page,job,{fetch:async()=>redirect('https://www.metacareers.com/jobs/')}),null,'redirect elsewhere');
  assert.equal(await metaPostingUnavailable(page,job,{fetch:async()=>{throw new Error('offline');}}),null,'probe failed');
  assert.equal(await metaPostingUnavailable(page,job),null,'no probe available');
  await page.goto('https://www.metacareers.com/profile/job_details/111111111/');
  assert.equal(await metaPostingUnavailable(page,job,{fetch:async()=>redirect('/jobs/position-not-available/')}),null,'different job id');
  await page.goto('https://www.metacareers.com/jobs/940553205402689/');
  assert.equal(await metaPostingUnavailable(page,{...job,url:'https://www.metacareers.com/jobs/940553205402689/'},{fetch:async()=>redirect('/jobs/position-not-available/')}),null,'live posting page');
  await page.goto(job.url);
  assert.equal(await metaPostingUnavailable(page,{...job,url:'https://careers.example.com/profile/job_details/940553205402689/'},{fetch:async()=>redirect('/jobs/position-not-available/')}),null,'other host');
 }finally{await browser.close();}
});
