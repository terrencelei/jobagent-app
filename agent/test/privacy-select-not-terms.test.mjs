import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {atomic,runWorker} from '../src/dashboard-worker.mjs';

test('acceptTerms aimed at a required Privacy Policy dropdown in the form is an ordinary question (Ludo Robotics 16831)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'privacy-select-')),run=join(dir,'run');await mkdir(run);
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');
  res.end('<form><label for="p">[Privacy Policy]*</label><select id="p" required><option value="">Select</option><option>I acknowledge</option></select><input type="text" aria-label="Name"><button type="button">Next</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:984,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true});
 let reads=0;
 const execImpl=async(_c,_a,prompt)=>{const controls=JSON.parse(prompt).page.frames[0].controls;reads++;
  const sel=controls.find(c=>/Privacy Policy/.test(c.label));
  const action=reads===1&&sel?{action:'fill',control:sel.id,fact:'acceptTerms',message:''}:{action:'human',control:'',fact:'',message:'Fixture finished'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.doesNotMatch(state.message??'',/Only a required terms checkbox/);assert.ok(reads>=2);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
