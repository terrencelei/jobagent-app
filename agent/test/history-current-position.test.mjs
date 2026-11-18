import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {approvedValue,availableFacts,runWorker} from '../src/dashboard-worker.mjs';
import {confirmedCurrentPosition,historyCurrentFacts} from '../src/history-current-position.mjs';
const profile={answers:{confirmedEmploymentCompanies:[{company:'Fixture Alpha',current:false},{company:'Fixture Beta',current:true}]},workHistory:[{company:'Fixture Alpha',title:'Intern',to:['9','2026']},{company:'Fixture Beta',title:'Researcher',to:null}]};
const control={label:'Is current position? — Fixture Beta (Researcher)',historyQuestion:'Is current position?',historyCompany:'Fixture Beta',historyTitle:'Researcher',type:'select-one'};
test('row status uses explicit employer facts and cannot inherit a blanket approval or another row fact',()=>{
 assert.equal(approvedValue({fact:'workHistory.0.current'},control,profile,{'is current position?':{answer:'No'}},new Map([['is current position?','No']])),'Yes');
 assert.deepEqual(historyCurrentFacts(profile),{'workHistory.0.current':'No','workHistory.1.current':'Yes'});
 assert.equal(availableFacts(profile)['workHistory.1.current'],'Yes');
 assert.equal(confirmedCurrentPosition({...control,historyCompany:'Fixture Alpha',historyTitle:'Intern'},profile),'No');
 for(const changes of [{historyCompany:''},{historyCompany:'Unknown'},{historyTitle:'Different role'}])assert.throws(()=>confirmedCurrentPosition({...control,...changes},profile),/identified employment row/);
 assert.throws(()=>confirmedCurrentPosition({label:'Is current position?'},profile),/identified employment row/);
 assert.throws(()=>confirmedCurrentPosition(control,{...profile,answers:{}}),/explicit saved status/);
 assert.throws(()=>confirmedCurrentPosition(control,{...profile,workHistory:[...profile.workHistory,{company:'Fixture Beta',title:'Former role'}]}),/identified employment row/);
 assert.equal(confirmedCurrentPosition({label:'Is current study?'},profile),undefined);
});
for(const unknown of [false,true])test(`local worker scopes reordered current-position rows; unknown employer=${unknown}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-current-')),run=join(dir,'run'),stateRoot=join(dir,'state');await mkdir(run);await mkdir(stateRoot);
 let posts=0,decisions=0;
 const row=(company,title)=>`<div class="schema_field_MultipleDatasetEntryInput"><label>Company<input value="${company}"></label><label>Job Title<input value="${title}"></label><label for="${company.replaceAll(' ','-')}">Is current position?</label><select id="${company.replaceAll(' ','-')}" required><option value="">Select an option</option><option>Yes</option><option>No</option></select></div>`;
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(`<form method="post"><h2>Work experience</h2>${row('Fixture Beta','Researcher')}${row('Fixture Alpha','Intern')}${unknown?row('Unconfirmed Company','Intern'):''}<button type="submit">Submit application</button></form>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');await writeFile(profilePath,JSON.stringify(profile));await writeFile(resumePath,'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:999996,company:'Fixture',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath,resumePath,engine:'claude',parkQuestions:true,autoSubmit:unknown,maxSteps:5,approvedAnswers:[{question:'Is current position?',answer:'No'}]}));
 const execImpl=async(_cmd,_args,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);const stage=decisions++;
  let action;
  if(stage<2){const company=stage===0?'Fixture Beta':'Fixture Alpha';const field=controls.find(c=>c.historyCompany===company);assert.ok(field,'Employer context is required');assert.match(field.label,new RegExp(company));action={action:'fill',control:field.id,fact:'workHistory.0.current'};}
  else if(unknown&&stage===2){action={action:'fill',control:controls.find(c=>c.historyCompany==='Unconfirmed Company').id,fact:'workHistory.0.current'};}
  else{assert.equal(controls.find(c=>c.historyCompany==='Fixture Beta').value,'Yes');assert.equal(controls.find(c=>c.historyCompany==='Fixture Alpha').value,'No');action={action:'review',control:controls.find(c=>c.type==='submit').id};}
  return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{message:'',fact:'',...action},usage:{}})};
 };
 try{await runWorker(run,{execImpl,stateRoot,allowLocalFixture:true});const s=JSON.parse(await readFile(join(run,'state.json'),'utf8'));assert.equal(s.status,unknown?'needs_approval':'ready_to_submit',s.message);assert.equal(posts,0);assert.equal(decisions,unknown?4:3);if(unknown){assert.equal(s.questions.length,1);assert.match(s.questions[0].label,/Unconfirmed Company/);}}
 finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
