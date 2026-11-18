import test from 'node:test';import assert from 'node:assert/strict';
import {profileFact} from '../src/profile-facts.mjs';import {resolveQuestion} from '../src/workday.mjs';import {resolveKnownQuestion,approvedValue} from '../src/dashboard-worker.mjs';import {questionId} from '../src/companies.mjs';
const answers={highestCompletedEducation:'High School Diploma',degree:"Bachelor's Degree",graduationDate:'06/15/2027',earliestStartDate:'2027-06-16',internshipAvailabilityStart:'2027-06-15'};
test('obtained education reuses corrected completed level despite a stale approved Bachelor answer',()=>{
 const label='What is the highest level of education you’ve obtained?',options=['GED or Equivalent','High School','Some College','College - Bachelor of Science'];const bank={[questionId(label)]:{question:label,answer:'College - Bachelor of Science'}};
 assert.equal(profileFact(label,answers).key,'highestCompletedEducation');
 const generic=resolveKnownQuestion({question:{label,options},profile:{answers},bank});assert.equal(generic.value,'High School');
 const workday=resolveQuestion(label,bank,{answers,options});assert.equal(workday.source,'profile');assert.equal(workday.candidates[0],'High School Diploma');
 assert.equal(approvedValue({},{label,type:'select-one'},{answers},bank,new Map()),'High School Diploma');
 assert.equal(profileFact(label,{degree:"Bachelor's Degree",graduationDate:'06/15/2027'}),null);
});
test('plain earliest start date uses the explicit role type and never borrows a different role availability',()=>{
 const label='What is your earliest start date?';
 for(const [role_type,want] of [['FULL_TIME','2027-06-16'],['INTERNSHIP','2027-06-15']]){
  assert.equal(profileFact(label,answers,{role_type}).value,want);
  assert.equal(resolveKnownQuestion({question:{label,type:'text'},profile:{answers},job:{role_type}}).value,want);
  assert.equal(resolveQuestion(label,{}, {answers,role_type}).candidates[0],want);
  const stale=role_type==='INTERNSHIP'?'2027-06-16':'2027-06-15',bank={[questionId(label)]:{question:label,answer:stale}};
  assert.equal(resolveKnownQuestion({question:{label,type:'text'},profile:{answers},bank,job:{role_type}}).value,want);
  assert.equal(resolveQuestion(label,bank,{answers,role_type,approvedAnswers:[{question:label,answer:stale}]}).candidates[0],want);
 }
 for(const context of [{},{title:'Mechanical Engineer'},{title:'Mechanical Intern'},{role_type:'CONTRACT'}])assert.equal(profileFact(label,answers,context),null);
 assert.equal(profileFact(label,{earliestStartDate:'2027-06-16'},{role_type:'INTERNSHIP'}),null);
 assert.equal(profileFact(label,{internshipAvailabilityStart:'2027-06-15'},{role_type:'FULL_TIME'}),null);
 assert.equal(profileFact(label,{earliestStartDate:'2027-02-31'},{role_type:'FULL_TIME'}),null);
 assert.equal(profileFact('Please list specific internship start and end dates.',answers,{role_type:'INTERNSHIP'}),null);
});
