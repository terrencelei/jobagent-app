import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedValue,availableFacts} from '../src/dashboard-worker.mjs';
import {FORM_AGENT_INSTRUCTIONS} from '../src/application-decision-context.mjs';
import {currentEmployment,currentEmployerAnswer,currentEmployerCorrection,currentEmployerFacts,nonEmployers,sponsorAsEmployerProblems} from '../src/current-employer.mjs';

const profile={
 answers:{confirmedEmploymentCompanies:[{company:'Fixture Fab',current:false},{company:'Fixture Capital',current:true}]},
 workHistory:[{company:'Fixture Fab',title:'Project Intern',from:['6','2026'],to:['9','2026']},{company:'Fixture Capital',title:'Analyst Intern',from:['6','2023'],to:null}],
 projects:[{key:'capstone',sponsor:'Fixture Pharma (Device Group)',name:'Capstone'}],
};

test('the open work-history row is the current employer; a sponsor never is',()=>{
 assert.deepEqual(currentEmployment(profile),{index:1,company:'Fixture Capital',title:'Analyst Intern'});
 assert.deepEqual(currentEmployerFacts(profile),{currentEmployer:'Fixture Capital',currentJobTitle:'Analyst Intern'});
 assert.deepEqual(nonEmployers(profile),['Fixture Pharma']);
 const facts=availableFacts(profile);
 assert.equal(facts.currentEmployer,'Fixture Capital');assert.equal(facts.currentJobTitle,'Analyst Intern');
 // Two open rows, or a row his employment flags call finished, assert nothing.
 assert.equal(currentEmployment({...profile,workHistory:[...profile.workHistory,{company:'Other',title:'x',to:null}]}),null);
 assert.equal(currentEmployment({...profile,answers:{confirmedEmploymentCompanies:[{company:'Fixture Capital',current:false}]}}),null);
 assert.deepEqual(currentEmployerFacts({workHistory:[]}),{});
});

test('standalone current company and title questions resolve from the profile, not the résumé',()=>{
 for(const label of ['Current company','Current Company *','Current employer','Most recent employer','Present organization','Current or most recent company name'])
  assert.deepEqual(currentEmployerAnswer(label,profile),{key:'currentEmployer',value:'Fixture Capital'},label);
 for(const label of ['Current title','Current job title','Most recent position','Current role *'])
  assert.deepEqual(currentEmployerAnswer(label,profile),{key:'currentJobTitle',value:'Analyst Intern'},label);
 assert.equal(currentEmployerAnswer('Company',profile),undefined);
 assert.equal(currentEmployerAnswer('Referring employee company',profile),undefined);
 assert.equal(currentEmployerAnswer('Current company',{workHistory:[]}),null);
 const control={label:'Current company',type:'text',inForm:true,value:'Fixture Pharma'};
 assert.equal(approvedValue({fact:'currentEmployer'},control,profile,{},new Map()),'Fixture Capital');
 assert.equal(approvedValue({fact:'currentJobTitle'},{...control,label:'Current title'},profile,{},new Map()),'Analyst Intern');
 assert.throws(()=>approvedValue({fact:'currentEmployer'},control,{workHistory:[]},{},new Map()),/open work-history row/);
});

test('a résumé-parsed sponsor in Current company is corrected once, and a sponsor row blocks review',()=>{
 const snap={url:'https://jobs.example/apply',frames:[{controls:[
  {id:'c1',label:'Current company',type:'text',inForm:true,value:'Fixture Pharma'},
  {id:'c2',label:'Current title',type:'text',inForm:true,value:'Capstone Student'},
  {id:'c3',label:'Company',type:'text',inForm:true,value:'Fixture Pharma',historySection:'workHistory'},
 ]}]};
 const attempts=new Set();
 const first=currentEmployerCorrection(snap,profile,attempts);
 assert.deepEqual({id:first.control.id,fact:first.fact},{id:'c1',fact:'currentEmployer'});
 const second=currentEmployerCorrection(snap,profile,attempts);
 assert.deepEqual({id:second.control.id,fact:second.fact},{id:'c2',fact:'currentJobTitle'});
 assert.equal(currentEmployerCorrection(snap,profile,attempts),null);  // each value is tried once
 snap.frames[0].controls[0].value='Fixture Capital';snap.frames[0].controls[1].value='Analyst Intern';
 assert.equal(currentEmployerCorrection(snap,profile,new Set()),null);
 assert.deepEqual(sponsorAsEmployerProblems(snap.frames[0].controls,profile),['Company is "Fixture Pharma", a project sponsor rather than an employer']);
 assert.deepEqual(sponsorAsEmployerProblems([{label:'Company',type:'text',value:'Fixture Capital'}],profile),[]);
 assert.match(FORM_AGENT_INSTRUCTIONS,/project sponsor named on the résumé is never an employer/);
});
