import test from 'node:test';
import assert from 'node:assert/strict';
import {signInPagePostingUrl,icimsPostingUrl} from '../src/posting-availability.mjs';

// Freeform 13281: the import stored MyGreenhouse's sign-in page as the posting URL, and the worker typed his
// email into its login form before giving up. A sign-in page URL is flagged before anything opens.
test('the MyGreenhouse candidate sign-in page is not a posting', () => {
  assert.match(signInPagePostingUrl('https://my.greenhouse.io/users/sign_in'), /MyGreenhouse candidate login, not a job posting/);
  assert.match(signInPagePostingUrl('https://my.greenhouse.io/'), /MyGreenhouse candidate login/);
  assert.match(signInPagePostingUrl('https://careers.example.com/login'), /sign-in page, not a job posting/);
  assert.match(signInPagePostingUrl('https://careers.example.com/users/sign_in/'), /sign-in page/);
  assert.match(signInPagePostingUrl('https://careers.example.com/sessions/new'), /sign-in page/);
});

test('real postings, apply pages and sign-in-looking slugs pass', () => {
  for (const url of ['https://job-boards.greenhouse.io/freeformfuturecorp/jobs/7895758003',
                     'https://my.greenhouse.io/jobs/freeformfuturecorp/7895758003',
                     'https://jobs.lever.co/acme/1234/apply',
                     'https://careers.example.com/jobs/login-systems-engineer',
                     'https://careers.example.com/signin-platform/jobs/12',
                     'http://my.greenhouse.io/users/sign_in', 'not a url']) {
    assert.equal(signInPagePostingUrl(url), null, url);
  }
});

test('iCIMS /jobs/<id>/login maps to the public job page only', () => {
  assert.equal(icimsPostingUrl('https://us-careers-rivian.icims.com/jobs/30491/login'), 'https://us-careers-rivian.icims.com/jobs/30491/job');
  assert.equal(icimsPostingUrl('https://us-careers-rivian.icims.com/jobs/30491/job'), null);
  assert.equal(icimsPostingUrl('https://evil.example.com/jobs/30491/login'), null);
  assert.equal(signInPagePostingUrl(icimsPostingUrl('https://us-careers-rivian.icims.com/jobs/30491/login')), null);
  assert.equal(icimsPostingUrl('http://us-careers-rivian.icims.com/jobs/30491/login'), null);
});
