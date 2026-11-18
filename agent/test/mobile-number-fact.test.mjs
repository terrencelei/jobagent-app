import test from 'node:test';
import assert from 'node:assert/strict';
import {profileFact} from '../src/profile-facts.mjs';

// R-V Industries 13344 (ADP Workforce Now) labels its phone input "Mobile Number";
// the saved phone was not used and the field was parked for approval.
test('Mobile/cell number labels use the saved phone', () => {
  const answers={phone:'555-010-0000'};
  for(const label of ['Mobile Number','Mobile Number *','Mobile Phone Number','Cell Number','Cell Phone Number'])
    assert.equal(profileFact(label,answers)?.value,'555-010-0000',label);
  assert.equal(profileFact('Mobile Number',answers,{options:['Yes','No']}),null);
});
