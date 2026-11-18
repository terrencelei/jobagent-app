import test from 'node:test';
import assert from 'node:assert/strict';
import { profileFact } from '../src/profile-facts.mjs';

test('Highest Level of education completed? maps to the "High School Diploma OR Equivalent Certification" option', () => {
  const options = ['None', 'High School Diploma OR Equivalent Certification', 'Some College, No Degree', "Bachelor's Degree Or Equivalent", 'Graduate Degree'];
  const fact = profileFact('Highest Level of education completed?', { highestCompletedEducation: 'High School Diploma' }, { options });
  assert.equal(fact.key, 'highestCompletedEducation');
  assert.ok(fact.candidates.includes('High School Diploma OR Equivalent Certification'));
});
