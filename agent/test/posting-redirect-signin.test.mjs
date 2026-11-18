import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {passwordAllowedOn} from '../src/accounts.mjs';

// ArcBest 12717: arcbest.avature.net/careersmarketplace/JobDetail redirects to the employer's own
// careers.arcb.com, whose application page asks for a username and password.
const job = 'https://arcbest.avature.net/careersmarketplace/JobDetail?id=29813&source=Indeed';
const landed = 'https://careers.arcb.com/careersmarketplace/JobDetail?id=29813&source=Indeed';
const apply = 'https://careers.arcb.com/careersmarketplace/ApplicationMethods?jobId=29813&source=Indeed';

test('the page a posting redirected to on opening counts as the posting site', () => {
  assert.equal(passwordAllowedOn(apply, job), false);
  assert.equal(passwordAllowedOn(apply, [job, landed]), true);
});

test('a link out of the posting still cannot collect the password', () => {
  assert.equal(passwordAllowedOn('https://evil.example/login', [job, landed]), false);
  assert.equal(passwordAllowedOn('http://careers.arcb.com/login', [job, landed]), false);
  assert.equal(passwordAllowedOn(apply, [job, null]), false);
});

test('the worker checks sign-in pages against the opening redirect too', async () => {
  const source = await readFile(new URL('../src/dashboard-worker.mjs', import.meta.url), 'utf8');
  assert.match(source, /const postingURLs=\[job\.url,page\.url\(\)\];/);
  assert.doesNotMatch(source, /passwordAllowedOn\([^)]*,job\.url\)/);
});
