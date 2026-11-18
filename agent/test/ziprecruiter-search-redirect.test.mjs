import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zipRecruiterSearchRedirect} from '../src/posting-availability.mjs';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

const posting='https://www.ziprecruiter.com/jobs/v2/fixture-listing?tsid=123';
const search='https://www.ziprecruiter.com/jobs-search?lk=fixture';
test('specific ZipRecruiter listing lost to generic search requires link verification, never implies closure',()=>{
 assert.equal(zipRecruiterSearchRedirect(posting,search),true);
 assert.equal(zipRecruiterSearchRedirect(posting,search.replace('www.','')),true);
 for(const [original,current] of [[posting,posting],[posting,'https://www.ziprecruiter.com/jobs/v2/other'],[search,search],['invalid',search],[posting,'http://www.ziprecruiter.com/jobs-search'],[posting,'https://evil.example/jobs-search'],[posting,'https://user@www.ziprecruiter.com/jobs-search'],[posting,'https://www.ziprecruiter.com/jobs-search-extra']])assert.equal(zipRecruiterSearchRedirect(original,current),false);
});

test('worker parks a real redirect to an unrelated Apply card before decisions, clicks, or submission',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zip-search-')),launch=chromium.launch;let decisions=0,posts=0;
 chromium.launch=async function(options){
  const browser=await launch.call(this,options),newContext=browser.newContext.bind(browser);
  browser.newContext=async options=>{
   const context=await newContext(options);
   const newPage=context.newPage.bind(context);context.newPage=async()=>{
   const page=await newPage();await page.route('**/*',route=>{
    if(route.request().method()!=='GET')posts++;
    if(new URL(route.request().url()).pathname.startsWith('/jobs/v2/'))return route.fulfill({contentType:'text/html',body:`<script>location.replace(${JSON.stringify(search)})</script>`});
    return route.fulfill({contentType:'text/html',body:'<h1>All jobs in Springfield</h1><section><h2 data-testid="serp-job-details-title">Tax Advisor - In-Store</h2><p>Intuit</p><form method="post"><input name="email"><button>Apply</button></form></section>'});
   });return page;};return context;
  };return browser;
 };
 try{
  const run=join(dir,'run'),profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await mkdir(run);
  await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant'}}));await writeFile(resume,'fixture');
  await atomic(join(run,'request.json'),{job:{id:999572,company:'Fixture Manufacturing',title:'Mechanical Engineer',url:posting},profilePath:profile,resumePath:resume,engine:'codex',autoSubmit:true,maxSteps:1});
  await runWorker(run,{allowLocalFixture:true,stateRoot:join(dir,'state'),execImpl:async()=>{decisions++;throw Error('Search results must never reach the decision agent');}});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'needs_human',state.message);assert.equal(state.posting_link_unverified,true);assert.equal(state.url,search);
  assert.notEqual(state.posting_unavailable,true);assert.equal(state.submission_attempted,undefined);assert.equal(decisions,0);assert.equal(posts,0);
 }finally{chromium.launch=launch;await rm(dir,{recursive:true,force:true});}
});
