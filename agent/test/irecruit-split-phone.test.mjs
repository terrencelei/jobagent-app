import test from 'node:test';
import assert from 'node:assert/strict';
import {profileFact} from '../src/profile-facts.mjs';

// Piper Aircraft's iRecruit form (13354) splits Cell Phone into three boxes named
// cellphone_1/2/3. Each box takes its own part of the saved number, not the whole of it.
test('iRecruit cellphone_1/2/3 boxes take area code, prefix and line', () => {
  for (const phone of ['(555) 010-0123', '+1 555-010-0123', '5550100123']) {
    const answers = {phone};
    assert.deepEqual(['cellphone_1', 'cellphone_2', 'cellphone_3'].map(l => profileFact(l, answers)?.value), ['555', '010', '0123'], phone);
  }
  assert.equal(profileFact('homephone_2', {phone: '555-010-0123'}).value, '010');
  assert.equal(profileFact('cellphone_1', {phone: '+44 20 7946 0000'}), null);
  assert.equal(profileFact('cellphone_1', {phone: '555-010-0123'}, {options: ['Yes', 'No']}), null);
});
