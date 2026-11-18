import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {safeNavigation, isApplicationEntry} from '../src/dashboard-worker.mjs';

const job = {title: 'Robotics Systems Engineer I, Robotics Delivery and Packaging Innovation (RDPI) - Tech Deployment', url: 'https://www.amazon.jobs/en/jobs/10593764/robotics-systems-engineer-i'};

test('Amazon "Apply now for <title>" opens the application (job 15083)', () => {
  const label = `Apply now for ${job.title}`;
  assert.equal(safeNavigation(label, job), true);
  assert.equal(isApplicationEntry({type: 'a', label}, [], job), true);
  assert.equal(safeNavigation('Apply now for Some Other Role', job), false, 'another title fails');
  assert.equal(safeNavigation(`Apply now for ${job.title} and others`, job), false);
});

test('the accessible name of a browser-rendered Amazon apply link passes the guard', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent(`<a id="apply-button" href="/applicant/jobs/10593764/apply" aria-label="Apply now for ${job.title}">Apply now</a>`);
    const name = await page.locator('#apply-button').evaluate(e => e.getAttribute('aria-label'));
    assert.equal(safeNavigation(name, job), true);
  } finally { await browser.close(); }
});

test('Honda "Apply Now <title>" opens the application (job 15037)', () => {
  const hj = {title: 'HVAC Mechanical Design Engineer', url: 'https://careers.honda.com/us/en/job/13175/HVAC-Mechanical-Design-Engineer'};
  const label = `Apply Now ${hj.title}`;
  assert.equal(safeNavigation(label, hj), true);
  assert.equal(isApplicationEntry({type: 'a', label}, [], hj), true);
  assert.equal(safeNavigation('Apply Now Some Other Role', hj), false);
  assert.equal(safeNavigation(`Apply Now ${hj.title} and others`, hj), false);
});
