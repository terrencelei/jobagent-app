import test from 'node:test';import assert from 'node:assert/strict';
import {profileFact} from '../src/profile-facts.mjs';

const answers={addressLine1:'1 Main St',addressLine2:'Unit 2',addressCity:'Town',addressState:'CA',addressZip:'90000'};
test('current-address questions resolve from the confirmed address',()=>{
 for(const q of ['Please provide your current address','Address','What is your home address?','Please enter your mailing address *'])
  assert.equal(profileFact(q,answers)?.value,'1 Main St, Unit 2, Town, CA 90000',q);
 assert.equal(profileFact('Address',{...answers,addressZip:''}),null);
 assert.equal(profileFact('Email address',answers)?.key,undefined);
 assert.equal(profileFact('Address you will relocate to',answers),null);
});

test('how-heard matches the employer website option written without spaces',()=>{
 const r=profileFact('How did you hear about this job?',{hearAbout:'Company careers site'},{company:'Field AI',options:['LinkedIn','FieldAI Website','Other']});
 assert.equal(r?.value,'FieldAI Website');
});
