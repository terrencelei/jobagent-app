import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {atomic,runWorker} from '../src/dashboard-worker.mjs';

test('acceptTerms on a form attestation next to the form email box is answered, not a crash (Waymo 13548)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'attest-email-')),run=join(dir,'run');await mkdir(run);
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');
  res.end('<form><label>Email (required)<input type="email" name="email" required></label><label><input type="checkbox" name="certify" required> By submitting my application, I certify that the information provided is true and correct.</label><button type="button">Submit application</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:985,company:'Fixture',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true});
 let reads=0;
 const execImpl=async(_command,_args,prompt)=>{const controls=JSON.parse(prompt).page.frames[0].controls;reads++;
  const box=controls.find(c=>/I certify/.test(c.label));
  const action=reads===1&&box?{action:'fill',control:box.id,fact:'acceptTerms',message:''}:{action:'human',control:'',fact:'',message:'Fixture finished'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.doesNotMatch(state.message??'',/Only a required terms checkbox/);assert.notEqual(state.status,'failed');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
