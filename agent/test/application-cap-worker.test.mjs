import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

test('a reconciled rejected attempt reaches local browser review without submitting or erasing history', async () => {
  const dir=await mkdtemp(join(tmpdir(),'cap-reconciliation-'));
  const run=join(dir,'run'), stateRoot=join(dir,'state');
  await mkdir(run);await mkdir(stateRoot);
  let submits=0,decisions=0;
  const server=createServer((req,res)=>{
    if(req.method==='POST')submits++;
    res.setHeader('Content-Type','text/html');
    res.end('<form method="post"><label>Name<input value="Fixture Applicant" required></label><button type="submit">Submit application</button></form>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
  const history={company:'Fixture',canonicalUrl:url,status:'verification_not_accepted',submittedAt:new Date().toISOString(),reconciliationEvidence:{resolution:'not_accepted'}};
  const historyPath=join(stateRoot,'jobagent-1309.json');
  await writeFile(profilePath,JSON.stringify({answers:{}}));await writeFile(resumePath,'fixture');
  await atomic(historyPath,history);
  await atomic(join(run,'request.json'),{job:{id:1309,company:'Fixture',title:'Engineer',url},profilePath,resumePath,engine:'claude',parkQuestions:true,autoSubmit:false,applicationCaps:{Fixture:{max:1,days:90}}});
  const execImpl=async(_command,_args,prompt)=>{
    decisions++;
    const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
    const control=controls.find(c=>c.type==='submit');
    return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'review',control:control.id,fact:'',message:''},usage:{}})};
  };
  try {
    await runWorker(run,{execImpl,stateRoot,allowLocalFixture:true});
    const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
    assert.equal(state.status,'ready_to_submit',state.message);
    assert.equal(decisions,1);assert.equal(submits,0);
    assert.deepEqual(JSON.parse(await readFile(historyPath,'utf8')),history);
  } finally {
    await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});
  }
});
