import test from 'node:test';import assert from 'node:assert/strict';
import {preferenceAnswer} from '../src/applicant-preferences.mjs';
import {approvedValue} from '../src/dashboard-worker.mjs';
import {resolveQuestion} from '../src/workday.mjs';
import {questionId} from '../src/companies.mjs';
import {routineApplicationAnswer,routineQuestionNeedsReview} from '../src/routine-application-policy.mjs';
import {shouldApproveOptionalWriting} from '../src/application-writing-policy.mjs';
const answers={routineSourceChoiceAllowed:true,employerEmploymentDefault:'No',confirmedEmploymentCompanies:[{company:'Prior Employer',current:false},{company:'Current Employer',current:true}]};
test('routine sources choose offered authorized defaults without inventing named referrals',()=>{
 const q='How did you hear about this opportunity?';
 for(const [options,want] of [[['LinkedIn','Employee Referral'],'LinkedIn'],[['Company Website','Other'],'Company Website'],[['Job Search Website','Other'],'Job Search Website'],[['Other','Recruiter'],'Other'],[['Named Employee Referral'],undefined]])assert.equal(preferenceAnswer(q,answers,{company:'Fixture',options})?.value,want);
 assert.equal(preferenceAnswer(q,answers,{source:'LinkedIn',options:['LinkedIn','Company Website']}).value,'LinkedIn');
 assert.equal(preferenceAnswer(q,{}, {options:['LinkedIn']}),null);
 assert.equal(preferenceAnswer('Name the employee who referred you',answers),null);
});
test('source saved approved offered generic wins and stale referral is replaced',()=>{
 const q='How did you hear about us?';const options=['LinkedIn','Company Website'];
 assert.equal(preferenceAnswer(q,answers,{options,bank:{x:{question:q,answer:'LinkedIn'}}}).value,'LinkedIn');
 const bank={[questionId(q)]:{question:q,answer:'Employee Referral'}};
 assert.equal(approvedValue({}, {label:q,type:'select-one',choiceLabels:options},{answers},bank,new Map()),'Company Website');
 assert.equal(resolveQuestion(q,bank,{answers,options}).candidates[0],'Company Website');
});
test('self and family employer history defaults span both resolvers with explicit exceptions',()=>{
 for(const q of ['Have you previously worked for us?','Are you currently employed by this company?','Does a family member work for us?','Have you been or are you at the moment working for Fixture as a third party contractor?']){
  assert.equal(preferenceAnswer(q,answers,{company:'Fixture'})?.value,'No',q);
  assert.equal(resolveQuestion(q,{}, {answers,company:'Fixture'}).candidates[0],'No');
  assert.equal(approvedValue({}, {label:q,type:'text'},{answers},{},new Map(),'Fixture',{company:'Fixture'}),'No');
 }
 assert.equal(preferenceAnswer('Have you ever worked for us?',answers,{company:'Prior Employer'}).value,'Yes');
 assert.equal(preferenceAnswer('Are you currently employed by us?',answers,{company:'Prior Employer'}).value,'No');
 assert.equal(preferenceAnswer('Are you currently employed by us?',answers,{company:'Current Employer'}).value,'Yes');
 assert.equal(preferenceAnswer('Have you worked for us as a third party contractor?',answers,{company:'Prior Employer'}).value,'No');
 assert.equal(preferenceAnswer('Does your family work for us?',answers,{company:'Fixture',bank:{x:{question:'Does your family work for us?',answer:'Yes'}}}).value,'No');
 assert.equal(preferenceAnswer('Does your family work for us?',{...answers,employerEmploymentExceptions:[{company:'Fixture',family:true}]},{company:'Fixture'}).value,'Yes');
 assert.equal(preferenceAnswer('Are you related to anyone employed by us?',answers,{company:'Prior Employer'}).value,'No');
 assert.equal(preferenceAnswer('Have you or your family worked for us?',answers,{company:'Prior Employer'}).value,'Yes');
});
test('policies do not settle unrelated facts or remove substantive writing review',()=>{
 for(const q of ['Are you currently employed?','Have you worked for the government?','Have you ever been terminated?','Describe your experience working for us','Have you never worked for us?'])assert.equal(preferenceAnswer(q,answers,{company:'Fixture'}),null,q);
 assert.equal(shouldApproveOptionalWriting({label:'Describe a complex project you completed',type:'textarea'}),true);
});
test('routine source permission covers alternate wording and named job search websites',()=>{
 for(const label of ['How did you find this position?','How did you find this job?','Where did you first learn about this role?','How did you first hear about us?']){
  for(const option of ['Indeed','Glassdoor','Handshake','ZipRecruiter','Job Search Site','Employer Career Site'])assert.equal(preferenceAnswer(label,answers,{options:[option]})?.value,option,`${label}: ${option}`);
 }
 assert.equal(preferenceAnswer('How did you find this job?',answers,{options:['Employee Referral','LinkedIn']}).value,'LinkedIn');
 assert.equal(preferenceAnswer('How did you find this job?',answers,{source:'Indeed',options:['Company Website','Indeed']}).value,'Indeed');
 for(const option of ['Referral LinkedIn','LinkedIn Employee Referral','Career Fair','Named Recruiter','Friend'])assert.equal(preferenceAnswer('How did you find this job?',answers,{options:[option]}),null,option);
});
test('routine permissions cannot answer prose, future work or combined motivation',()=>{
 for(const label of [
  'Tell us about a project you worked on with our team',
  'Share your experience working for our company',
  'Discuss a challenge you faced while employed by us',
  'Are you willing to work for our company onsite?',
  'Are you able to work for us full time?',
  'Do you have the skills to work for our company?',
  'Do you have experience currently working for our company in a manufacturing role?',
  'Are you willing to become a current employee of our company?',
  'Have you worked on a project for our team?',
  'When have you worked for our company?',
  'Have you worked for us? If yes, please provide dates.',
  'How did you hear about us and why do you want to work here?',
  'Where did you first learn about us and what interests you about this role?',
 ]){
  assert.equal(preferenceAnswer(label,answers,{company:'Fixture'}),null,label);
  assert.equal(resolveQuestion(label,{}, {answers,company:'Fixture'}),null,label);
  assert.throws(()=>approvedValue({}, {label,type:'textarea'}, {answers},{},new Map(),'Fixture',{company:'Fixture'}),/needs|wording|answer/i,label);
 }
 for(const label of ['Have you ever worked here?','Are you or your relatives employed by us?','Have you previously been a contractor for us?'])assert.equal(preferenceAnswer(label,answers,{company:'Fixture'})?.value,'No',label);
});
test('compound source prose accepts only the full question approval and keeps known jurisdiction facts',()=>{
 const label='How did you hear about us and why do you want to work here?';
 const bank={'intent:how-heard':{question:'How did you hear about us?',answer:'LinkedIn'}};
 assert.equal(resolveQuestion(label,bank,{answers:{...answers,hearAbout:'Company Website'},options:['LinkedIn']}),null);
 const prose='I found the role on LinkedIn. The team’s engineering work interests me.';
 assert.equal(resolveQuestion(label,{...bank,[questionId(label)]:{question:label,answer:prose}},{answers}).candidates[0],prose);
 assert.equal(resolveQuestion(label,bank,{answers,approvedAnswers:[{question:label,answer:prose}]}).candidates[0],prose);
 assert.equal(preferenceAnswer('Are you authorized to work in the country where this role is located?',{workAuthorizationCountries:['United States']},{location:'California, United States'}).value,'Yes');
});

test("Oracle's 'come to know about this opportunity' wording is a routine source choice (Vertiv 7922)",()=>{
 const bank={'intent:how-heard':{question:'How did you hear about us?*',answer:'Other',approvedAt:'2026-10-18T18:24:32.660Z'}};
 const r=routineApplicationAnswer('How did you come to know about this opportunity?',{routineSourceChoiceAllowed:true,hearAbout:'Careers site'},{company:'Vertiv',options:['Employee Referral','Career Site','LinkedIn/Job Portal','Recruitment Agency','Other'],bank});
 assert.equal(r?.value,'Other');assert.equal(r?.authoritative,true);
});
test('Workday board prefixes and parent-brand career sites count as routine sources (RTX 12597)',()=>{
 const q='How Did You Hear About Us?';
 const rtx=['Select One','Current Contractor','Employee Referral','Event - Other','Job Board - Clearance Jobs','Job Board - Indeed','Job Board - LinkedIn','Job Board - Other','Job Board - University Career Center','Recruiter Outreach','RTX Corporate Career Site','Social Media - Handshake'];
 assert.equal(preferenceAnswer(q,answers,{company:'Raytheon',options:rtx}).value,'RTX Corporate Career Site');
 assert.equal(preferenceAnswer(q,answers,{company:'Raytheon',options:rtx,source:'LinkedIn'}).value,'Job Board - LinkedIn');
 const boards=rtx.filter(o=>o!=='RTX Corporate Career Site');
 assert.equal(preferenceAnswer(q,answers,{company:'Raytheon',options:boards}).value,'Job Board - LinkedIn');
 assert.equal(preferenceAnswer(q,answers,{company:'Raytheon',options:['Employee Referral','Job Board - University Career Center','Recruiter Outreach']}),null);
});

test('"Tell us how you heard about X" select is a routine source question (Zipline 12921)',()=>{
 const o=['Google Search','Word of Mouth or Referrals','LinkedIn','Glassdoor','Indeed','Other Job Board','Other'];
 const r=routineApplicationAnswer('Tell us how you heard about Zipline and this job!*',{routineSourceChoiceAllowed:true},{options:o,company:'Zipline'});
 assert.equal(r?.value,'LinkedIn');
 assert.equal(routineQuestionNeedsReview('Tell us how you heard about Zipline and this job!*'),false);
 assert.equal(routineQuestionNeedsReview('Tell us how you heard about us and why you are interested'),true);
});
