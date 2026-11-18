import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {atomic,runWorker} from '../src/dashboard-worker.mjs';

test('acceptTerms aimed at a Proceed button just moves on (IBMid notice page, IBM 11946)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'terms-proceed-')),run=join(dir,'run');await mkdir(run);
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');
  res.end(req.url.startsWith('/next')?'<p>Application form</p><button>Done</button>':'<p>Please review our account notices.</p><form action="/next"><button type="submit">Proceed</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:983,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true});
 let reads=0,sawNext=false;
 const execImpl=async(_command,_args,prompt)=>{const page=JSON.parse(prompt).page,controls=page.frames[0].controls;reads++;
  const proceed=controls.find(c=>c.label==='Proceed');if(!proceed)sawNext=/Application form/.test(page.frames[0].text);
  const action=proceed?{action:'fill',control:proceed.id,fact:'acceptTerms',message:''}:{action:'human',control:'',fact:'',message:'Fixture finished'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.doesNotMatch(state.message??'',/Only a required terms checkbox/);assert.ok(sawNext,'Proceed was clicked');assert.equal(reads,2);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
