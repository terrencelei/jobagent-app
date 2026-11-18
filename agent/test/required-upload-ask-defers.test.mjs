import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
import {runWorker} from '../src/dashboard-worker.mjs';
import {requiredUploadGap} from '../src/form-validation.mjs';
// Varda 8097 (Greenhouse): the step agent kept asking about / uploading to the required "Cover Letter*"
// upload with no approved document. Every try was rejected until the rejection cap failed the run
// ("The page changed or a control could not be identified"). It must be flagged for approval once instead.
const form=`<form method="post"><label>First Name<input name="f" required></label><div class="file-upload" role="group" aria-labelledby="cl-label"><div id="cl-label">Cover Letter<span>*</span></div><label>Attach<input id="cover_letter" type="file"></label></div><button type="button">Enter manually</button><button type="submit">Submit application</button></form>`;
for(const tried of ['ask','upload'])test(`a step agent that keeps choosing ${tried} on a required upload with no document parks it for approval`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'upload-ask-')),runDir=join(dir,'run'),stateRoot=join(dir,'state');await mkdir(runDir);await mkdir(stateRoot);
 let posts=0;const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.method==='POST'){posts++;return res.end('<h1>Thank you for applying!</h1>');}res.end(form);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{firstName:'Fixture'},documents:{}}));await writeFile(resumePath,'x');
 await writeFile(join(runDir,'request.json'),JSON.stringify({job:{id:999995,company:'Fixture',title:'Engineer',url},profilePath,resumePath,engine:'claude',model:'claude-opus-5-5',parkQuestions:true,autoSubmit:true}));
 const execImpl=async(_c,_a,prompt)=>{const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const name=controls.find(c=>c.label==='First Name'&&!c.value),cover=controls.find(c=>c.type==='file'&&/cover/i.test(c.label)),submit=controls.find(c=>c.type==='submit');
  const action=name?{action:'fill',control:name.id,fact:'firstName'}:cover?{action:tried,control:cover.id,fact:''}:{action:'review',control:submit.id,fact:''};
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
test('requiredUploadGap covers an empty required non-resume upload only',()=>{
 assert.equal(requiredUploadGap({type:'file',label:'Cover Letter* (Attach)',required:true}),true);
 assert.equal(requiredUploadGap({type:'file',label:'Cover Letter* (Attach)',required:true,attached:true}),false);
 assert.equal(requiredUploadGap({type:'file',label:'Resume/CV*',required:true}),false);
 assert.equal(requiredUploadGap({type:'button',label:'Enter manually',required:true}),false);
});
