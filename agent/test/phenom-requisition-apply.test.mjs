import test from 'node:test';
import assert from 'node:assert/strict';
import {safeNavigation} from '../src/dashboard-worker.mjs';

test('a Phenom apply button named after the posting requisition id passes the navigation gate', () => {
  const job = {title: 'Machine Learning Engineer (AI Enablement)', url: 'https://careers.gene.com/us/en/job/202610-127752/Machine-Learning-Engineer-AI-Enablement'};
  assert.equal(safeNavigation('Apply for GENEUS202610127752EXTERNALENUS', job), true);
  assert.equal(safeNavigation('Apply for \u200bGENEUS202610127752EXTERNALENUS\u200b', job), true, 'invisible characters');
  assert.equal(safeNavigation('Apply for GENEUS202610999999EXTERNALENUS', job), false, 'another requisition fails');
  assert.equal(safeNavigation('Apply Now for GENEUS202610127752EXTERNALENUS', job), true);
  assert.equal(safeNavigation('Apply for GENEUS9202610127752EXTERNALENUS', job), false, 'equality, not substring');
  assert.equal(safeNavigation('Apply for GENEUS202610127752 and withdraw others', job), false);
  assert.equal(safeNavigation('Apply for GENEUS202610127752EXTERNALENUS', {title: 'X', url: 'https://careers.gene.com/us/en/search'}), false);
  assert.equal(safeNavigation('Apply for Machine Learning Engineer (AI Enablement)', job), true);
});

import {platformApplyLink, isApplicationEntry} from '../src/dashboard-worker.mjs';
test('iCIMS "Apply : <title>" link to the posting\'s own iCIMS login is followed (Garmin 14163)', () => {
  const job = {title: 'Mechanical Engineer 1', url: 'https://careers.garmin.com/jobs/20477/job?utm_source=indeed'};
  const link = {type: 'a', label: 'Apply : Mechanical Engineer 1', href: 'https://careers-garmin.icims.com/jobs/20477/login'};
  assert.equal(isApplicationEntry(link, [], job), true);
  assert.equal(platformApplyLink(link, job), true);
  assert.equal(platformApplyLink({...link, href: 'https://careers-garmin.icims.com/jobs/99999/login'}, job), false);
  assert.equal(platformApplyLink({...link, href: 'https://evil.example/jobs/20477/login'}, job), false);
  assert.equal(isApplicationEntry({...link, label: 'Apply : Other Job'}, [], job), false);
});

test('a Phenom button naming the short /job/<id>/ number passes, other ids do not (Virgin Galactic 13400)', () => {
  const job = {title: 'Associate Engineer, Propulsion Operations', url: 'https://vgcareers.virgingalactic.com/global/en/job/2328/Associate-Engineer-Propulsion-Operations'};
  assert.equal(safeNavigation('Apply for VGNVGEUS2328EXTERNALENGLOBAL', job), true);
  assert.equal(safeNavigation('Apply Now for VGNVGEUS2328EXTERNALENGLOBAL', job), true, 'the posting page\'s Apply Now button');
  assert.equal(safeNavigation('Apply Now for VGNVGEUS2329EXTERNALENGLOBAL', job), false);
  assert.equal(safeNavigation('Apply for VGNVGEUS2328INTERNALENGLOBAL', job), false, 'an id without the EXTERNAL pattern fails');
  assert.equal(safeNavigation('Apply for 2328', job), false);
  assert.equal(safeNavigation('Apply for VGNVGEUS23280EXTERNALENGLOBAL', job), false, 'a longer number containing it fails');
  assert.equal(safeNavigation('Apply for VGNVGEUS12328EXTERNALENGLOBAL', job), false, 'digit run must match exactly');
  assert.equal(safeNavigation('Apply for VGNVGEUS2329EXTERNALENGLOBAL', job), false);
});
