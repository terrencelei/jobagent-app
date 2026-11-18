import test from 'node:test';
import assert from 'node:assert/strict';
import {capAllowed, detectCap} from '../src/application-caps.mjs';

// The same sentences as JobAgent's tests/test_application_caps.py, so both detectors agree.
const SENTENCES = [
  ['We love your interest in working for Airbus but we do ask that you make only one application to the Airbus Global Graduate Programme.', [1, null]],
  ['Candidates may apply to up to 10 positions in a 30-day period.', [10, 30]],
  ['You can submit a maximum of 3 applications per 6 months.', [3, 180]],
  ['Applicants are limited to five applications within a rolling 12-month period.', [5, 360]],
  ['You may submit up to 3 applications per calendar year.', [3, 365]],
  ['Please apply to no more than two roles at a time.', [2, null]],
  ['We are hiring up to 3 engineers for this team.', null],
  ['Up to 10% travel required.', null],
  ['You will manage up to 5 open requisitions with vendors.', null],
  ['Requires 3 years of experience.', null],
];

test('stated limits are found and duties are not', () => {
  for (const [text, expected] of SENTENCES) {
    const found = detectCap(`Intro line.\n${text} Closing line.`);
    assert.deepEqual(found && [found.max, found.days], expected, text);
  }
});

test('an allowed employer is recognised whatever the case', () => {
  assert.ok(capAllowed('SpaceX', {spacex: {max: 10, days: 30}}));
  assert.ok(!capAllowed('Anduril', {SpaceX: {max: 10, days: 30}}));
});
