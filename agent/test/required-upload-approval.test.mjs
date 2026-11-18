import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
import {runWorker} from '../src/dashboard-worker.mjs';
// Varda 9948 (Greenhouse): with no cover-letter document in the profile, the required "Cover Letter*"
// upload stays empty. The run must flag it for his approval and move on, not fail or submit.
const form=`<form method="post"><label>First Name<input name="f" required></label><div class="file-upload" role="group" aria-labelledby="cl-label"><div id="cl-label">Cover Letter<span>*</span></div><label>Attach<input id="cover_letter" type="file"></label></div><button type="submit">Submit application</button></form>`;
test('a required upload with no approved document is parked for approval, not failed or submitted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'upload-approval-')),runDir=join(dir,'run'),stateRoot=join(dir,'state');await mkdir(runDir);await mkdir(stateRoot);
 let posts=0;const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.method==='POST'){posts++;return res.end('<h1>Thank you for applying!</h1>');}res.end(form);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{firstName:'Fixture'},documents:{}}));await writeFile(resumePath,'x');
 await writeFile(join(runDir,'request.json'),JSON.stringify({job:{id:999996,company:'Fixture',title:'Engineer',url},profilePath,resumePath,engine:'claude',model:'claude-opus-5-5',parkQuestions:true,autoSubmit:true}));
 const execImpl=async(_c,_a,prompt)=>{const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const name=controls.find(c=>c.label==='First Name'&&!c.value),submit=controls.find(c=>c.type==='submit');
  const action=name?{action:'fill',control:name.id,fact:'firstName'}:{action:'review',control:submit.id,fact:''};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{...action,message:''},usage:{}})};};
 try{
  await runWorker(runDir,{execImpl,stateRoot,allowLocalFixture:true});
  const state=JSON.parse(await readFile(join(runDir,'state.json'),'utf8'));
  assert.equal(state.status,'needs_approval',state.message);
  assert.equal(posts,0,'nothing was submitted');
  assert.deepEqual(state.questions.map(q=>[q.label,q.required,q.type]),[['Cover Letter* (Attach)',true,'textarea']]);
  assert.match(state.questions[0].approvalReason,/Required upload with no approved document/);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
