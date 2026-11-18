import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {platformApplyLink,runWorker,atomic} from '../src/dashboard-worker.mjs';

// LLNL 12783: the posting lives on llnl.gov and its "Apply Now" link opens the same requisition on
// SmartRecruiters in a new tab. The worker refused it as an unverified external link (lesson 336).
const job={id:12783,title:'Mechanical Engineer – Generalist',url:'https://www.llnl.gov/join-our-team/careers/find-your-job/all/all/3743990016156496'};
const apply={type:'a',label:'Apply Now  ',href:'https://jobs.smartrecruiters.com/LLNL/3743990016156496-mechanical-engineer-generalist?oga=true'};

test('a hiring-platform Apply link carrying the posting id is the verified application URL',()=>{
 assert.equal(platformApplyLink(apply,job),true);
 assert.equal(platformApplyLink({...apply,href:'https://evil.example/3743990016156496'},job),false,'unknown host');
 assert.equal(platformApplyLink({...apply,href:'https://jobs.smartrecruiters.com/LLNL/9999990016156496-other'},job),false,'another requisition');
 assert.equal(platformApplyLink({...apply,href:'http://jobs.smartrecruiters.com/LLNL/3743990016156496-x'},job),false,'plain http');
 assert.equal(platformApplyLink({...apply,label:'Employee portal',href:'https://www.smartrecruiters.com/app/employee-portal/3743990016156496'},job),false,'not an Apply label');
 assert.equal(platformApplyLink({...apply,href:'https://jobs.smartrecruiters.com/LLNL/13743990016156496'},job),false,'id must be a whole path token');
 assert.equal(platformApplyLink(apply,{...job,url:'https://www.llnl.gov/careers/all'}),false,'posting URL without an identifier');
});

test('the worker follows a verified platform Apply link in its own tab even when it targets a new window',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'platform-apply-'));
 let formLoads=0;
 const platform=createServer((req,res)=>{res.setHeader('Content-Type','text/html');
  if(req.url.startsWith('/LLNL/3743990016156496')){formLoads++;return res.end('<h1>Fixture platform form</h1><form><label>Name<input required name="name"></label><button type="submit">Submit</button></form>');}
  res.statusCode=404;res.end('missing');});
 await new Promise(r=>platform.listen(0,'127.0.0.1',r));
 const applyHref=`http://127.0.0.1:${platform.address().port}/LLNL/3743990016156496-mechanical-engineer-generalist?oga=true`;
 const posting=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<h1>Mechanical Engineer – Generalist</h1><a href="${applyHref}" target="_blank" class="btn btn-warning">Apply Now&nbsp;&nbsp;</a>`);});
 await new Promise(r=>posting.listen(0,'127.0.0.1',r));
 const run=join(dir,'run'),profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await mkdir(run);
 await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{...job,company:'Fixture LLNL',url:`http://127.0.0.1:${posting.address().port}/join-our-team/careers/find-your-job/all/all/3743990016156496`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,headlessOnly:true,maxSteps:4});
 const seen=[];
 const execImpl=async(_c,_a,prompt)=>{const page=JSON.parse(prompt).page;const controls=page.frames.flatMap(f=>f.controls);seen.push({url:page.url,text:page.frames[0].text});
  const entry=controls.find(c=>/^apply now/i.test(c.label.trim()));
  const action=entry&&seen.length===1?{action:'click',control:entry.id,fact:'',message:''}:{action:'human',control:'',fact:'',message:'Fixture finished'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.notEqual(state.status,'failed',state.message);
  assert.equal(formLoads,1,'the platform form was opened once');
  assert.equal(seen.length,2);assert.match(seen[1].text,/Fixture platform form/);
  assert.ok(state.events.some(e=>/^Opened: Apply Now/.test(e.message)),JSON.stringify(state.events));
 }finally{await new Promise(r=>posting.close(r));await new Promise(r=>platform.close(r));await rm(dir,{recursive:true,force:true});}
});

// Firefly 13348: the ClearCompany posting carries its id only as ?jobId=<uuid>, and APPLY opens
// firefly.clearcompany.com/careers/jobs/<uuid>/apply in a new tab (lesson 355).
const ffJob={id:13348,title:'Avionics Manufacturing Engineer I',url:'https://apply.clearcompany.com/firefly?noheader=False&source=JB-1014&jobId=9a840dc8-c26a-17cd-b8a9-babe24354de0'};
const ffApply={type:'a',label:'APPLY',href:'https://firefly.clearcompany.com/careers/jobs/9a840dc8-c26a-17cd-b8a9-babe24354de0/apply?source=JB-1014'};

test('a ClearCompany Apply link carrying the posting query id is the verified application URL',()=>{
 assert.equal(platformApplyLink(ffApply,ffJob),true);
 assert.equal(platformApplyLink({...ffApply,href:'https://firefly.clearcompany.com/careers/jobs/1111aaaa-c26a-17cd-b8a9-babe24354de0/apply'},ffJob),false,'another requisition');
 assert.equal(platformApplyLink({...ffApply,href:'https://firefly.clearcompany.evil.example/careers/jobs/9a840dc8-c26a-17cd-b8a9-babe24354de0/apply'},ffJob),false,'unknown host');
 assert.equal(platformApplyLink({...ffApply,href:'https://firefly.clearcompany.com/careers/jobs/x/apply?jobId=9a840dc8-c26a-17cd-b8a9-babe24354de0'},ffJob),false,'id must be in the path');
 assert.equal(platformApplyLink({...ffApply,href:'https://firefly.clearcompany.com/careers/JB-1014/apply'},ffJob),false,'short source codes do not count');
});

test('the worker follows a ClearCompany APPLY link whose posting id is a query value',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'platform-apply-cc-'));
 const uuid='9a840dc8-c26a-17cd-b8a9-babe24354de0';let formLoads=0;
 const platform=createServer((req,res)=>{res.setHeader('Content-Type','text/html');
  if(req.url.startsWith(`/careers/jobs/${uuid}/apply`)){formLoads++;return res.end('<h1>Fixture ClearCompany form</h1><form><label>Name<input required name="name"></label><button type="submit">Submit</button></form>');}
  res.statusCode=404;res.end('missing');});
 await new Promise(r=>platform.listen(0,'127.0.0.1',r));
 const applyHref=`http://127.0.0.1:${platform.address().port}/careers/jobs/${uuid}/apply?source=JB-1014`;
 const posting=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<h1>Avionics Manufacturing Engineer I</h1><a href="/firefly">Back to Job Openings</a><a href="${applyHref}" target="_blank">APPLY</a>`);});
 await new Promise(r=>posting.listen(0,'127.0.0.1',r));
 const run=join(dir,'run'),profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await mkdir(run);
 await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{...ffJob,company:'Fixture Firefly',url:`http://127.0.0.1:${posting.address().port}/firefly?noheader=False&source=JB-1014&jobId=${uuid}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,headlessOnly:true,maxSteps:4});
 const seen=[];
 const execImpl=async(_c,_a,prompt)=>{const page=JSON.parse(prompt).page;const controls=page.frames.flatMap(f=>f.controls);seen.push({url:page.url,text:page.frames[0].text});
  const entry=controls.find(c=>/^apply$/i.test(c.label.trim()));
  const action=entry&&seen.length===1?{action:'click',control:entry.id,fact:'',message:''}:{action:'human',control:'',fact:'',message:'Fixture finished'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.notEqual(state.status,'failed',state.message);
  assert.equal(formLoads,1,'the ClearCompany form was opened once');
  assert.match(seen[1]?.text??'',/Fixture ClearCompany form/);
 }finally{await new Promise(r=>posting.close(r));await new Promise(r=>platform.close(r));await rm(dir,{recursive:true,force:true});}
});

// Firefly 13348 as JobAgent stores it: firefly.hrmdirect.com/employment/view.php?req=3848064&location=<other uuid>
// redirects to apply.clearcompany.com/firefly?jobId=<uuid>; the saved URL never carries the id APPLY uses.
const ffStored={...ffJob,url:'https://firefly.hrmdirect.com/employment/view.php?req=3848064&jbsrc=1014&location=a0275739-3bad-ec7d-fca5-bb93cc39bd51'};
const ffPage='https://apply.clearcompany.com/firefly?noheader=False&source=JB-1014&jobId=9a840dc8-c26a-17cd-b8a9-babe24354de0';

test('the page a posting redirected to supplies the Apply link id when the saved URL lacks it',()=>{
 assert.equal(platformApplyLink(ffApply,ffStored),false,'the stored URL alone cannot verify it');
 assert.equal(platformApplyLink(ffApply,ffStored,{pageUrl:ffPage}),true);
 assert.equal(platformApplyLink({...ffApply,href:'https://firefly.clearcompany.com/careers/jobs/1111aaaa-c26a-17cd-b8a9-babe24354de0/apply'},ffStored,{pageUrl:ffPage}),false,'another requisition');
 assert.equal(platformApplyLink(ffApply,ffStored,{pageUrl:'https://unknown.example/firefly?jobId=9a840dc8-c26a-17cd-b8a9-babe24354de0'}),false,'a page off the posting site and off every platform lends no ids');
 assert.equal(platformApplyLink(ffApply,ffStored,{pageUrl:'not a url'}),false);
});

test('the worker follows APPLY after the stored posting URL redirected to its ClearCompany page',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'platform-apply-redirect-'));
 const uuid='9a840dc8-c26a-17cd-b8a9-babe24354de0';let formLoads=0;
 const platform=createServer((req,res)=>{res.setHeader('Content-Type','text/html');
  if(req.url.startsWith(`/careers/jobs/${uuid}/apply`)){formLoads++;return res.end('<h1>Fixture ClearCompany form</h1><form><label>Name<input required name="name"></label><button type="submit">Submit</button></form>');}
  res.statusCode=404;res.end('missing');});
 await new Promise(r=>platform.listen(0,'127.0.0.1',r));
 // The stored URL redirects to the posting page, whose APPLY leads off-site to the platform form.
 const posting=createServer((req,res)=>{res.setHeader('Content-Type','text/html');
  if(req.url.startsWith('/employment/view.php')){res.statusCode=302;res.setHeader('Location',`/firefly?noheader=False&source=JB-1014&jobId=${uuid}`);return res.end();}
  if(req.url.startsWith('/firefly?')&&req.url.includes(`jobId=${uuid}`))return res.end(`<h1>Avionics Manufacturing Engineer I</h1><a href="/firefly">Back to Job Openings</a><a href="http://127.0.0.1:${platform.address().port}/careers/jobs/${uuid}/apply?source=JB-1014" target="_blank">APPLY</a>`);
  res.statusCode=404;res.end('missing');});
 await new Promise(r=>posting.listen(0,'127.0.0.1',r));
 const run=join(dir,'run'),profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await mkdir(run);
 await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{...ffJob,company:'Fixture Firefly',url:`http://127.0.0.1:${posting.address().port}/employment/view.php?req=3848064&jbsrc=1014&location=a0275739-3bad-ec7d-fca5-bb93cc39bd51`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,headlessOnly:true,maxSteps:4});
 const seen=[];
 const execImpl=async(_c,_a,prompt)=>{const page=JSON.parse(prompt).page;const controls=page.frames.flatMap(f=>f.controls);seen.push({url:page.url,text:page.frames[0].text});
  const entry=controls.find(c=>/^apply$/i.test(c.label.trim()));
  const action=entry&&seen.length===1?{action:'click',control:entry.id,fact:'',message:''}:{action:'human',control:'',fact:'',message:'Fixture finished'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.notEqual(state.status,'failed',state.message);
  assert.equal(formLoads,1,'the ClearCompany form was opened once');
  assert.match(seen[1]?.text??'',/Fixture ClearCompany form/);
 }finally{await new Promise(r=>posting.close(r));await new Promise(r=>platform.close(r));await rm(dir,{recursive:true,force:true});}
});
