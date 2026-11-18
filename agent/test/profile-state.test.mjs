import test from 'node:test';
import assert from 'node:assert/strict';
import {profileFact} from '../src/profile-facts.mjs';

// Intuitive 12315/12316 (lesson 432): "What is your State or Province? *" is a SmartRecruiters search box; he had to
// answer CA by hand although his profile holds addressState.
const answers={addressState:'CA'};
test('his state answers a worded State question, typed or picked from the listed options',()=>{
 assert.deepEqual(profileFact('What is your State or Province? *',answers),{key:'addressState',value:'California',candidates:['California','CA']});
 assert.equal(profileFact('What is your State or Province?',answers,{options:['Arizona','California','Colorado']}).value,'California');
 assert.equal(profileFact('State',answers,{options:['AZ','CA']}).value,'CA');
 assert.equal(profileFact('Your state of residence',answers).value,'California');
 assert.equal(profileFact('If you selected Other from the State/Province list, please enter the name below.',answers),null);
 assert.equal(profileFact('If you live in one of these states, would you consider relocation?',answers),null);
});
