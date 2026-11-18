'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshot, statusLine, decideNotifications } = require('../status');

const payload = (running, active, completed, approvals = 0, help = 0) =>
  ({ running, counts: { active, completed, approvals, help } });

test('snapshot normalises missing and bad counts', () => {
  assert.equal(snapshot(null), null);
  assert.deepEqual(snapshot({ counts: { active: '2', completed: -1 } }),
    { running: false, active: 2, completed: 0, approvals: 0, help: 0 });
});

test('status line text', () => {
  assert.equal(statusLine(payload(true, 2, 14)), 'Applying · 2 active · 14 submitted');
  assert.equal(statusLine(payload(false, 0, 3)), 'Paused · 3 submitted');
  assert.equal(statusLine(payload(false, 1, 3)), 'Paused · 1 active · 3 submitted');
  assert.equal(statusLine(payload(true, 0, 0, 1, 0)), 'Applying · 0 active · 0 submitted · 1 needs you');
  assert.equal(statusLine(payload(true, 1, 5, 2, 1)), 'Applying · 1 active · 5 submitted · 3 need you');
  assert.equal(statusLine(null), 'Starting engine…');
  assert.equal(statusLine(payload(true, 1, 1), { error: true }), 'Engine not responding');
});

test('first poll only sets a baseline', () => {
  assert.deepEqual(decideNotifications(null, payload(true, 2, 14, 3, 1)), []);
});

test('notification decisions across successive polls', () => {
  const polls = [
    payload(true, 2, 10),
    payload(true, 2, 10),        // nothing changed
    payload(true, 1, 11),        // one submitted
    payload(true, 0, 14, 1),     // three submitted + one approval
    payload(true, 0, 14, 0, 0),  // approval handled: no notification
    payload(true, 0, 14, 0, 2),  // two need help
    payload(false, 0, 12, 0, 2), // history pruned: no notification
  ];
  const seen = [];
  for (let i = 1; i < polls.length; i++) seen.push(decideNotifications(polls[i - 1], polls[i]));

  assert.deepEqual(seen[0], []);
  assert.equal(seen[1].length, 1);
  assert.equal(seen[1][0].title, 'Application submitted');
  assert.equal(seen[1][0].body, '1 new application was submitted.');
  assert.equal(seen[2].length, 2);
  assert.equal(seen[2][0].body, '3 new applications were submitted.');
  assert.equal(seen[2][1].title, 'JobAgent needs you');
  assert.equal(seen[2][1].path, '/approvals');
  assert.equal(seen[2][1].body, '1 answer to approve.');
  assert.deepEqual(seen[3], []);
  assert.equal(seen[4].length, 1);
  assert.equal(seen[4][0].kind, 'needs-you');
  assert.equal(seen[4][0].body, '2 applications need help.');
  assert.deepEqual(seen[5], []);
});

test('approvals and help together make one notification', () => {
  const n = decideNotifications(payload(true, 0, 0), payload(true, 0, 0, 2, 1));
  assert.equal(n.length, 1);
  assert.equal(n[0].body, '2 answers to approve and 1 application needs help.');
});
