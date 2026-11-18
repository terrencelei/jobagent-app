import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {atomic,runWorker} from '../src/dashboard-worker.mjs';

// A posting link that opens a talent-network sign-up stops before anything is typed and is skipped
// with not_application, which JobAgent records as an ignored posting (not-application.mjs).
test('a talent-network sign-up is skipped as not an application, with no step model call', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'not-application-')),run=join(dir,'run');await mkdir(run);
 const server=createServer((req,res)=>{if(req.url==='/favicon.ico'){res.end();return;}res.setHeader('Content-Type','text/html');
  res.end('<h1>Join our Talent Community</h1><form><label>Email<input type="email" name="email"></label><button>Join</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:99001,company:'Fixture',url:`http://127.0.0.1:${server.address().port}/talent-community`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true});
 let calls=0;const execImpl=async()=>{calls++;return {code:1,stdout:'',stderr:'unexpected'};};
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'skipped');assert.equal(state.not_application,'talent_network');
  assert.match(state.message,/^Not an application: .*talent-network sign-up/);
  assert.equal(calls,0);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
