import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {safeRoleLink,runWorker,atomic} from '../src/dashboard-worker.mjs';

// Campbell Scientific 12670: the posting page embeds a Paycor frame whose job list sits inside a form.
// The exact-title link carries the posting's gni id; the guard refused it as in-form and off-host.
const id='8a78859fa0f425c801a0feca9b1a4505';
const job={id:12670,title:'Mechanical Design Engineer',url:`https://www.campbellsci.com/open-positions?gnk=job&gni=${id}&gns=Indeed+Free`};
const link={type:'a',label:'Mechanical Design Engineer',inForm:true,href:`https://recruitingbypaycor.com/career/JobIntroduction.action?clientId=8a7883c6&id=${id}&source=Indeed+Free`};

test('an exact-title hiring-platform link carrying the posting id is the posting itself',()=>{
 assert.equal(safeRoleLink(link,job),true);
 assert.equal(safeRoleLink({...link,href:'https://recruitingbypaycor.com/career/JobIntroduction.action?id=8a78859fa0f425c801a0feca9b1a9999'},job),false,'another requisition');
 assert.equal(safeRoleLink({...link,href:`https://evil.example/JobIntroduction.action?id=${id}`},job),false,'unknown host');
 assert.equal(safeRoleLink({...link,href:`http://recruitingbypaycor.com/career/JobIntroduction.action?id=${id}`},job),false,'plain http');
 assert.equal(safeRoleLink({...link,label:'Another role'},job),false,'not the exact title');
 assert.equal(safeRoleLink(link,{...job,url:'https://www.campbellsci.com/open-positions'}),false,'posting URL without an id');
 assert.equal(safeRoleLink({...link,href:'https://www.campbellsci.com/careers/x'},job),false,'same-host link inside a form still refused');
});

test('the worker opens the Paycor frame role link in its own tab',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paycor-frame-'));
 let introLoads=0;
 const paycor=createServer((req,res)=>{res.setHeader('Content-Type','text/html');
  if(req.url.startsWith('/career/JobIntroduction.action')){introLoads++;return res.end('<h1>Fixture Paycor job introduction</h1><a href="/apply">Apply</a>');}
  if(req.url.startsWith('/career/CareerHome.action'))return res.end(`<form name="careerForm"><h2>Current Career Opportunities</h2><a href="/career/JobIntroduction.action?clientId=8a7883c6&id=${id}">Mechanical Design Engineer</a></form>`);
  res.statusCode=404;res.end('missing');});
 await new Promise(r=>paycor.listen(0,'127.0.0.1',r));
 const frameSrc=`http://127.0.0.1:${paycor.address().port}/career/CareerHome.action?clientId=8a7883c6`;
 const posting=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<h1>Open Positions</h1><iframe src="${frameSrc}" width="900" height="500"></iframe>`);});
 await new Promise(r=>posting.listen(0,'127.0.0.1',r));
 const run=join(dir,'run'),profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await mkdir(run);
 await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{...job,company:'Fixture Springfield',url:`http://127.0.0.1:${posting.address().port}/open-positions?gnk=job&gni=${id}&gns=Indeed+Free`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,headlessOnly:true,maxSteps:4});
 const seen=[];
 const execImpl=async(_c,_a,prompt)=>{const page=JSON.parse(prompt).page;const controls=page.frames.flatMap(f=>f.controls);seen.push({url:page.url,text:page.frames.map(f=>f.text).join('\n')});
  const entry=controls.find(c=>c.label.trim()==='Mechanical Design Engineer');
  const action=entry&&seen.length===1?{action:'click',control:entry.id,fact:'',message:''}:{action:'human',control:'',fact:'',message:'Fixture finished'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.ok(!state.events.some(e=>/not a Next, Continue/.test(e.message)),JSON.stringify(state.events));
  assert.equal(introLoads,1,'the Paycor job introduction was opened once');
  assert.equal(seen.length,2);assert.match(seen[1].text,/Fixture Paycor job introduction/);
 }finally{await new Promise(r=>posting.close(r));await new Promise(r=>paycor.close(r));await rm(dir,{recursive:true,force:true});}
});
