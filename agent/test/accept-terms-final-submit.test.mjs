import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {atomic,runWorker} from '../src/dashboard-worker.mjs';

test('acceptTerms aimed at the final submit button is refused, not a crash (Waymo 13548)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'terms-submit-')),run=join(dir,'run');await mkdir(run);
 let posted=false;
 const server=createServer((req,res)=>{if(req.method==='POST')posted=true;res.setHeader('Content-Type','text/html');
  res.end('<form method="post" action="/done"><label>First name<input name="first"></label><button type="submit">Submit your application</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:984,company:'Fixture',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true});
 let reads=0,sawRefusal=false;
 const execImpl=async(_command,_args,prompt)=>{const input=JSON.parse(prompt),controls=input.page.frames[0].controls;reads++;
  if(JSON.stringify(input).includes('is the final submit control'))sawRefusal=true;
  const submit=controls.find(c=>/Submit your application/.test(c.label));
  const action=reads===1&&submit?{action:'fill',control:submit.id,fact:'acceptTerms',message:''}:{action:'human',control:'',fact:'',message:'Fixture finished'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.doesNotMatch(state.message??'',/Only a required terms checkbox/);assert.notEqual(state.status,'failed');
  assert.ok(sawRefusal,'the refusal reached the next step');assert.equal(posted,false,'nothing was submitted');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
