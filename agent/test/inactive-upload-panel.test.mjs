import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {snapshot,runWorker,atomic} from '../src/dashboard-worker.mjs';

test('inactive upload panels stay out of snapshots while styled upload inputs remain available',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({body:'<html></html>'}));
  await page.goto('http://localhost/');
  for(const attributes of ['hidden','style="display:none"','style="visibility:hidden"','aria-hidden="true"','inert']){
   await page.setContent(`<form><section ${attributes}><label>Resume<input type="file" id="inactive"></label></section><section><label>Resume<input type="file" style="display:none" id="active"></label></section></form>`);
   const files=(await snapshot(page)).frames.flatMap(f=>f.controls).filter(c=>c.type==='file');
   assert.deepEqual(files.map(c=>c.domId),['active'],attributes);
  }
 }finally{await browser.close();}
});

test('a hidden completed resume step does not trigger an upload while preparing current questions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'inactive-upload-')),run=join(dir,'run');await mkdir(run);
 let uploads=0,posts=0,decisions=0;
 const server=createServer((req,res)=>{
  if(req.method==='POST')posts++;
  if(req.url==='/upload'){uploads++;res.end('ok');return;}
  res.setHeader('Content-Type','text/html');
  res.end('<form><section hidden><h2>Resume</h2><label>Resume<input type="file" onchange="this.value=\'\';fetch(\'/upload\')"></label></section><section><h2>Job-specific questions</h2><label>Full legal name<input name="name" required></label><button type="submit">Submit Application</button></section></form>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
  await writeFile(profilePath,JSON.stringify({answers:{fullName:'Fixture Applicant'}}));await writeFile(resumePath,'fixture resume');
  await atomic(join(run,'request.json'),{job:{id:9911844,company:'Fixture',title:'Engineer',url:`http://127.0.0.1:${server.address().port}/apply`},profilePath,resumePath,engine:'claude',parkQuestions:true,maxSteps:4});
  await runWorker(run,{stateRoot:join(dir,'state'),allowLocalFixture:true,execImpl:async(_command,_args,prompt)=>{
   decisions++;const fields=JSON.parse(prompt).page.frames.flatMap(f=>f.controls),name=fields.find(c=>c.name==='name');
   const action=name.value?{action:'review',control:fields.find(c=>c.type==='submit').id}:{action:'fill',control:name.id,fact:'fullName'};
   return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{message:'',fact:'',...action},usage:{}})};
  }});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);
  assert.equal(decisions,2);assert.equal(uploads,0);assert.equal(posts,0);
  assert.equal(Boolean(state.submission_attempted),false);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
