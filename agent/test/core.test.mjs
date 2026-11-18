import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { filterJob, answersFor, resolveAnswers, fingerprint, assertApproval, receiptMatches, validatePlan, capExceeded } from '../src/core.mjs';
import {recordApprovals, questionId} from '../src/companies.mjs';
const job=JSON.parse(await readFile(new URL('../examples/jobs.json',import.meta.url)))[0];
const profile=JSON.parse(await readFile(new URL('../examples/profile.json',import.meta.url)));
const plan=JSON.parse(await readFile(new URL('../examples/plan.json',import.meta.url)));
test('jobagent screens timing and salary; unstated values are neutral here',()=>{
 assert.deepEqual(filterJob(job,profile.policy),[]);
 // jobagent sets unknown_start_date_is_neutral and only penalizes a stated salary below policy.
 assert.deepEqual(filterJob({...job,startDate:null,salary:undefined},profile.policy),[]);
 // A value the employer does state must still clear policy.
 assert.ok(filterJob({...job,startDate:'2027-03-01'},profile.policy).includes('start_date_not_compatible'));
 assert.ok(filterJob({...job,salary:{...job.salary,min:85000}},profile.policy).includes('stated_salary_below_policy'));
 // Without jobagent's verdict the job is held: this runner no longer derives eligibility itself.
 assert.ok(filterJob({...job,sourceEligibility:undefined},profile.policy).includes('source_eligibility_not_confirmed'));
 assert.ok(filterJob({...job,sourceEligibility:'INELIGIBLE'},profile.policy).includes('source_eligibility_not_confirmed'));
});
test('missing answers and ambiguous combobox verification stop preparation',()=>{
 assert.throws(()=>answersFor(plan,{answers:{}}));
 assert.throws(()=>validatePlan({...plan,fields:[{key:'gpa',type:'combobox',selector:'#gpa'}]}));
});
test('changed contact data or resume invalidates approval',()=>{
 const answers=answersFor(plan,profile), pdf=Buffer.from('resume');
 const hash=fingerprint(job,plan,answers,pdf), state={status:'approved',fingerprint:hash};
 assert.doesNotThrow(()=>assertApproval(state,hash));
 assert.throws(()=>assertApproval(state,fingerprint(job,plan,{...answers,email:'changed@example.com'},pdf)));
 assert.throws(()=>assertApproval(state,fingerprint(job,plan,answers,Buffer.from('different'))));
 assert.throws(()=>assertApproval({...state,status:'submitted'},hash));
});
test('receipt needs expected origin, path, and message',()=>{
 const rule=plan.confirmation;
 assert.equal(receiptMatches('https://example.com/confirmation',rule.text,rule,'https://example.com'),true);
 assert.equal(receiptMatches('https://other.example/confirmation',rule.text,rule,'https://example.com'),false);
 assert.equal(receiptMatches('https://example.com/jobs',rule.text,rule,'https://example.com'),false);
 assert.equal(receiptMatches('https://example.com/confirmation','Pending code',rule,'https://example.com'),false);
});

test('drafted wording is held until approved, then reused for the next posting',()=>{
 const essay={key:'accomplishment',type:'text',selector:'#essay',source:'approval',
              question:'Describe your single most impressive accomplishment',draft:'a draft'};
 const p2={...plan,fields:[...plan.fields,essay]};
 // First posting at a company: nothing approved yet, so the field is pending, not an error.
 const first=resolveAnswers(p2,profile,{});
 assert.equal(first.pending.length,1);
 assert.equal(first.pending[0].question,essay.question);
 assert.equal(first.answers.accomplishment,undefined);
 assert.throws(()=>answersFor(p2,profile,{}),/Awaiting your approval/);
 // Approving it once records it against the company, not the posting.
 const bank=recordApprovals({company:'Example',answers:{}},
   [{question:essay.question,answer:'his approved wording'}],'job-1');
 // A later posting asking the same question reuses it with no second approval.
 const second=resolveAnswers(p2,profile,bank.answers);
 assert.deepEqual(second.pending,[]);
 assert.equal(second.answers.accomplishment,'his approved wording');
 // A question the company has not asked before is still held.
 const p3={...plan,fields:[...plan.fields,{...essay,key:'other',question:'Something new?'}]};
 assert.equal(resolveAnswers(p3,profile,bank.answers).pending[0].question,'Something new?');
 // Wording matches regardless of an asterisk or spacing difference between postings.
 assert.equal(questionId('Describe  your single most impressive accomplishment*'),
              questionId('Describe your single most impressive accomplishment'));
});

test('a challenge answered in-run is not reported as blocked',()=>{
 // Residual prompt text on the page is not evidence the employer refused the application.
 // Reading it as a block is what caused a completed submission to be retried into a duplicate.
 const rule={urlIncludes:'/confirmation',text:'Your application has been received'};
 const stillShowsPrompt='Security code\nA verification code was sent to you.';
 assert.equal(receiptMatches('https://example.com/jobs/1',stillShowsPrompt,rule,'https://example.com'),false);
 // The page cannot confirm it either way, so the outcome must come from the mailbox.
 assert.equal(receiptMatches('https://example.com/confirmation',rule.text,rule,'https://example.com'),true);
});

test('an employer cap is reported once the window is full', () => {
  const policy = {applicationCaps: {SpaceX: {max: 2, days: 30}}};
  const now = new Date('2026-09-20T00:00:00Z');
  const subs = [
    {company: 'SpaceX', submittedAt: '2026-09-18T00:00:00Z'},
    {company: 'SpaceX', submittedAt: '2026-09-19T00:00:00Z'},
    {company: 'Vast Space', submittedAt: '2026-09-19T00:00:00Z'},
  ];
  const hit = capExceeded('SpaceX', policy, subs, now);
  assert.equal(hit.counted, 2);
  assert.equal(hit.nextEligible, '2026-10-18');
  assert.equal(capExceeded('Vast Space', policy, subs, now), null);
  assert.equal(capExceeded('SpaceX', policy, subs.slice(1), now), null);
});

test('submissions outside the window do not count toward a cap', () => {
  const policy = {applicationCaps: {SpaceX: {max: 1, days: 30}}};
  const now = new Date('2026-09-20T00:00:00Z');
  assert.equal(capExceeded('SpaceX', policy, [{company: 'SpaceX', submittedAt: '2026-08-01T00:00:00Z'}], now), null);
});

test('only explicitly reconciled nonacceptance releases employer cap capacity', () => {
  const policy = {applicationCaps: {Example: {max: 1, days: 90}}};
  const now = new Date('2026-10-16T00:00:00Z');
  const attempt = {company:'Example', submittedAt:'2026-10-12T00:00:00Z'};
  const rejected = {...attempt, status:'verification_not_accepted'};
  const original = structuredClone(rejected);
  assert.equal(capExceeded('Example', policy, [rejected], now), null);
  assert.deepEqual(rejected, original, 'audit history must remain intact');
  for (const status of [undefined, 'submitted', 'submitted_pending_receipt', 'submitting',
    'submission_unknown', 'needs_human_verification', 'awaiting_verification_code',
    'awaiting_human_submit', 'declined_application_limit', 'failed']) {
    assert.equal(capExceeded('Example', policy, [{...attempt,status}], now)?.counted, 1, String(status));
  }
  assert.equal(capExceeded('Example', policy, [rejected, attempt], now)?.counted, 1);
});

test('human handoff preserves the approved blocked package and refuses uncertain or completed attempts', async () => {
  const {assertHumanHandoff}=await import('../src/core.mjs');
  const state={status:'needs_human_verification',fingerprint:'reviewed',company:'Example'};
  const original=structuredClone(state);
  assert.doesNotThrow(()=>assertHumanHandoff(state,'reviewed'));
  assert.deepEqual(state,original);
  assert.throws(()=>assertHumanHandoff(state,'changed'),/differs/);
  for(const status of ['new','prepared','approved','submitting','submitted','submitted_pending_receipt','submission_unknown','awaiting_human_submit'])
    assert.throws(()=>assertHumanHandoff({...state,status},'reviewed'),/reconcile/);
});
