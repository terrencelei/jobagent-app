import test from 'node:test';
import assert from 'node:assert/strict';
import {signInLandingPage} from '../src/posting-navigation.mjs';

// X-Bow 12727: after a failed Log In, "Need an account? Click here!" opens /account/, the
// registration form. It is not a signed-in profile page, so the posting must not be reopened.
test('ApplicantPro registration page is not a sign-in landing page',()=>{
 const job='https://www.applicantpro.com/openings/xbowsystems/jobs/4249480-713417';
 assert.equal(signInLandingPage('https://xbowsystems.applicantpro.com/account/',[job]),false);
 assert.equal(signInLandingPage('https://arcbest.avature.net/careersmarketplace/Profile','https://arcbest.avature.net/careersmarketplace/JobDetail?id=1'),true);
});
