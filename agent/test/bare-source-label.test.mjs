import test from 'node:test';
import assert from 'node:assert/strict';
import {routineApplicationAnswer} from '../src/routine-application-policy.mjs';

// Virgin Galactic 13400 (lesson 415): Phenom labels the how-did-you-hear select just "Source*".
const options=['No Selection','Agency','CalJobs','CareerBuilder.com','Company Website','Direct Source','Employee Referral','Glassdoor','Indeed.com','LinkedIn','Other','Social Media','University / College Campus','Ziprecruiter'];

test('a bare Source select uses his routine source permission',()=>{
  const r=routineApplicationAnswer('Source*',{routineSourceChoiceAllowed:true,hearAbout:'Careers site'},{company:'Virgin Galactic',options});
  assert.equal(r?.key,'routineSourceChoiceAllowed');
  assert.equal(r.value,'Company Website');
});

test('without the permission, or for an unrelated Source label, nothing is chosen',()=>{
  assert.equal(routineApplicationAnswer('Source*',{},{options}),null);
  assert.equal(routineApplicationAnswer('Source of funds',{routineSourceChoiceAllowed:true},{options}),null);
});
