import test from 'node:test';
import assert from 'node:assert/strict';
import {offeredPreference} from '../src/dashboard-worker.mjs';
import {questionId} from '../src/companies.mjs';

// Hyundai 11914 (SuccessFactors): the "How did you hear about this position?" typeahead lists no careers-site
// choice, so the routine source default picked before the menu opened ("Company Website") was never offered.
const HYUNDAI=['No Selection','Careers Expo','Employee Referral','Job Board','Others','Recruitment Agency','School Campus Recruitment','Social Media'];
const profile={answers:{routineSourceChoiceAllowed:true,hearAbout:'Careers site'}};
const job={id:11914,company:'Hyundai America Technical Center, Inc.',title:'Wheels & Tires Engineer'};

test('a routine source default the menu never offered is re-chosen from the offered options',()=>{
 assert.equal(offeredPreference('*\n How did you hear about this position?','Company Website',HYUNDAI,profile,job),'Job Board');
});
test('an offered value is kept and an empty menu changes nothing',()=>{
 assert.equal(offeredPreference('*\n How did you hear about this position?','Job Board',HYUNDAI,profile,job),null);
 assert.equal(offeredPreference('*\n How did you hear about this position?','Company Website',[],profile,job),null);
});
test('a question without a saved policy is not re-chosen',()=>{
 assert.equal(offeredPreference('Favourite colour','Blue',['Red','Green'],{answers:{}},job),null);
});
test("the dropdown's twin button shares the flagged question's id",()=>{
 assert.equal(questionId('How did you hear about this position?'),questionId('*\n How did you hear about this position?'));
});
