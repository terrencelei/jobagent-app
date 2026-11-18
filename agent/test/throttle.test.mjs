import test from 'node:test';
import assert from 'node:assert/strict';
import { siteThrottled, siteAccessFailure, throttledReason, THROTTLED } from '../src/throttle.mjs';
import { outcome } from '../src/dashboard-workday.mjs';

test('Workday error page is recognised as throttling, with its code', () => {
  const page = 'My Information\nSomething went wrong\nPlease refresh the page and then try again.\nError Code: VPS|4759286e-64fc-400b-b491-946fc569e960';
  assert.equal(siteThrottled(page), 'Workday error page (VPS|4759286e-64fc-400b-b491-946fc569e960)');
  assert.equal(siteThrottled('HTTP 429 error: Too Many Requests'), 'too many requests');
  assert.equal(siteThrottled('We detected unusual traffic from your network'), 'unusual traffic warning');
});

test('Cloudflare\'s block page is a throttling wall, with the cooldown path', () => {
  const page = 'Sorry, you have been blocked\nYou are unable to access safran-group.com\nWhy have I been blocked?\nThis website is using a security service to protect itself from online attacks.\nCloudflare Ray ID: a4f4df4c4cb9fca7 • Your IP: Click to reveal • Performance & security by Cloudflare';
  assert.equal(siteThrottled(page), 'Cloudflare block page');
  assert.equal(siteThrottled('Attention Required! | Cloudflare'), 'Cloudflare block page');
  assert.ok(throttledReason(siteThrottled(page)).startsWith(THROTTLED));
  // A posting that merely mentions the vendor is not a wall.
  assert.equal(siteThrottled('Experience with Cloudflare, AWS WAF or similar edge security services'), null);
});

test('normal application pages are not throttling', () => {
  for (const text of ['My Information\nFirst Name\nLast Name', 'Application Questions 1 of 2\nAre you a citizen of the United States?',
    'Zip code 94290', 'Something went wrong with your upload? Try another file.', ''])
    assert.equal(siteThrottled(text), null, text);
});

test('Workday mid-form page error banners use the employer cooldown path', () => {
  for (const text of ['My Experience\nErrors Found\nError-Page Error',
    'My Experience\nErrors Found\n1. Error - Page Error']) {
    assert.equal(siteThrottled(text), 'Workday page error banner');
    const result = outcome({status: 'throttled', reason: throttledReason(siteThrottled(text))});
    assert.equal(result.status, 'blocked');
    assert.ok(result.message.startsWith(THROTTLED));
  }
  assert.equal(siteThrottled('Errors Found\nSchool or University is required'), null);
  assert.equal(siteThrottled('Describe how you debug an Error-Page Error in your work'), null);
  // The VPS error page takes the same Rate-limited path the queue looks for.
  assert.ok(outcome({status: 'throttled', reason: throttledReason('Workday error page (VPS|x)')}).message.startsWith(THROTTLED));
});


test('access refusals and server outages are distinct from applicant questions', () => {
 assert.equal(siteAccessFailure('403 Forbidden'), 'access denied (HTTP 403)');
 assert.equal(siteAccessFailure('Error',503), 'server error (HTTP 503)');
 assert.equal(siteAccessFailure('You will work on access denied error handling.'), null);
 assert.equal(siteAccessFailure('Questions about security clearances'), null);
});

test('a positively missing Workday posting is retired rather than requesting applicant help',()=>{
 const r=outcome({status:'blocked',reason:'Posting unavailable: employer reports that this job page no longer exists'});
 assert.equal(r.status,'skipped');assert.equal(r.posting_unavailable,true);
 assert.equal(outcome({status:'blocked',reason:'Something went wrong'}).status,'blocked');
});

test('uncertain Workday submission remains protected from preparation retries',()=>{
 const r=outcome({status:'submission_unknown',reason:'connection lost after submit'});
 assert.equal(r.status,'submission_unknown');assert.equal(r.submission_attempted,true);
});

test('Vercel security checkpoint at Workday sign-in is a cooldown wall, not a missing account (12799)', async () => {
  const {chromium} = await import('playwright');
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent('<main><h1>Failed to verify your browser</h1><p>Code 21</p></main><footer>Vercel Security Checkpoint | sfo1::1792829029-pkmNEA7tgW4USWMO6PdevLpiEZySn7uC</footer>');
    const wall = siteThrottled(await page.locator('body').innerText());
    assert.equal(wall, 'Vercel security checkpoint');
    assert.ok(throttledReason(wall).startsWith(THROTTLED));
    // The dashboard keeps the Rate-limited marker (employer cooldown), not a sign-in failure.
    assert.ok(outcome({status: 'throttled', reason: throttledReason(wall)}).message.startsWith(THROTTLED));
  } finally { await browser.close(); }
  assert.equal(siteThrottled('Deploy front ends on Vercel or Netlify'), null);
});

test('Workday "An error occurred ... Support ID" edge page is a cooldown, not a missing account (Boeing 15934)', () => {
  const page = 'An error occurred.\nPlease contact Workday Support if the problem persists.\nSupport ID: a5a444e6baa1402a – Client IP: 203.0.113.9';
  assert.equal(siteThrottled(page), 'Workday error page');
  assert.equal(siteThrottled('Please describe an error occurred during testing. Contact support.'), null);
});
