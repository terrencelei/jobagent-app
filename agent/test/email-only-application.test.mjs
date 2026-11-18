import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

for(const mailto of [false,true])test(`email-only application parks without submission under auto-submit (mailto=${mailto})`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'email-application-'));
 let posts=0,decisions=0;
 const server=createServer((req,res)=>{
  if(req.method==='POST')posts++;
  res.setHeader('Content-Type','text/html');
  res.end(`<h1>Robotics Mechanical Engineer</h1><p>Apply by sending your resume, portfolio of robots you designed and built and links to a few onshape files to ${mailto?'<a href="mailto:careers@example.com">careers@example.com</a>':'careers at example dot com'}.</p>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const run=join(dir,'run'),profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
  await mkdir(run);await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant'}}));await writeFile(resume,'fixture');
  await atomic(join(run,'request.json'),{job:{id:mailto?998336:998335,company:'Fixture Robotics',title:'Robotics Mechanical Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:true,maxSteps:2});
  const execImpl=async(_command,_args,prompt)=>{
   decisions++;
   const page=JSON.parse(prompt).page;
   assert.match(JSON.stringify(page),/portfolio of robots/);
   assert.equal(page.frames.flatMap(f=>f.controls).some(c=>['submit','file','text','email'].includes(c.type)),false);
   return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'human',control:'',fact:'',message:'Email-only application requires a robot portfolio and Onshape links.'},usage:{}})};
  };
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'needs_human',state.message);
  assert.match(state.message,/robot portfolio and Onshape links/);
  assert.equal(state.submission_attempted,undefined);
  assert.notEqual(state.submitted,true);
  assert.equal(state.review,null);
  assert.equal(posts,0);assert.equal(decisions,1);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
