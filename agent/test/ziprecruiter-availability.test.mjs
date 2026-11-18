import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {zipRecruiterPostingUnavailable} from '../src/posting-availability.mjs';

const job={title:'Process Engineer - Manufacturing (Entry-Level)',company:'Fixture Manufacturing',url:'https://www.ziprecruiter.com/jobs/v2/fixture'};
const notice='This job post has expired 13 days ago. Applications are no longer accepted.';
const section=(title=job.title,company=job.company,message='')=>`<section><div><div data-testid="serp-job-details-title"><h2>${title}</h2></div><p>${company}</p></div><div><p>${message}</p></div></section>`;
const emailModal='<div role="dialog"><p>What email should the hiring manager reach you at?</p><label>Email<input type="email"></label><button>Continue</button></div>';

test('expired exact ZipRecruiter posting is unavailable even with an active email modal',async()=>{
 const browser=await chromium.launch({headless:true});
 let posts=0;
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/*',route=>{if(route.request().method()!=='GET')posts++;return route.fulfill({contentType:'text/html',body:section(job.title,job.company,notice)+emailModal});});
  await page.goto(job.url);
  assert.equal(await page.locator('input[type=email]:visible').count(),1);
  assert.equal(await zipRecruiterPostingUnavailable(page,job),notice);
  assert.equal(posts,0);
 }finally{await browser.close();}
});

test('closure requires visible notice bound to exact primary title, company and posting URL',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html></html>'}));
  await page.goto(job.url);
  for(const [reason,html] of [
   ['active posting',section()+emailModal],
   ['expired recommendation',section()+section('Unrelated Engineer','Other Company',notice)],
   ['wrong employer',section(job.title,'Other Company',notice)],
   ['wrong title',section('Another Engineer',job.company,notice)],
   ['hidden notice',section(job.title,job.company,`<span style="display:none">${notice}</span>`)],
   ['unbound notice',section()+`<aside>${notice}</aside>`],
   ['duplicate primary titles',section()+section(job.title,job.company,notice)],
   ['rate limit',section(job.title,job.company,'Unusual traffic from your browser')],
  ]){
   await page.setContent(html);
   assert.equal(await zipRecruiterPostingUnavailable(page,job),null,reason);
  }
  await page.setContent(section(job.title,job.company,notice));
  assert.equal(await zipRecruiterPostingUnavailable(page,{...job,url:'https://www.ziprecruiter.com/jobs/v2/other'}),null);
  assert.equal(await zipRecruiterPostingUnavailable(page,{...job,url:'https://example.com/jobs/v2/fixture'}),null);
 }finally{await browser.close();}
});

test('worker skips expired posting before account preparation or agent decisions under auto-submit',async()=>{
 const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {runWorker,atomic}=await import('../src/dashboard-worker.mjs');
 const dir=await mkdtemp(join(tmpdir(),'zip-expired-'));
 const originalLaunch=chromium.launch;
 let posts=0,decisions=0;
 chromium.launch=async function(options){
  const browser=await originalLaunch.call(this,options);
  const newContext=browser.newContext.bind(browser);
  browser.newContext=async options=>{
   const context=await newContext(options);
   const newPage=context.newPage.bind(context);
   context.newPage=async()=>{
    const page=await newPage();
    await page.route('**/*',route=>{
     if(route.request().method()!=='GET')posts++;
     return route.fulfill({contentType:'text/html',body:section(job.title,job.company,notice)+emailModal});
    });
    return page;
   };
   return context;
  };
  return browser;
 };
 try{
  const run=join(dir,'run'),profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
  await mkdir(run);await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant'}}));await writeFile(resume,'fixture');
  await atomic(join(run,'request.json'),{job:{...job,id:998464},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:true,maxSteps:2});
  await runWorker(run,{allowLocalFixture:true,stateRoot:join(dir,'state'),execImpl:async()=>{decisions++;throw Error('Expired posting must not reach the agent');}});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'skipped',state.message);
  assert.equal(state.posting_unavailable,true);
  assert.match(state.message,/expired 13 days ago/);
  assert.equal(state.submission_attempted,undefined);
  assert.notEqual(state.submitted,true);
  assert.equal(decisions,0);assert.equal(posts,0);
 }finally{chromium.launch=originalLaunch;await rm(dir,{recursive:true,force:true});}
});
