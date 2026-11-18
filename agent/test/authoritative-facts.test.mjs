import test from 'node:test';
import assert from 'node:assert/strict';
import {preferenceAnswer} from '../src/applicant-preferences.mjs';
import {resolveQuestion,pickOption,needsWorkdayAnswer,reviewProblems} from '../src/workday.mjs';
import {approvedValue,resolveKnownQuestion} from '../src/dashboard-worker.mjs';
import {questionId} from '../src/companies.mjs';

const dod='2. Section 847 of the National Defense Authorization Act requires an ethics opinion regarding post-employment restrictions. Do you now, or did you at any time in the past 24 months, serve as an official or employee of the DoD?';
const highest='Please select the highest level of degree you have completed.';
const profile={answers:{governmentEmployment:'No',armedForcesService:'No',highestCompletedEducation:'High School Diploma',degree:"Bachelor's Degree",workAuthorizationCountries:['United States']}};
const choices=['Yes, I have served in the last 24 months as an official or employee of the DoD.','No, I have not served in the last 24 months as an official or employee of the DoD.'];
for(const [label,wrong,right,options] of [[dod,choices[0],'No',choices],[highest,'Bachelors Degree','High School Diploma',['High School Diploma','Bachelors Degree']]]){
 test(`corrected current fact wins over stale inline and bank answers: ${label}`,()=>{
  const bank={[questionId(label)]:{question:label,answer:wrong,approvedAt:'2099-01-01T00:00:00Z'}};
  const inline=new Map([[questionId(label),wrong]]);
  const known=preferenceAnswer(label,profile.answers);
  assert.equal(known.value,right);assert.equal(known.authoritative,true);
  const workday=resolveQuestion(label,bank,{answers:profile.answers,approvedAnswers:[{question:label,answer:wrong}],options});
  assert.equal(workday.source,'profile');assert.equal(workday.candidates[0],right);
  assert.equal(pickOption([wrong],workday.candidates),null);
  assert.equal(needsWorkdayAnswer({kind:'listbox',label,value:wrong},workday),true);
  const offered=pickOption(options,workday.candidates);assert.ok(offered);assert.notEqual(offered,wrong);
  assert.equal(approvedValue({fact:`bank:${questionId(label)}`},{label,type:'select-one'},profile,bank,inline),right);
  assert.equal(resolveKnownQuestion({question:{label,type:'select',options},profile,bank}).value,offered);
  for(const optionLabel of options){
   assert.equal(approvedValue({fact:'governmentEmployment'},{label,type:'radio',optionLabel,choiceLabels:options},profile,bank,inline),optionLabel===offered);
  }
 });
}
test('highest completed education wording uses the corrected fact without replacing in-progress degree rows',()=>{
 for(const label of ['What is your highest level of completed education?','Highest Level of education completed?',"What is the highest level of education you've received?"]){
  assert.equal(preferenceAnswer(label,profile.answers).value,'High School Diploma');
  assert.equal(preferenceAnswer(label,profile.answers).authoritative,true);
 }
 assert.equal(preferenceAnswer('Degree',profile.answers).value,"Bachelor's Degree");
 assert.equal(preferenceAnswer('Degree',profile.answers).authoritative,undefined);
});
test('narrow factual corrections preserve employer connection exceptions and approved prose',()=>{
 const p={answers:{employerConnectionsDefault:'No',highestCompletedEducation:'High School Diploma'}};
 for(const [label,answer] of [['Do you know anyone at Fixture?','Yes'],['Why are you interested in Fixture?','An approved reason.']]){
  const bank={[questionId(label)]:{question:label,answer}};
  assert.equal(resolveQuestion(label,bank,{answers:p.answers}).candidates[0],answer);
  assert.equal(approvedValue({}, {label,type:'textarea'},p,bank,new Map()),answer);
 }
 assert.equal(preferenceAnswer('Are you eligible to obtain Top Secret clearance?',profile.answers),null);
});

test('final review blocks stale DoD service and completed degree claims while permitting studies in progress',()=>{
 const wrong=`Education 1\nDegree\nBachelor's Degree\nDo you now, or did you at any time in the past 24 months, serve as an official or employee of the DoD? For more information, see Section 847*\n\nYes, I have served in the last 24 months as an official or employee of the DoD.\nWhat is the highest level of education you've received?*\n\nBachelors Degree`;
 assert.equal(reviewProblems(wrong,profile.answers).length,2);
 const correct=wrong.replace('Yes, I have served','No, I have not served').replace('\nBachelors Degree','\nHigh School Diploma');
 assert.deepEqual(reviewProblems(correct,profile.answers),[]);
 assert.deepEqual(reviewProblems("Education 1\nDegree\nBachelor's Degree",profile.answers),[]);
});
