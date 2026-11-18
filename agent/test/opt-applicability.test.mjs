import test from 'node:test';import assert from 'node:assert/strict';
import {settledAnswer} from '../src/settled-facts.mjs';import {preferenceAnswer} from '../src/applicant-preferences.mjs';import {resolveKnownQuestion,availableFacts} from '../src/dashboard-worker.mjs';import {resolveQuestion} from '../src/workday.mjs';
const question='Do you hold a degree in a Science, Technology, Engineering, or Mathematics (STEM) field from a U.S. accredited institution that would allow you to apply for a 24-month OPT extension?';
const answers={citizenshipCountries:['United States'],f1OptStatus:'Not Applicable',highestCompletedEducation:'High School Diploma',degree:"Bachelor's Degree"};
test('OPT extension question uses offered Not applicable for confirmed U.S. citizen without asserting completed STEM degree',()=>{
 for(const na of ['Not applicable','Not Applicable','N/A']){
  const options=['Yes','No',na],known=settledAnswer(question,answers,{options});assert.equal(known.key,'f1OptStatus');assert.equal(known.value,na);
  assert.equal(resolveKnownQuestion({question:{label:question,type:'select',options},profile:{answers}}).value,na);
  assert.equal(resolveQuestion(question,{}, {answers,options}).candidates[0],na);
 }
 assert.equal(availableFacts({answers},'Fixture').f1OptStatus,'Not Applicable');
});
test('F-1/optional practical training synonyms use only an unambiguous offered not-applicable choice',()=>{
 for(const label of ['Are you currently on F-1 status?','Are you eligible for Optional Practical Training?','What is your STEM-OPT extension status?']){
  assert.equal(preferenceAnswer(label,answers,{options:['Yes','No','Not Applicable']}).value,'Not Applicable');
  assert.equal(preferenceAnswer(label,answers,{options:['Yes','No']}),null);
  assert.equal(preferenceAnswer(label,answers),null);
 }
 assert.equal(settledAnswer(question,answers,{options:['N/A','Not applicable']}),null);
});
test('immigration applicability neither answers generic STEM-degree questions nor invents future graduate enrollment',()=>{
 for(const label of ['Do you hold a degree in a STEM field from a U.S. accredited institution?','Will you return to school after the summer 2027 internship?','Are you admitted to or enrolled in a master’s degree program?','Would you like to opt in to recruiting messages?']){
  assert.equal(settledAnswer(label,answers,{options:['Yes','No','Not Applicable']}),null,label);
 }
 assert.equal(settledAnswer('Are you a U.S. citizen or an F-1 student?',answers,{options:['Yes','No','Not Applicable']}).value,'Yes');
 assert.equal(settledAnswer(question,{citizenshipCountries:['Canada']},{options:['Yes','No','Not Applicable']}),null);
 assert.equal(settledAnswer(question,{}, {options:['Yes','No','Not Applicable']}),null);
 assert.equal(resolveKnownQuestion({question:{label:question,type:'select',options:['Yes','No']},profile:{answers}}).resolved,false);
});

test('ordinary sponsorship and work authorization keep their claim when definitions list OPT as an example',()=>{
 const facts={...answers,requiresSponsorship:false,workAuthorizationCountries:['United States']};
 const labels=[
  'Will you now or in the future require sponsorship for an employment visa or immigration related benefit? For purposes of this question, employment visa or immigration related benefit includes H-1B petitions, sponsorship for OPT extension purposes, and TN applications.',
  'Will you need immigration sponsorship, including OPT extension sponsorship?',
  'Will you require employment visa sponsorship: H-1B, OPT, TN or E-3?',
 ];
 for(const label of labels)for(const options of [['Yes','No'],['Yes','No','Not Applicable']]){
  const result=resolveQuestion(label,{}, {answers:facts,location:'Berkeley, CA',options});assert.equal(result.candidates[0],'No');
  assert.equal(resolveKnownQuestion({question:{label,options},profile:{answers:facts},job:{location:'Berkeley, CA'}}).value,'No');
 }
 assert.equal(settledAnswer('Are you legally authorized to work in the United States? For example, through OPT.',facts,{options:['Yes','No','Not Applicable']}).value,'Yes');
 assert.equal(settledAnswer('Are you legally authorized to work in the United States (F-1 OPT, etc.)?',facts,{options:['Yes','No','Not Applicable']}).value,'Yes');
 assert.equal(settledAnswer(question,facts,{options:['Yes','No','Not Applicable']}).value,'Not Applicable');
});
