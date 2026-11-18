import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,mkdir,writeFile,readFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{createServer}from'node:http';
import{runWorker,atomic}from'../src/dashboard-worker.mjs';
test('the authorized original resume uploads before a step agent can skip straight to review',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'resume-before-review-')),run=join(dir,'run');await mkdir(run);
 let posts=0,submittedGoleta=false;const server=createServer((req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.method==='POST'){posts++;let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{submittedGoleta=body.includes('Goleta, California, United States');res.end('<h1>Your application has been received</h1>');});return;}
  res.end('<form method="post" enctype="multipart/form-data"><label>Resume/CV<input name="resume" type="file"></label><label>Current location<input name="location" value="Springfield, CA, USA"></label><button type="submit">Submit Application</button></form>');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const profilePath=join(dir,'profile.json'),resumePath=join(dir,'original-resume.pdf');
  await writeFile(profilePath,JSON.stringify({answers:{applicationLocationRule:{defaultRegion:'bayArea',bayArea:{city:'Springfield'},southernCalifornia:{city:'Goleta'}}}}));await writeFile(resumePath,'fixture original resume');
  await atomic(join(run,'request.json'),{job:{id:123,company:'Fixture',title:'Engineer',location:'Irvine, CA',url:`http://127.0.0.1:${server.address().port}/apply`},profilePath,resumePath,engine:'claude',autoSubmit:true,parkQuestions:true,maxSteps:4});
  let decisions=0;
  await runWorker(run,{stateRoot:join(dir,'state'),allowLocalFixture:true,execImpl:async(_command,_args,prompt)=>{
   decisions++;const snapshot=JSON.parse(prompt).page,control=snapshot.frames.flatMap(f=>f.controls).find(c=>/Submit Application/.test(c.label));
   return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'review',control:control.id,fact:'',message:''},usage:{}})};
  }});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'completed',state.message);assert.equal(posts,1);assert.equal(decisions,1);assert.equal(submittedGoleta,true);
  assert.ok(state.events.some(e=>e.message==='Uploaded original resume'));
 }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
