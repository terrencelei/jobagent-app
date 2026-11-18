import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import {learnApprovals,loadAnswers,loadBank,questionId,recordApprovals,lookup} from '../src/companies.mjs';
import {draftExamples,suggestedDraft} from '../src/answer-learning.mjs';
import {preferenceAnswer} from '../src/applicant-preferences.mjs';
import {resolveKnownQuestion,approvedValue,availableFacts} from '../src/dashboard-worker.mjs';
import {resolveQuestion,needsWorkdayAnswer} from '../src/workday.mjs';

test('confirmed citizenship questions with clearance notes use the relevant claim',()=>{
 const profile={answers:{citizenshipCountries:['United States'],workAuthorizationCountries:['United States']}};
 for(const label of ['Are you authorized to work in the United States? NOTE: If hired, proof of US persons and/or US citizenship will be required.','If your position requires a security clearance, are you able to provide proof of U.S. Citizenship? NOTE: If hired, proof of US citizenship will be required.']){
  assert.equal(resolveKnownQuestion({question:{label,options:['Select One','Yes','No']},profile}).value,'Yes');
  assert.equal(resolveQuestion(label,{}, {answers:profile.answers}).candidates[0],'Yes');
 }
 assert.equal(preferenceAnswer('Can you provide a U.S. passport?',profile.answers),null);
});

test('unselected placeholders are never learned, reused or treated as approval',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'answer-placeholder-'));
 try{
  await learnApprovals(dir,'Example',[{question:'Country',answer:'Select One'},{question:'Work authorization',answer:'Yes'}],'1');
  assert.equal((await loadAnswers(dir,'Example')).answers.country,undefined);
  assert.equal(lookup({country:{answer:'Select One'}},'Country'),undefined);
  assert.throws(()=>recordApprovals({company:'Example',answers:{}},[{question:'Country',answer:'Select One'}],'1'),/real answer/);
  const profile={answers:{country:'United States'}};
  assert.equal(resolveKnownQuestion({question:{label:'Country',options:['Select One','United States of America']},profile,bank:{country:{answer:'Select One'}}}).value,'United States of America');
  assert.equal(resolveQuestion('Country',{country:{answer:'Select One'}},{answers:profile.answers}).candidates[0],'United States');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('other citizenship is not inferred from U.S. citizenship and stale filled answers are corrected',()=>{
 const label='Do you hold citizenship(s) with country(ies) other than the US?';
 const profile={answers:{citizenshipCountries:['United States'],workAuthorizationCountries:['United States'],requiresSponsorship:false}};
 assert.equal(resolveKnownQuestion({question:{label,options:['Yes','No']},profile}).value,'No');
 assert.equal(resolveQuestion(label,{}, {answers:profile.answers}).candidates[0],'No');
 assert.equal(needsWorkdayAnswer({kind:'listbox',label,value:'Yes'},resolveQuestion(label,{}, {answers:profile.answers})),true);
 assert.equal(needsWorkdayAnswer({kind:'listbox',label,value:'No'},resolveQuestion(label,{}, {answers:profile.answers})),false);
 assert.equal(needsWorkdayAnswer({kind:'textarea',label:'Describe a project',value:'unapproved draft'},null),true);
 assert.equal(needsWorkdayAnswer({kind:'textarea',label:'Additional information',value:'existing optional text'},null),false);
 assert.equal(needsWorkdayAnswer({kind:'textarea',label:'Why this company?',value:'approved wording'}, {source:'approved',candidates:['approved wording']}),false);
 assert.equal(needsWorkdayAnswer({kind:'text',label:'Why this company?',value:'unapproved wording'},null),true);
 assert.equal(resolveKnownQuestion({question:{label,options:['Yes','No']},profile:{answers:{citizenshipCountries:['United States','Canada']}}}).value,'Yes');
 for(const q of ['Will you now or in the future require sponsorship for an immigration-related employment benefit?','If employment is offered, can you submit verification of your legal right to work at a Micron affiliated company in the country to which you have applied?']){
  const result=resolveKnownQuestion({question:{label:q,options:['Yes','No']},profile,job:{location:'Boise, ID - Main Site'}});
  assert.equal(result.value,q.startsWith('Will')?'No':'Yes');
 }
});

test('numbered consent, government certification and job-board options reuse confirmed facts',()=>{
 const profile={answers:{recruitmentEmailConsent:'Yes',recruitmentMessageConsent:'Yes',heardJobBoard:true,governmentEmployment:'No',armedForcesService:'No'}};
 for(const [label,options,want] of [
  ['10. Do you consent to being contacted by email about this or other opportunities?',['Select One','Yes I consent','No I do not consent'],'Yes I consent'],
  ['11. Do you consent to being contacted by text/SMS about this or other opportunities?',['Select One','Yes I consent','No I do not consent'],'Yes I consent'],
  ['How Did You Hear About Us?',['LinkedIn','Other'],'Other'],
  ['1. The Post-Government Employment Certification is designed to assess restrictions.',['Select One','I have never been employed by the U.S. government or the U.S. Armed Forces.','I am currently employed by the U.S. government'],'I have never been employed by the U.S. government or the U.S. Armed Forces.'],
 ])assert.equal(resolveKnownQuestion({question:{label,options},profile}).value,want,label);
 const incomplete={answers:{governmentEmployment:'No',veteranStatus:'I am not a protected veteran'}};
 assert.equal(resolveKnownQuestion({question:{label:'Post-Government Employment Certification',options:['I have never been employed by the U.S. government or the U.S. Armed Forces.','Other']},profile:incomplete}).resolved,false);
});

test('connection defaults require permission, keep employer exceptions and never infer government ties',()=>{
 const label='Do you know anyone who works here?';
 assert.equal(preferenceAnswer(label,{}),null);
 const answers={employerConnectionsDefault:'No'};
 assert.equal(preferenceAnswer(label,answers).value,'No');
 assert.equal(availableFacts({answers}).employerConnectionsDefault,'No');
 const bank={[questionId(label)]:{question:label,answer:'Yes'}};
 assert.equal(resolveKnownQuestion({question:{label,options:['Yes','No']},profile:{answers},bank}).value,'Yes');
 assert.equal(approvedValue({}, {label,type:'text'},{answers},bank,new Map()),'Yes');
 assert.equal(preferenceAnswer('Does a family member work at this company?',answers,{bank}),null);
 for(const q of ['Do your relatives work for government?','Describe your personal connections at this company','You have no connections at the company, correct?'])assert.equal(preferenceAnswer(q,answers),null,q);
});

test('connections stay employer-specific even when the question omits the company name',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'answer-scope-'));
 try{
  await learnApprovals(dir,'Example One',[{question:'Do you know anyone who works here?',answer:'Yes'}],'1');
  assert.equal((await loadAnswers(dir,'Example Two')).answers['do you know anyone who works here?'],undefined);
  assert.equal((await loadAnswers(dir,'Example One')).answers['do you know anyone who works here?'].answer,'Yes');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('edited approved prose seeds similar drafts without becoming cross-employer approval',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'answer-drafts-'));
 try{
  const question='Describe a challenging technical problem you encountered.';
  const old='I designed a test fixture and compared its measurements against the expected response. '.repeat(2);
  const edited='I redesigned the fixture, measured its response, and documented the resulting tolerance improvements. '.repeat(2);
  await learnApprovals(dir,'Example One',[{question,answer:old,type:'textarea'}],'1');
  await learnApprovals(dir,'Example One',[{question,answer:edited,type:'textarea'}],'2');
  const examples=await draftExamples(dir);
  assert.equal(suggestedDraft('Describe a difficult technical challenge and how you solved it.',examples,{company:'Example Two'}).draft,edited);
  assert.equal((await loadAnswers(dir,'Example Two')).answers[questionId(question)],undefined);
  assert.equal(suggestedDraft('Why do you want to work here?',examples,{company:'Example Two'}),null);
  assert.equal(suggestedDraft('Describe a difficult technical challenge.',examples,{company:'Example Two',maxWords:2}),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('concurrent approvals and older worker replays preserve the latest approved edit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'answer-edits-'));
 try{
  await Promise.all(['One','Two','Three'].map((name,i)=>learnApprovals(dir,name,[{question:'How did you hear about us?',answer:`Board ${i}`}],String(i))));
  for(const name of ['One','Two','Three'])assert.ok((await loadBank(dir,name)).answers['how did you hear about us?']);
  const bank={company:'Example',answers:{}};const question='Describe a technical challenge';
  recordApprovals(bank,[{question,answer:'new edit',approvedAt:'2026-10-15T20:00:00.000Z'}],'2');
  recordApprovals(bank,[{question,answer:'old text',approvedAt:'2026-10-14T20:00:00.000Z'}],'1');
  assert.equal(bank.answers[questionId(question)].answer,'new edit');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('grouped source checkboxes use actual options and confirmed source',()=>{
 const profile={answers:{hearAbout:'Careers site'}};
 const base={label:'How did you hear about us? *',type:'checkbox',choiceLabels:['Company Website','Referral / Friend']};
 assert.equal(approvedValue({}, {...base,optionLabel:'Company Website'},profile,{},new Map(),'Relativity'),true);
 assert.equal(approvedValue({}, {...base,optionLabel:'Referral / Friend'},profile,{},new Map(),'Relativity'),false);
 const bank={'how did you hear about us?':{answer:'Company Website'}};
 assert.equal(approvedValue({}, {...base,optionLabel:'Company Website'},profile,bank,new Map(),'Relativity'),true);
 assert.equal(approvedValue({}, {...base,optionLabel:'Referral / Friend'},profile,bank,new Map(),'Relativity'),false);
});

test('earned-degree questions keep in-progress degrees separate and pronouns use offered synonyms',()=>{
 const label="Have you earned a Bachelor's degree in one of the fields mentioned above, as listed in the Minimum Requirements section?";
 const profile={answers:{highestCompletedEducation:'High School Diploma',pronounsPlain:'he/him/his'}};
 assert.equal(resolveKnownQuestion({question:{label,options:['Yes','No']},profile}).value,'No');
 assert.equal(resolveKnownQuestion({question:{label:'Pronouns',options:['He/HIm','She/Her']},profile}).value,'He/HIm');
 assert.equal(resolveKnownQuestion({question:{label,options:['Yes','No']},profile:{answers:{highestCompletedEducation:"Bachelor's Degree"}}}).resolved,false);
});

test('a highest degree obtained or pursuing field is not answered with the completed education',()=>{
 const profile={answers:{highestCompletedEducation:'High School Diploma'}};
 assert.notEqual(resolveKnownQuestion({question:{label:'Highest Degree Obtained or Pursuing',options:['High School Diploma','Bachelor of Science']},profile}).value,'High School Diploma');
 assert.equal(resolveKnownQuestion({question:{label:'Highest level of education completed',options:['High School Diploma','Bachelor of Science']},profile}).value,'High School Diploma');
});


test('brief approved motivation edits stay employer-specific and remain draft suggestions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motivation-drafts-'));
 try{
  await learnApprovals(dir,'Apex',[{question:'Why Apex?',answer:'I want to bring my mechanical project experience to this role.',type:'text'}],'1');
  const edited='I am excited to contribute my robotics experience and learn through hands-on engineering.';
  await learnApprovals(dir,'Apex',[{question:'Why Apex?',answer:edited,type:'text'}],'2');
  const examples=await draftExamples(dir);
  assert.equal(suggestedDraft('Why do you want to work here?',examples,{company:'Apex'}).draft,edited);
  assert.equal(suggestedDraft('Why do you want to work here?',examples,{company:'Other Employer'}),null);
  assert.equal((await loadAnswers(dir,'Other Employer')).answers[questionId('Why Apex?')],undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('demographic answers never seed prose drafts',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'demo-drafts-'));
 try{
  await learnApprovals(dir,'_shared',[{question:'How would you describe your racial/ethnic background?',answer:'East Asian'}],'1');
  const examples=await draftExamples(dir);
  assert.equal(suggestedDraft('If you do not have a portfolio, please briefly describe any relevant projects that you have worked.',examples,{company:'Aerotech'}),null);
  assert.equal(examples.length,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
