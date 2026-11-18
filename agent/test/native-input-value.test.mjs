import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {nativeInputValue} from '../src/native-input-value.mjs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker} from '../src/dashboard-worker.mjs';

test('native date conversion preserves dates and leaves other controls unchanged', () => {
  assert.equal(nativeInputValue('date', '06/15/2027'), '2027-06-15');
  assert.equal(nativeInputValue('date', '2/29/2028'), '2028-02-29');
  assert.equal(nativeInputValue('date', '2027-06-15'), '2027-06-15');
  assert.equal(nativeInputValue('text', '06/15/2027'), '06/15/2027');
  assert.equal(nativeInputValue('date', 'June 2027'), 'June 2027');
  for (const date of ['02/29/2027', '04/31/2027', '13/01/2027', '00/15/2027', '01/00/2027', '01/01/0000']) {
    assert.throws(() => nativeInputValue('date', date), /valid calendar date/);
  }
});

test('worker fills a saved US date and reaches Review without submitting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-date-worker-'));
  const run = join(dir, 'run'), stateRoot = join(dir, 'state');
  await mkdir(run); await mkdir(stateRoot);
  let posts = 0, decisions = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') posts++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<form method="post"><label>Education end date<input type="date" value="2031-04-01" required></label><button type="submit">Submit application</button></form>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const profilePath = join(dir, 'profile.json'), resumePath = join(dir, 'resume.pdf');
  await writeFile(profilePath, JSON.stringify({answers: {graduationDate: '04/23/2031'}}));
  await writeFile(resumePath, 'fixture');
  await writeFile(join(run, 'request.json'), JSON.stringify({job: {id: 999999, company: 'Fixture', title: 'Engineer', url}, profilePath, resumePath, engine: 'claude', parkQuestions: true, autoSubmit: false}));
  const execImpl = async (_command, _args, prompt) => {
    const controls = JSON.parse(prompt).page.frames.flatMap(f => f.controls);
    const first = decisions++ === 0;
    const control = controls.find(c => c.type === (first ? 'date' : 'submit'));
    return {code: 0, stderr: '', stdout: JSON.stringify({structured_output: {action: first ? 'fill' : 'review', control: control.id, fact: first ? 'graduationDate' : '', message: ''}, usage: {}})};
  };
  try {
    await runWorker(run, {execImpl, stateRoot, allowLocalFixture: true});
    const state = JSON.parse(await readFile(join(run, 'state.json'), 'utf8'));
    assert.equal(state.status, 'ready_to_submit', state.message);
    assert.equal(decisions, 2);
    assert.equal(posts, 0);
    assert.match(JSON.stringify(state.review), /2031-04-23/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, {recursive: true, force: true});
  }
});

test('Chromium reproduces Siemens malformed fill and retains normalized date with native events', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    await page.setContent('<label>End date<input type="date" value="2027-06-01" data-ja-control="f0c98" required></label><script>window.changes=[];document.querySelector("input").addEventListener("input",e=>changes.push(e.target.value))</script>');
    const field = page.locator('[data-ja-control="f0c98"]');
    await assert.rejects(field.fill('06/15/2027'));  // the browser refuses a non-ISO date; its wording is Playwright's
    // Playwright clears the input before rejecting the malformed value.
    assert.equal(await field.inputValue(), '');
    await page.evaluate(() => { window.changes = []; });
    await field.fill(nativeInputValue('date', '06/15/2027'));
    assert.equal(await field.inputValue(), '2027-06-15');
    assert.deepEqual(await page.evaluate(() => window.changes), ['2027-06-15']);
    assert.equal(await field.evaluate(el => el.checkValidity()), true);
  } finally { await browser.close(); }
});

test('month-precision work-history dates fill native date inputs on the first of the month', () => {
  assert.equal(nativeInputValue('date', '6/2026'), '2026-06-01');
  assert.equal(nativeInputValue('date', '2025-08'), '2025-08-01');
  assert.equal(nativeInputValue('date', '2026-06-01'), '2026-06-01');
  assert.throws(() => nativeInputValue('date', '13/2026'));
  assert.equal(nativeInputValue('text', '6/2026'), '6/2026');
});

import {approvedValue as approvedValueFor} from '../src/dashboard-worker.mjs';
test('month inputs get YYYY-MM and a month-only work-history fact fills with the whole date', () => {
  assert.equal(nativeInputValue('month', '6/2026'), '2026-06');
  assert.equal(nativeInputValue('month', '2026-6'), '2026-06');
  assert.equal(nativeInputValue('month', '2026-06'), '2026-06');
  assert.throws(() => nativeInputValue('month', '13/2026'), /valid calendar date/);
  const profile = {workHistory: [{company: 'Example', from: ['6', '2026'], to: ['9', '2026']}]};
  const fill = (type, fact) => approvedValueFor({action: 'fill', fact}, {label: 'From', type}, profile, {}, new Map());
  assert.equal(fill('month', 'workHistory.0.from.0'), '6/2026');
  assert.equal(fill('date', 'workHistory.0.to.1'), '9/2026');
  assert.equal(fill('text', 'workHistory.0.from.0'), '6');
  assert.equal(fill('month', 'workHistory.0.from'), '6/2026');
});
