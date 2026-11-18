import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker} from '../src/dashboard-worker.mjs';
import {confirmedHistoryLocation} from '../src/history-controls.mjs';

const profile={answers:{},workHistory:[{company:'Fixture Manufacturing',location:'Fixture City, CA, USA'},{company:'Fixture Remote',location:'Remote'}]};
test('history countries require a unique matching employer and explicit country, never residential or blanket approval',()=>{
 const c={historyCountry:true,historyCompany:'Fixture Manufacturing',historySection:'workHistory'};
 assert.equal(confirmedHistoryLocation({fact:'workHistory.0.location'},c,profile),'United States');
 for(const fact of ['country','workHistory.1.location','workHistory.0.company'])assert.throws(()=>confirmedHistoryLocation({fact},c,profile),/matching unique/);
 assert.throws(()=>confirmedHistoryLocation({fact:'workHistory.1.location'},{...c,historyCompany:'Fixture Remote'},profile),/not explicit/);
 assert.throws(()=>confirmedHistoryLocation({fact:'workHistory.0.location'},c,{...profile,workHistory:[...profile.workHistory,profile.workHistory[0]]}),/unique/);
});
for(const mode of ['known','remote','unidentified'])test(`country selectors retain employer scope across row order and generic approvals: mode=${mode}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-country-')),run=join(dir,'run');await mkdir(run);let posts=0,reads=0;
 const remote=mode==='remote',unidentified=mode==='unidentified';
 const company=unidentified?'':remote?'Fixture Remote':'Fixture Manufacturing';
 const scope=company||'unidentified employer';
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(`<form method="post"><h2>Employment History</h2><div><label>Company Name<input value="${company}"></label><label for="country1">Job Location</label><select id="country1" required><option value="">No Selection</option><option>United States</option><option>Canada</option><option>Mexico</option></select></div><div><label>Company Name<input value="Another Employer"></label><label for="country2">Job Location</label><select id="country2"><option>United States</option><option>Canada</option></select></div><button type="submit">Submit application</button></form>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');await writeFile(profilePath,JSON.stringify(profile));await writeFile(resumePath,'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:99911911,company:'Fixture',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath,resumePath,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:4,approvedAnswers:[{question:'Job Location',answer:'United States'}]}));
 const execImpl=async(_cmd,_args,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);let action;
  if(reads++===0){
   const c=controls.find(c=>c.historyCountry&&c.historyCompany===company);assert.ok(c,'country must retain its company row');assert.equal(c.label,`Job Location (country) — ${scope}`);
   action={action:'fill',control:c.id,fact:remote?'workHistory.1.location':'workHistory.0.location'};
  }else action={action:'review',control:controls.find(c=>c.type==='submit').id};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const s=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(s.status,remote||unidentified?'needs_approval':'ready_to_submit',s.message);assert.equal(posts,0);
  if(remote||unidentified)assert.equal(s.questions[0].label,`Job Location (country) — ${scope}`);
  else assert.ok(s.review.answers.some(a=>a.label===`Job Location (country) — ${scope}`&&a.value==='United States'));
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
