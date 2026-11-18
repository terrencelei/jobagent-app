import test from 'node:test';
import assert from 'node:assert/strict';
import {offSiteLink} from '../src/dashboard-worker.mjs';

// Amazon 16220: the review page's "Edit Job-specific questions" is <a href="javascript:void(0)">. Its URL origin is the
// string "null", which the origin comparison took for another site, so the run failed as an unverified external link.
test('a javascript:, mailto: or about: href is not an off-site link',()=>{
 const page='https://account.amazon.jobs/en-US/applicant/jobs/10552960/apply';
 for(const href of ['javascript:void(0)','javascript:;','mailto:jobs@example.com','about:blank','','not a url',undefined])
  assert.equal(offSiteLink(href,page),false,String(href));
 assert.equal(offSiteLink('https://account.amazon.jobs/en-US/applicant/jobs/10552960/apply#questions',page),false,'same origin');
});

test('an http(s) link to another origin is still off-site',()=>{
 const page='https://www.llnl.gov/join-our-team/careers/find-your-job/all/all/3743990016156496';
 assert.equal(offSiteLink('https://jobs.smartrecruiters.com/LLNL/3743990016156496',page),true);
 assert.equal(offSiteLink('http://www.llnl.gov/x',page),true,'scheme change is another origin');
});
