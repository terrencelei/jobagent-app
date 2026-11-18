import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {alreadyAppliedNotice} from '../src/already-applied.mjs';

test('Workday "You\'ve already applied for this job." page is recognised (NVIDIA 12459)', () => {
  const page = 'CAREERS AT NVIDIA\nTechnical Product Marketing Engineer, Robotics Simulation - New College Grad 2027\nYou\'ve already applied for this job.\nView My Applications';
  assert.equal(alreadyAppliedNotice(page), "You've already applied for this job.");
});

test('workday-run checks for a prior application before reporting an unknown step', () => {
  const src = readFileSync(new URL('../tools/workday-run.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('alreadyAppliedNotice(t)');
  assert.ok(i > 0 && i < src.indexOf("could not tell which step the wizard is on"));
});
