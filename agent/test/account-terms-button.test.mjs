import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {termsCheckbox} from '../src/accounts.mjs';

// SuccessFactors Create-an-account (Mitsubishi Power 16096): the Terms of Use acceptance is a button, not a checkbox.
test('SuccessFactors terms button label counts as terms and the worker clicks it on an account page', () => {
  assert.ok(termsCheckbox('Terms of Use Read and accept the data privacy statement. Required'));
  const src = readFileSync(new URL('../src/dashboard-worker.mjs', import.meta.url), 'utf8');
  assert.match(src, /control\.type==='button'&&hasPassword&&canAuth&&termsCheckbox\(control\.label\)/);
});
