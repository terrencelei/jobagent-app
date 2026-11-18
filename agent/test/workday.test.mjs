import test from 'node:test';
import assert from 'node:assert/strict';
import { stepOf, tenantOf, applyUrl, pickOption, resolveQuestion, matchWork, isAcknowledgement,
         reviewProblems, wordLimit, SOURCE_PATTERN, staleReference, openSignInForm } from '../src/workday.mjs';
import { recordApprovals } from '../src/companies.mjs';

test('the current step comes from its marker, not from the step names in the progress bar', () => {
  // Every page lists every step, so "My Information" is on the sign-in page too. Matching on it
  // declared a sign-in finished while the account was still being created.
  const signInPage = 'current step 1 of 8\nCreate Account/Sign In\nstep 2 of 8\nAutofill with Resume\nstep 3 of 8\nMy Information';
  assert.deepEqual(stepOf(signInPage), {n: 1, of: 8, name: 'Create Account/Sign In'});
  assert.equal(stepOf('current step 7 of 7\nReview').name, 'Review');
  assert.equal(stepOf('no wizard here'), null);
});

test('a tenant is the employer subdomain, and the apply page is derived from the posting', () => {
  const url = 'https://rollsroyce.wd3.myworkdayjobs.com/en-US/Intern_Graduate/job/Indianapolis/Engineering-and-Technology-Graduate-Program_JR6157064-1';
  assert.equal(tenantOf(url), 'rollsroyce');
  assert.equal(applyUrl(url), url + '/apply');
  assert.equal(applyUrl(url + '/apply'), url + '/apply');
  assert.throws(() => tenantOf('https://job-boards.greenhouse.io/icarus/jobs/1'));
});

test('options are matched to confirmed answers, never guessed', () => {
  const ethnicity = ['Select One', 'American Indian or Alaska Native (United States of America)', 'Asian (United States of America)',
    'Black or African American (United States of America)', 'Prefer not to say'];
  assert.equal(pickOption(ethnicity, ['Asian']), 'Asian (United States of America)');
  // An exact option beats a qualified one.
  assert.equal(pickOption(['Asian (Not Hispanic or Latino)', 'Asian'], ['Asian']), 'Asian');
  // "Select One" is the placeholder, not an answer, and nothing is chosen when no candidate is offered.
  assert.equal(pickOption(['Select One', 'Female', 'Male'], ['Male']), 'Male');
  assert.equal(pickOption(['Select One', 'Yes', 'No'], ['Prefer not to say']), null);
  // A prefix alone is not a match: "No" must not pick "Not applicable".
  assert.equal(pickOption(['Not applicable', 'Yes'], ['No']), null);
});

test('settled questions answer from the profile the runner passes; everything else waits for approval', () => {
  // tools/workday-run.mjs always passes his answers, so these come from the profile, not the legacy fallback rules.
  const answers = {citizenshipCountries: ['United States'], workAuthorizationCountries: ['United States'], requiresSponsorship: false,
    veteranStatus: 'I am not a protected veteran', clearanceEligibleYesNo: 'Yes', currentSecurityClearance: 'No', heldSecurityClearance: 'No'};
  const ask = q => resolveQuestion(q, {}, {company: 'Rolls-Royce', history: [{company: 'Applied Materials'}], answers})?.candidates[0];
  // The Rolls-Royce questionnaire, as worded on their tenant.
  assert.equal(ask('Are you one of the following (select one):'), 'U.S. Citizen or National');
  assert.equal(ask('Are you legally authorized to work in the United States?'), 'Yes');
  assert.equal(ask('Do you now or will you in the future need employer immigration sponsorship (H-1B, TN, etc.) in order to work in the U.S.?'), 'No');
  assert.equal(ask('Do you currently have an overall Grade Point Average above 3.0?'), 'Yes');
  assert.equal(ask('Have you previously completed an Internship with Rolls-Royce?'), 'No');
  assert.equal(ask('Please select any Veteran status which accurately describes yourself'), 'I am not a Veteran');
  // A clearance he could obtain is not one he holds.
  assert.equal(ask('Are you eligible to obtain a U.S. security clearance?'), 'Yes');
  assert.equal(ask('Do you currently hold an active security clearance?'), 'No');
  // Nobody has decided these, so they are held rather than answered.
  assert.equal(resolveQuestion('What is it about Rolls-Royce that makes you want to start a career with us?'), null);
  assert.equal(resolveQuestion('Within the past two (2) years, have you tested positive on a DOT drug test?'), null);
});

test('having worked for the employer is never answered for him', () => {
  const ctx = {company: 'Applied Materials', history: [{company: 'Applied Materials'}]};
  assert.equal(resolveQuestion('Have you previously worked for Applied Materials?', {}, ctx), null);
});

test('an approved answer is reused on the next posting that asks the same question', () => {
  const q = 'Are you a current or former government or military employee?';
  const bank = recordApprovals({company: '_shared', answers: {}}, [{question: q, answer: 'No', shared: true}], 'rollsroyce-JR6157064').answers;
  assert.deepEqual(resolveQuestion(`${q}*`, bank), {candidates: ['No'], source: 'approved', approvedFor: 'rollsroyce-JR6157064'});
});

test('the parser keeps start dates, so they identify a garbled work entry', () => {
  const history = [{company: 'Applied Materials', from: ['6', '2026']}, {company: 'Northrop Grumman', from: ['6', '2025']}];
  assert.equal(matchWork({fromMonth: '06', fromYear: '2025'}, history).company, 'Northrop Grumman');
  assert.equal(matchWork({fromMonth: '1', fromYear: '2020'}, history), null);
});

test('only acknowledgements are ticked, never opt-ins', () => {
  assert.equal(isAcknowledgement('Yes, I have read and consent to the terms and conditions'), true);
  assert.equal(isAcknowledgement('I have reviewed the privacy notice'), true);
  assert.equal(isAcknowledgement('I agree to receive SMS messages about my application and the privacy notice'), false);
  assert.equal(isAcknowledgement('Sign me up for job alerts'), false);
});

test('how-heard picks the employer site, word limits are read off the question, review gaps stop the run', () => {
  assert.ok(SOURCE_PATTERN.test('Rolls-Royce Careers Website'));
  assert.ok(SOURCE_PATTERN.test('Boeing Career Site'));
  assert.ok(!SOURCE_PATTERN.test('Social Media'));
  assert.equal(wordLimit('Tell us why. (Max 300 words)*'), 300);
  assert.equal(wordLimit('Tell us why.'), null);
  assert.deepEqual(reviewProblems('Work Experience\nNo Response\nSMS Opt-in\nYes'), ['Work Experience is empty', 'SMS opt-in is ticked']);
  assert.deepEqual(reviewProblems('Work Experience\nWork Experience 1\nJob Title'), []);
});

test('an essay that names the posting it was approved for is held on a different posting', () => {
  const essay = 'That is why the "design, make and verify" structure of the Engineering and Technology Graduate Program appeals to me.';
  assert.equal(staleReference(essay, 'Engineering and Technology Graduate Program', 'LibertyWorks Mechanical Systems Design Engineer'), true);
  assert.equal(staleReference(essay, 'Engineering and Technology Graduate Program', 'Engineering and Technology Graduate Program'), false);
  assert.equal(staleReference('I want to work on hardware that matters.', 'Engineering and Technology Graduate Program', 'LibertyWorks Mechanical Systems Design Engineer'), false);
});

// A fake page whose Create Account form shows its "Sign In" link only after `linkAfter` checks.
function fakeAuthPage({linkAfter = 0, switches = true} = {}) {
  const state = {form: 'create', checks: 0, clicks: 0};
  const locator = sel => ({
    first() { return this; },
    async waitFor() {},
    async count() { return sel.includes('signInLink') && state.form === 'create' && state.checks++ >= linkAfter ? 1 : 0; },
    async click() { state.clicks++; if (switches) state.form = 'signin'; },
    async isVisible() { return sel.includes('verifyPassword') ? state.form === 'create' : true; },
  });
  return {page: {locator}, state};
}

test('sign-in waits for the Sign In link instead of typing into Create Account', async () => {
  const late = fakeAuthPage({linkAfter: 2});
  assert.equal(await openSignInForm(late.page, {wait: async () => {}}), true);
  assert.equal(late.state.form, 'signin');
  const stuck = fakeAuthPage({linkAfter: 99});
  assert.equal(await openSignInForm(stuck.page, {wait: async () => {}}), false);
  const already = fakeAuthPage(); already.state.form = 'signin';
  assert.equal(await openSignInForm(already.page, {wait: async () => {}}), true);
  assert.equal(already.state.clicks, 0);
  const missing={locator:()=>({first(){return this;},async waitFor(){},async count(){return 0;},async isVisible(){return false;}})};
  assert.equal(await openSignInForm(missing,{wait:async()=>{},tries:2}),false,'an unavailable posting is not a sign-in form');
});

 test('sign-in accepts the opened email form even if a Sign In link remains mounted', async () => {
  let clicks = 0;
  const page = {locator: sel => ({first(){return this;}, async waitFor(){},
    async count(){return sel.includes('signInLink') ? 1 : 0;},
    async click(){clicks++;},
    async isVisible(){return !sel.includes('verifyPassword');}})};
  assert.equal(await openSignInForm(page, {wait: async()=>{}, tries:2}), true);
  assert.equal(clicks, 0);
 });

test('address state abbreviations match full state dropdown labels without a model call', () => {
 const resolved = resolveQuestion('State', {}, {answers:{addressState:'CA'}});
 assert.equal(pickOption(['Select One','California','Colorado'], resolved.candidates), 'California');
 assert.equal(resolveQuestion('State', {}, {answers:{}}), null);
});

test('country resolves the full country name before a phone-code option', () => {
 const r=resolveQuestion('Country', {}, {answers:{country:'United States'}});
 assert.equal(pickOption(['United States of America (+1)','United States of America'],r.candidates),'United States of America');
});

test('posting jurisdiction resolves conditional authorization guidance without treating foreign examples as facts',()=>{
 const q='Are you currently legally authorized to work in the country where this role is based? If this role is located in the United States, answer Yes/No for the United States. If this role is not located in the United States, answer for the other country.';
 assert.deepEqual(resolveQuestion(q,{}, {location:'Rome, NY',answers:{workAuthorizationCountries:['United States']}}).candidates,['Yes','I am authorized to work in the United States for any employer']);
 assert.equal(resolveQuestion(q,{}, {location:'London, United Kingdom',answers:{workAuthorizationCountries:['United States']}}),null);
 const family='To the best of your knowledge, is a family member employed by Booz Allen?';
 assert.equal(pickOption(['Yes','Not to my knowledge'],resolveQuestion(family,{}, {answers:{boozAllenPersonalConnections:'No'}}).candidates),'Not to my knowledge');
});

test('education and citizenship questions use confirmed facts rather than requesting them again',()=>{
 assert.equal(pickOption(["Bachelor's Degree","Master's Degree"],resolveQuestion('Degree',{}, {answers:{degree:"Bachelor's Degree"}}).candidates),"Bachelor's Degree");
 assert.equal(pickOption(['Engineering','Law'],resolveQuestion('Discipline',{}, {answers:{discipline:'Engineering - Mechanical',major:'Mechanical Engineering'}}).candidates),'Engineering');
 const ctx={location:'Berkeley, CA',answers:{citizenshipCountries:['United States'],currentSecurityClearance:'No',heldSecurityClearance:'No'}};
 assert.equal(pickOption(['Yes, I am currently a US Citizen','No, I am not a US Citizen'],resolveQuestion('This job requires a US Q security clearance. Can you confirm that you are currently a US Citizen?',{},ctx).candidates),'Yes, I am currently a US Citizen');
 assert.equal(pickOption(['Never held a clearance','Secret'],resolveQuestion('Active Security Clearance(s)',{},ctx).candidates),'Never held a clearance');
});

test('employer website source labels can name the confirmed employer acronym',()=>{
 const answer=resolveQuestion('How Did You Hear About Us?',{}, {company:'NXP Semiconductors'});
 assert.equal(pickOption(['Web - Indeed','Web - NXP','Employee Referral'],answer.candidates),'Web - NXP');
 assert.equal(pickOption(['Web - Other Employer','Employee Referral'],answer.candidates),null);
});
