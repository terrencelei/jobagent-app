import test from 'node:test';
import assert from 'node:assert/strict';
import {platformApplyLink} from '../src/dashboard-worker.mjs';

test('Apply to SuccessFactors carrying the posting\'s stated Job ID is followed (L3Harris 16675)', () => {
  const job = {title: 'Associate, Instrumentation and Controls Test Integration Engineer', url: 'https://careers.l3harris.com/en/job/-/-/4832/103163614656',
    description: 'Job Title:  Associate, Propulsion\nJob ID:  37026\nJob Location:  Orange, VA'};
  const link = {type: 'a', label: 'Apply Now', href: 'https://career-hcm20.ns2cloud.com/careers?company=L3HHCM20&clientId=jobs2web&career_ns=job_application&career_job_req_id=37026'};
  assert.equal(platformApplyLink(link, job), true);
  assert.equal(platformApplyLink({...link, href: link.href.replace('37026', '99999')}, job), false, 'another requisition');
  assert.equal(platformApplyLink({...link, href: link.href.replace('ns2cloud.com', 'evil.example')}, job), false, 'unknown host');
  assert.equal(platformApplyLink(link, {...job, description: 'no id here'}), false);
});
