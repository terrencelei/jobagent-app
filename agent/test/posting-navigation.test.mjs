import test, {mock} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {workableApplicationURL} from '../src/posting-navigation.mjs';
import {snapshot,runWorker,atomic} from '../src/dashboard-worker.mjs';

const posting='https://apply.workable.com/fixture-aerospace/jobs/view/ABC1234567';
const application='https://apply.workable.com/fixture-aerospace/j/ABC1234567/apply';

test('Workable Markdown routes resolve to the same exact employer and job form',()=>{
 assert.equal(workableApplicationURL(posting),application);
 assert.equal(workableApplicationURL(posting+'/?source=board#apply'),application+'?source=board#apply');
 assert.equal(workableApplicationURL(application),application);
 for(const url of [
  'https://other.workable.com/fixture-aerospace/jobs/view/ABC1234567',
  'https://apply.workable.com.evil.test/fixture-aerospace/jobs/view/ABC1234567',
  'https://user:secret@apply.workable.com/fixture-aerospace/jobs/view/ABC1234567',
  'http://apply.workable.com/fixture-aerospace/jobs/view/ABC1234567',
  'https://apply.workable.com/fixture-aerospace/jobs/view/ABC1234567/other',
  'https://apply.workable.com/other/jobs/view/short',
  'https://example.test/jobs/view/ABC1234567','not a URL',
 ])assert.equal(workableApplicationURL(url),url);
});

test('local Chromium fixture reproduces Markdown without controls and opens HTML without submitting',async()=>{
 const browser=await chromium.launch({headless:true});
 let posts=0,formLoads=0,external=0;
 try{
  const page=await browser.newPage();
  await page.route('**/*',async route=>{
   const req=route.request();
   if(req.method()!=='GET'){posts++;return route.abort();}
   if(req.url()===posting)return route.fulfill({contentType:'text/markdown; charset=utf-8',body:`# Mechanical Engineer I\n\n## Apply\n[Apply at Fixture Aerospace](${application})`});
   if(req.url()===application){formLoads++;return route.fulfill({contentType:'text/html',body:'<h1>Mechanical Engineer I</h1><form method="post"><label>First name<input name="first_name" required></label><button type="submit">Submit application</button></form>'});}
   external++;return route.abort();
  });
  await page.goto(posting);
  const failed=await snapshot(page);
  assert.equal(failed.frames.flatMap(f=>f.controls).length,0);
  assert.match(failed.frames[0].text,/\[Apply at Fixture Aerospace\]/);
  await page.goto(workableApplicationURL(posting));
  const repaired=await snapshot(page),controls=repaired.frames.flatMap(f=>f.controls);
  assert.ok(controls.find(c=>c.label==='First name'&&c.required));
  assert.ok(controls.find(c=>c.label==='Submit application'&&c.type==='submit'));
  assert.equal(formLoads,1);assert.equal(posts,0);assert.equal(external,0);
 }finally{await browser.close();}
});


test('worker opens the normalized Workable form and reaches review with zero submission requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workable-navigation-')),run=join(dir,'run');
 await mkdir(run);
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
 await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant'}}));
 await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:9910572,company:'Fixture Aerospace',title:'Mechanical Engineer I',url:posting},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,maxSteps:4});
 let posts=0,formLoads=0,markdownLoads=0,external=0;
 const launch=chromium.launch.bind(chromium);
 const patched=mock.method(chromium,'launch',async options=>{
  const browser=await launch(options),newContext=browser.newContext.bind(browser);
  browser.newContext=async options=>{
   const context=await newContext(options),newPage=context.newPage.bind(context);
   context.newPage=async()=>{
    const page=await newPage();
    await page.route('**/*',async route=>{
     const req=route.request();
     if(req.method()!=='GET'){posts++;return route.abort();}
     if(req.url()===posting){markdownLoads++;return route.fulfill({contentType:'text/markdown',body:`# Mechanical Engineer I\n[Apply](${application})`});}
     if(req.url()===application){formLoads++;return route.fulfill({contentType:'text/html',body:'<form method="post"><label>Name<input required name="name"></label><button type="submit">Submit application</button></form>'});}
     external++;return route.abort();
    });return page;
   };return context;
  };return browser;
 });
 const execImpl=async(_command,_args,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const field=controls.find(c=>c.type==='text'&&!c.value),target=field??controls.find(c=>c.type==='submit');
  assert.ok(target,'worker must receive application controls');
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:field?'fill':'review',control:target.id,fact:field?'fullName':'',message:''},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);
  assert.equal(state.url,application);
  assert.equal(formLoads,1);assert.equal(markdownLoads,0);assert.equal(posts,0);assert.equal(external,0);
 }finally{patched.mock.restore();await rm(dir,{recursive:true,force:true});}
});
