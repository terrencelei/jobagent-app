import test from 'node:test';
import assert from 'node:assert/strict';
import {profileFact} from '../src/profile-facts.mjs';

// Piper Aircraft's iRecruit form (13354) asks "Type of work desired:"; only an explicit
// full-time posting answers it, never a guess from the title.
test('iRecruit Type of work desired follows an explicit full-time role type', () => {
  const options = ['Select', 'Full Time', 'Part Time', 'Seasonal Employee'];
  assert.equal(profileFact('Type of work desired:', {}, {options, role_type: 'FULL_TIME'})?.value, 'Full Time');
  assert.equal(profileFact('Type of work desired:', {}, {options, role_type: 'INTERNSHIP'}), null);
  assert.equal(profileFact('Type of work desired:', {}, {options}), null);
});
