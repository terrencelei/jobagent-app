import test from 'node:test';
import assert from 'node:assert/strict';
import {keptValue} from '../src/dashboard-worker.mjs';

// R-V Industries 13344 (ADP Workforce Now): a type=text "Mobile Number" turned the saved
// a typed "555-010-0000" into "+1 555 010 0000"; the readback called it unretained and parked the field.
test('a phone number reformatted with a +1 prefix counts as kept, in text and tel inputs', () => {
  assert.ok(keptValue('text','+1 555 010 0000','555-010-0000'));
  assert.ok(keptValue('tel','+1 555 010 0000','555-010-0000'));
  assert.ok(keptValue('tel','(555) 010-0000','555-010-0000'));
  assert.ok(keptValue('text','(555) 010-0000','555-010-0000'));
});

test('other text changes are still caught', () => {
  assert.ok(!keptValue('text','555 010 000','555-010-0000'));
  assert.ok(!keptValue('text','+44 555 010 0000','555-010-0000'));
  assert.ok(!keptValue('text','2024','2,024'));
  assert.ok(!keptValue('text','12','1-2'));
  assert.ok(!keptValue('text','Alex','Alex L'));
});
