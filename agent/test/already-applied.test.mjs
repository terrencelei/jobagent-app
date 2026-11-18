import test from 'node:test';
import assert from 'node:assert/strict';
import {alreadyAppliedNotice} from '../src/already-applied.mjs';

test('Hyundai HATCI "You already applied for this position." page is recognised', () => {
  assert.equal(alreadyAppliedNotice('Home About Careers\nYou already applied for this position.\nBack to Job Listings'), 'You already applied for this position.');
  assert.ok(alreadyAppliedNotice("You've already applied to this job"));
  assert.ok(alreadyAppliedNotice('Our records show that you have already applied for this requisition.'));
});

test('sign-in hints and ordinary forms are not mistaken for a prior application', () => {
  assert.equal(alreadyAppliedNotice('If you have already applied for this position, sign in to check status.'), null);
  assert.equal(alreadyAppliedNotice('First name\nLast name\nApply for this position'), null);
  assert.equal(alreadyAppliedNotice(''), null);
});
