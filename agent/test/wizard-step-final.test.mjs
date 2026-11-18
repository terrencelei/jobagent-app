import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {atomic,runWorker} from '../src/dashboard-worker.mjs';

test('a Submit-like button on a named middle wizard step is never the final submit (Cisco 12281)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wizard-step-')),run=join(dir,'run');await mkdir(run);
 let submits=0;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url.startsWith('/done'))submits++;
  res.end('<p>My experience</p><form action="/done"><button type="submit">Submit</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 const url=`http://127.0.0.1:${server.address().port}/apply?step=2&stepname=workAndEducation`;
 await atomic(join(run,'request.json'),{job:{id:984,company:'Fixture',url},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:true});
 let reads=0;
 const execImpl=async(_c,_a,prompt)=>{const controls=JSON.parse(prompt).page.frames[0].controls;reads++;
  const submit=controls.find(c=>c.label==='Submit');
  const action=reads===1&&submit?{action:'review',control:submit.id,fact:'',message:''}:{action:'human',control:'',fact:'',message:'Fixture finished'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(submits,0);assert.notEqual(state.status,'submitted_pending_receipt');
  assert.ok(state.events.some(e=>/multi-step application/.test(e.message)),'the step was sent back with the reason');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
