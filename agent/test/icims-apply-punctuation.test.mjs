import test from 'node:test';
import assert from 'node:assert/strict';
import {platformApplyLink, isApplicationEntry} from '../src/dashboard-worker.mjs';

// Rivian 9516: iCIMS labels the link "Apply : Early Career - Validation Engineer, Vehicle Hardware"
// while the job title is "Early Career Validation Engineer - Vehicle Hardware".
const job = {title: 'Early Career Validation Engineer - Vehicle Hardware', url: 'https://careers.rivian.com/careers-home/jobs/32131?icims=1'};
const link = {type: 'a', label: 'Apply : Early Career - Validation Engineer, Vehicle Hardware', href: 'https://careers-rivian.icims.com/jobs/32131/login'};

test('iCIMS Apply link whose title differs only in punctuation is the posting entry', () => {
  assert.equal(isApplicationEntry(link, [], job), true);
  assert.equal(platformApplyLink(link, job), true);
});

test('a different title or another requisition is still rejected', () => {
  assert.equal(isApplicationEntry({...link, label: 'Apply : Early Career - Test Engineer, Vehicle Hardware'}, [], job), false);
  assert.equal(platformApplyLink({...link, href: 'https://careers-rivian.icims.com/jobs/99999/login'}, job), false);
  assert.equal(platformApplyLink({...link, href: 'https://evil.example/jobs/32131/login'}, job), false);
});
