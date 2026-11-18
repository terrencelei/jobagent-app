import test from 'node:test';
import assert from 'node:assert/strict';
import {preferenceAnswer,contactFieldLabel} from '../src/applicant-preferences.mjs';
import {approvedValue} from '../src/dashboard-worker.mjs';

// Virgin Galactic 13400 (lesson 401): Phenom's "Contact Email*" field got the email-consent "Yes".
const answers={email:'applicant@example.test',recruitmentEmailConsent:'Yes',recruitmentMessageConsent:'Yes'};

test('a plain contact field label is not an email-consent question',()=>{
  for(const label of ['Contact Email*','Contact Email','Contact Email Address','Preferred Contact Phone','Primary Email'])assert.equal(contactFieldLabel(label),true,label);
  assert.notEqual(preferenceAnswer('Contact Email*',answers,{})?.key,'recruitmentEmailConsent');
});

test('real consent questions still resolve to his consent answer',()=>{
  assert.equal(contactFieldLabel('May we contact you by email about this opportunity?'),false);
  assert.equal(preferenceAnswer('May we contact you by email about this opportunity?',answers,{})?.key,'recruitmentEmailConsent');
  assert.equal(preferenceAnswer('Do you consent to receive text messages from our recruiters?',answers,{})?.key,'recruitmentMessageConsent');
});

test('Contact Email* is filled with his saved email, not Yes',()=>{
  const profile={answers};
  const control={label:'Contact Email*',type:'email',required:true};
  for(const fact of ['email','contactEmail',undefined])assert.equal(approvedValue({action:'fill',fact},control,profile,{},new Map(),'Virgin Galactic',{company:'Virgin Galactic'}),answers.email);
});
