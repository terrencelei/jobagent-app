import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
import {runWorker,SUBMIT_FIX_MODELS} from '../src/dashboard-worker.mjs';
const form=error=>`<form method="post"><label>First Name<input name="f" required></label><label>Phone<input name="p"${error?' aria-invalid="true"':''}></label>${error?'<span class="field-error">Phone is required</span>':''}<button type="submit">Submit application</button></form>`;
async function run(phoneFixable){
 const dir=await mkdtemp(join(tmpdir(),'submit-fix-')),runDir=join(dir,'run'),stateRoot=join(dir,'state');await mkdir(runDir);await mkdir(stateRoot);
 let posts=0;const models=[];
 const server=createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{res.setHeader('Content-Type','text/html');
  if(req.method!=='POST')return res.end(form(false));posts++;const p=new URLSearchParams(body).get('p');
  res.end(p&&phoneFixable?'<h1>Thank you for applying!</h1>':form(true));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{firstName:'Fixture',phone:'555-0100'}}));await writeFile(resumePath,'x');
 await writeFile(join(runDir,'request.json'),JSON.stringify({job:{id:999997,company:'Fixture',title:'Engineer',url},profilePath,resumePath,engine:'claude',model:'claude-opus-5-5',parkQuestions:true,autoSubmit:true}));
 const execImpl=async(_c,args,prompt)=>{const m=args[args.indexOf('--model')+1];models.push(m);
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const name=controls.find(c=>c.label==='First Name'&&!c.value);
  const afterError=prompt.includes('Submit was not accepted'),phone=afterError&&controls.find(c=>c.label==='Phone'&&!c.value);
  const submit=controls.find(c=>c.type==='submit');
  const action=name?{action:'fill',control:name.id,fact:'firstName'}:phone&&phoneFixable?{action:'fill',control:phone.id,fact:'phone'}:{action:'review',control:submit.id,fact:''};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{...action,message:''},usage:{}})};};
 try{await runWorker(runDir,{execImpl,stateRoot,allowLocalFixture:true});return {state:JSON.parse(await readFile(join(runDir,'state.json'),'utf8')),posts,models};}
 finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
}
test('field errors after Submit are fixed and resubmitted before anything goes to Help',async()=>{
 const ok=await run(true);
 assert.equal(ok.state.status,'completed',ok.state.message);assert.equal(ok.posts,2);
});
test('after Opus 5.5 and Fable 5.1 each retry once, the job goes to Help',async()=>{
 const fail=await run(false);
 assert.equal(fail.state.status,'needs_human',fail.state.message);
 assert.equal(fail.posts,1+SUBMIT_FIX_MODELS.length);
 assert.ok(fail.models.includes('claude-fable-5-1'),'Fable used for the last retry');
});
