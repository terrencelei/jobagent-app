import test from 'node:test';
import assert from 'node:assert/strict';
import {profileFact} from '../src/profile-facts.mjs';

// Innovative Refrigeration Systems (12981) surfaced its phone inputs as home_phone and
// mobile_phone; both take the one saved number instead of parking for approval.
test('r717 home_phone / mobile_phone fields use the saved phone', () => {
  const answers = {phone: '555-0100'};
  for (const label of ['home_phone', 'mobile_phone', 'Home Phone', 'Mobile Phone *', 'Cell Phone'])
    assert.deepEqual(profileFact(label, answers), {key: 'phone', value: '555-0100', authoritative: true}, label);
  assert.equal(profileFact('Mobile Phone', answers, {options: ['Yes', 'No']}), null);
});
