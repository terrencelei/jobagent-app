import test from 'node:test';
import assert from 'node:assert/strict';
import {profileFact} from '../src/profile-facts.mjs';

// Amazon job 12509 parked because "High School Diploma" matched none of Amazon's options.
test('completed high school maps to Amazon "High school or equivalent"', () => {
  const options = ['I have not completed any formal education', 'High school or equivalent', 'Technical college or trade qualification or equivalent', "Bachelor's degree or equivalent", "Master's degree or equivalent", 'Doctorate/PhD or equivalent'];
  const fact = profileFact('What is the highest level of education that you have completed?', {highestCompletedEducation: 'High School Diploma'}, {options, company: 'Amazon'});
  assert.equal(fact.key, 'highestCompletedEducation');
  assert.ok(fact.candidates.includes('High school or equivalent'));
  assert.ok(!fact.candidates.some(c => /bachelor/i.test(c)));
});
