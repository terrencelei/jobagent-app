import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {intentOf, lookup, sharedEligible, learnApprovals, loadAnswers} from '../src/companies.mjs';
import {resolveQuestion, pickOption, HEARD_CANDIDATES} from '../src/workday.mjs';

test('the same question in different wordings shares one intent', () => {
  for (const q of ['How Did You Hear About Us?', 'How did you hear about this role?', 'How did you hear about this opportunity?',
                   'How did you learn about this opportunity?', 'How did you hear about us? (Select One)', 'Where did you hear about this job?',
                   'How did you come to know about this opportunity?'])
    assert.equal(intentOf(q), 'how-heard', q);
  assert.equal(intentOf('Phone Device Type'), 'phone-type');
  assert.equal(intentOf('Address Line 1'), 'address-line-1');
  assert.equal(intentOf('Postal Code'), 'postal-code');
  assert.equal(intentOf('Why do you want to work here?'), null);
});

test('only answers that are not about one employer are shared', () => {
  assert.equal(sharedEligible('How did you hear about us?', 'Career Site', 'Leidos'), true);
  assert.equal(sharedEligible('Have you previously been employed by Semtech?', 'No', 'Semtech'), false);
  assert.equal(sharedEligible('How did you hear about us?', 'Leidos Careers Website', 'Leidos'), false);
  assert.equal(sharedEligible('Why this role?', 'A long answer\nwith lines', 'Acme'), false);
  assert.equal(sharedEligible('Anything else?', 'short', 'Acme', 'textarea'), false);
  assert.equal(sharedEligible('Are you a prior employee of a Hitachi Group company?', 'No', 'Hitachi'), false);
});

test('an answer approved at one employer is found at the next by its intent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-'));
  try {
    const learned = await learnApprovals(dir, 'Leidos', [
      {question: 'How Did You Hear About Us?', answer: 'Career Site'},
      {question: 'Have you previously been employed by Leidos?', answer: 'No'},
    ], 'jobagent-1');
    assert.deepEqual(learned, {own: 2, shared: 1});
    const {answers} = await loadAnswers(dir, 'Blue Origin');
    assert.equal(lookup(answers, 'How did you hear about this opportunity?').answer, 'Career Site');
    assert.equal(lookup(answers, 'Have you previously been employed by Blue Origin?'), undefined);
    const own = JSON.parse(await readFile(join(dir, 'leidos.json'), 'utf8'));
    assert.equal(Object.keys(own.answers).length, 2);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('Workday settles profile facts, prior-employer questions and phone type without asking', () => {
  const ctx = {company: 'Semtech', history: [{company: 'Eight Sleep'}], answers: {addressLine1: '1 Main St', addressZip: 95008}};
  for (const q of ['Have you previously been employed by Semtech as a Full-time, Part-time or Contract employee?',
                   'Have you ever been employed by Citi or any of its predecessor companies?',
                   'Are you a prior employee of a Hitachi Group company?',
                   'Are you currently working or have you previously worked as a GM employee or contractor?',
                   'Have you ever been issued a Cisco Employee ID or Cisco email address?'])
    assert.deepEqual(resolveQuestion(q, {}, ctx).candidates, ['No'], q);
  assert.equal(resolveQuestion('Have you previously worked for Eight Sleep?', {}, {...ctx, company: 'Eight Sleep'}), null);
  assert.deepEqual(resolveQuestion('Address Line 1', {}, ctx), {candidates: ['1 Main St'], source: 'profile'});
  assert.deepEqual(resolveQuestion('Postal Code', {}, ctx).candidates, ['95008']);
  assert.equal(pickOption(['Home', 'Mobile/Cell', 'Work'], resolveQuestion('Phone Device Type', {}, ctx).candidates), 'Mobile/Cell');
});

test('how-heard tries his learned answer, then the employer site, then a website category', () => {
  const bank = {'intent:how-heard': {answer: 'Career Site'}};
  const heard = resolveQuestion('How did you hear about us?', bank, {});
  assert.equal(heard.candidates[0], 'Career Site');
  assert.equal(pickOption(['LinkedIn', 'Career Site', 'Referral'], heard.candidates), 'Career Site');
  assert.equal(pickOption(['LinkedIn', 'NXP Careers Page', 'Referral'], HEARD_CANDIDATES), 'NXP Careers Page');
  assert.equal(pickOption(['Referral', 'Website', 'Job Board'], HEARD_CANDIDATES), 'Website');
  assert.equal(pickOption(['Referral', 'Job Fair'], HEARD_CANDIDATES), null);
});
