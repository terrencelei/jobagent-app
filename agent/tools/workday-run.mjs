import {collectWebpageAcceptance} from '../src/application-acceptance.mjs';
import {regionalProfile} from '../src/location-policy.mjs';
import {shouldApproveOptionalWriting} from '../src/application-writing-policy.mjs';
import {readWorkdayListboxOptions,readWorkdayFields,verifyWorkdayCheckboxChoice,selectWorkdayListbox,fillWorkdaySignedDate,fillWorkdaySkills,sentResumeSkills,workdayDateAnswer,fillWorkdayDate} from '../src/workday-controls.mjs';
import {openWorkdayBrowser} from '../src/workday-browser.mjs';
import {sameStep,waitForStep,workdayFormReady,goBackWorkday} from '../src/workday-navigation.mjs';
import {isResumeOnlyExperience} from '../src/workday-experience-layout.mjs';
import {reconcileWorkdayHistory,readWorkdayHistory,historyProblems,savedWorkdayHistoryProblems,historyFingerprint,ensureWorkdayEducationRows,educationDegreeMismatches} from '../src/workday-history.mjs';
import { chooseWorkdayPrompt, chooseWorkdaySourcePrompt } from '../src/workday-prompt.mjs';
import { normalizeApplicationLink, normalizeExistingLinks } from '../src/application-links.mjs';
import {openWorkdayApplicationPage} from '../src/workday-opening.mjs';
import {alreadyAppliedNotice} from '../src/already-applied.mjs';
import {settleWorkdayQuestions,continueWorkdayPreparation} from '../src/workday-preparation.mjs';
// Apply to a Workday posting headlessly, from sign-in to the review page, and submit only when
// asked. Workday is a signed-in wizard rather than a form, so the run is a loop: read which step
// the wizard is on, fill what that step asks from the profile and the approved answers, save, and
// look again. The run stops, with the reason in state/<job>.json, whenever someone has to decide:
//
//   needs_account       not signed in, or the saved sign-in session has expired
//   needs_verification  Workday emailed a link that has to be opened (put it in state/<job>.verifylink)
//   needs_approval      a question nobody has answered yet (artifacts/<job>/approval-request.json)
//   blocked             Workday refused to leave a step; its errors are recorded
//   throttled           Workday's error page stayed after a refresh (it is slowing this browser down)
//   at_review           everything is filled and the review page read back cleanly
//   submitted           submitted from the review page (only with --submit)
//
// Usage: node tools/workday-run.mjs JOBS.json PROFILE.json JOB_ID [--submit]
//
// Workday's session cookies (CALYPSO_SESSION, PLAY_SESSION) are session-only, so no saved browser
// profile keeps him signed in between runs: every headless run signs in. The password is read
// only from files Alex writes himself: private/credentials.json "workday-<tenant>" for a tenant
// where his password differs, else his shared WORKDAY_PASSWORD in private/workday.env. This script
// never asks for one and never prints one. A profile is still kept per tenant in
// private/workday-profiles/<tenant> so Cloudflare sees a returning browser.
// On a tenant where he has no account, one is created with his email and the shared password.
import { applicationChromium } from '../src/captcha-vendor.mjs';
const chromium = await applicationChromium();
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
import { loadAnswers, lookup as lookupBank } from '../src/companies.mjs';
import { resolveUnknownQuestion, setCheckedControl, execCLI } from '../src/dashboard-worker.mjs';
import { meterExec, addUsage } from '../src/usage-meter.mjs';
import { mapConfirmedOption } from '../src/option-mapping.mjs';
import { sharedWorkdayPassword } from '../src/workday-env.mjs';
import { startLiveView } from '../src/live-view.mjs';
import { fetchVerifyLink, fetchResetLink } from '../src/workday-mail.mjs';
import { redactPasswordDump } from '../src/redact-html.mjs';
import {fillWorkdaySignInCredentials,submitWorkdaySignIn,workdayAuthScope,completeWorkdayAccountCreation,workdaySignedIn} from '../src/workday-auth-form.mjs';
import {assertWorkdayPostingAvailable, openAvailableWorkdaySignInForm as openSignInForm} from '../src/workday-availability.mjs';
import { stepOf, tenantOf, applyUrl, pickOption, resolveQuestion, needsWorkdayAnswer, DEGREE_CANDIDATES,
         isAcknowledgement, reviewProblems, wordLimit, staleReference } from '../src/workday.mjs';
import { siteThrottled, throttledReason, throttlePauseMs } from '../src/throttle.mjs';
import { setting } from '../src/settings.mjs';
import { capAllowed, detectCap } from '../src/application-caps.mjs';

const [jobsPath, profilePath, jobId, ...flags] = process.argv.slice(2);
if (!jobsPath || !profilePath || !jobId) throw new Error('Usage: workday-run.mjs JOBS.json PROFILE.json JOB_ID [--submit]');
const SUBMIT = flags.includes('--submit');
const readJson = async p => JSON.parse(await readFile(p, 'utf8'));
const exists = p => access(p).then(() => true, () => false);

const allJobs = await readJson(jobsPath);
const job = allJobs.find(j => j.id === jobId);
if (!job) throw new Error(`No job ${jobId} in ${jobsPath}`);
const profile = regionalProfile(await readJson(profilePath),job);
const resumeSkills=profile.resumeSkills?.sha256===createHash('sha256').update(await readFile(profile.resumePath)).digest('hex')?profile.resumeSkills.list:
 sentResumeSkills(await readJson(`private/applications/${jobId.replace(/^jobagent-/,'')}/resume.json`).catch(()=>null));
const A = profile.answers;
const tenant = tenantOf(job.url);
const {answers: bank} = await loadAnswers('private/companies', job.company);
const ctx = {...job, company: job.company, location: job.location, country: job.country, history: profile.workHistory ?? [], answers: A, confirmedFactSources:profile.confirmedFactSources};
const questionAgent = process.env.JOBAGENT_QUESTION_AGENT ? await readJson(process.env.JOBAGENT_QUESTION_AGENT) : null;
ctx.approvedAnswers=questionAgent?.approvedAnswers??[];
const agentDecisions = new Map();
// Every model call this run makes is metered into artifacts/<job>/model-usage.json, which dashboard-workday copies
// into the run's state for the cost page (lesson 433: Workday applications all read $0.00).
const usageTotals = {usage: {input_tokens: 0, output_tokens: 0}, model_usage: {}};
const meteredExec = meterExec(execCLI, async (via, usage) => {
  addUsage(usageTotals, via, usage);
  await writeFile(`artifacts/${jobId}/model-usage.json`, JSON.stringify(usageTotals)).catch(() => {});
}, {engine: questionAgent?.engine, model: questionAgent?.model});
async function agentAnswer(question) {
  if (!questionAgent) return null;
  const key = JSON.stringify([question.label, question.kind, question.options]);
  if (agentDecisions.has(key)) return agentDecisions.get(key);
  console.log(`Consulting ${questionAgent.engine} for unfamiliar question: ${question.label}`);
  const result = await resolveUnknownQuestion({question: {...question, type: question.kind === 'textarea' ? 'textarea' : 'text'},
    profile, bank, job, engine: questionAgent.engine, command: questionAgent.command, model: questionAgent.model, execImpl: meteredExec});
  const answer = result.resolved ? {candidates:[result.value], source:'approved', approvedFor:jobId} : null;
  agentDecisions.set(key, answer);
  console.log(result.resolved ? `Agent matched a confirmed answer for: ${question.label}` : `Agent needs your information for: ${question.label}`);
  return answer;
}
const dir = `artifacts/${jobId}`;
await mkdir(dir, {recursive: true, mode: 0o700});
await writeFile(`${dir}/model-usage.json`, JSON.stringify(usageTotals));  // this run's usage only
await mkdir('state', {recursive: true});

const statePath = `state/${jobId}.json`;
const state = (await exists(statePath)) ? await readJson(statePath) : {};
const setState = async (status, extra = {}) => {
  Object.assign(state, {status, company: job.company, tenant, updatedAt: new Date().toISOString(), ...extra});
  await writeFile(statePath, JSON.stringify(state, null, 2));
  console.log(`${jobId}: ${status}${extra.reason ? ` (${extra.reason})` : ''}`);
};
if (['submitted','submitted_pending_receipt','submitting','submission_unknown'].includes(state.status)) { console.log(`${jobId}: already submitted ${state.submittedAt}; nothing to do`); process.exit(0); }

// WORKDAY_CDP attaches to a browser the applicant is already signed into (a held window) instead
// of launching one; the run then leaves that browser open when it finishes.
const CDP = process.env.WORKDAY_CDP;
const attached = CDP ? await chromium.connectOverCDP(CDP) : null;
const ctxBrowser = attached ? attached.contexts()[0] : await openWorkdayBrowser(chromium,`private/workday-profiles/${tenant}`, {
  onEvent:message=>console.log(message),headless: process.env.APPLICATION_AGENT_HEADED !== '1', viewport: {width: 1280, height: 1000}});
console.log('Workday browser ready');
const page = ctxBrowser.pages().find(p => /myworkdayjobs/.test(p.url())) ?? ctxBrowser.pages()[0] ?? await ctxBrowser.newPage();
page.setDefaultTimeout(20000);
// Run from the dashboard, the page is also streamed live into the worker's preview.
const live = process.env.JOBAGENT_LIVE_FRAME ? await startLiveView(ctxBrowser, page, process.env.JOBAGENT_LIVE_FRAME) : null;
const pause = ms => page.waitForTimeout(ms);
const body = async () => (await page.locator('body').innerText().catch(() => '')).replace(/\n{2,}/g, '\n');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = s => new RegExp(`^\\s*${esc(s)}\\s*$`);
let exitCode = 0, submissionAttempted = false, historyVerified = false, historyRequired = true;

// Workday lays a transparent overlay over its buttons; the click has to be forced onto the button.
const press = async aid => {
  const b = page.locator(`button[data-automation-id="${aid}"]`).first();
  if (!await b.count()) return false;
  await b.click({force: true}); return true;
};
// The account button renders late or not at all on some pages; the header naming his email and
// Candidate Home is there as soon as the page is.
const signedIn = () => workdaySignedIn(page, process.env.WORKDAY_EMAIL || A.email);
const snapshot = async name => {
  await page.screenshot({path: `${dir}/${name}.png`, fullPage: true}).catch(() => {});
  const menus = await page.evaluate(() => [...document.querySelectorAll('[data-automation-id="promptOption"], [role="option"]')].filter(e => e.getClientRects().length).map(e => ({text:e.innerText, ancestors:[e,e.parentElement,e.parentElement?.parentElement,e.parentElement?.parentElement?.parentElement].filter(Boolean).map(p => ({id:p.id,role:p.getAttribute('role'),aid:p.getAttribute('data-automation-id')}))}))).catch(()=>[]);
  // React mirrors typed values into the value attribute, so a dump taken after sign-in would hold
  // the password (Boeing 11181); redact every password input before anything is written.
  const sourceHTML = redactPasswordDump(await page.locator('[data-automation-id="formField-source"]').evaluateAll(es=>es.map(e=>e.outerHTML)).catch(()=>[]));
  await writeFile(`${dir}/${name}-source.json`,JSON.stringify(sourceHTML),{mode:0o600});
  const fieldHTML=redactPasswordDump(await page.locator('[data-automation-id^="formField-"]').evaluateAll(es=>es.map(e=>({aid:e.getAttribute('data-automation-id'),html:e.outerHTML}))).catch(()=>[]));
  await writeFile(`${dir}/${name}-fields.json`,JSON.stringify(fieldHTML),{mode:0o600});
  await writeFile(`${dir}/${name}-menus.json`, JSON.stringify(menus,null,2),{mode:0o600});
};

// A listbox (button that opens "Select One | Yes | No") and a prompt (searchable, possibly nested
// menu) are Workday's two single-choice widgets, and each needs its own handling.
// Menus fill in after they open, sometimes seconds later; reading them too early recorded no
// options at all, which left him typing answers the menu would not take.
async function chooseListbox(button, candidates) {
  const res=await selectWorkdayListbox(page,button,candidates);
  if(res.technical)throw new Error(res.note);
  return res;
}
let lastOffered = []; // deepest offered choices, including unmatched nested options
async function choosePrompt(input, pick, {search} = {}) {
  lastOffered = [];
  const source=(await input.getAttribute('id'))==='source--source';
  return (source ? chooseWorkdaySourcePrompt : chooseWorkdayPrompt)(page, input, pick, {
     search, onOptions: offered => { lastOffered = offered; },
     onDiagnostics: async data => writeFile(`${dir}/prompt-${(await input.getAttribute('id')||'unknown').replace(/[^a-z0-9-]/gi,'_')}-diagnostics.json`,JSON.stringify(data,null,2),{mode:0o600}),
   });
}
// Workday draws its own radio buttons over hidden inputs, so a forced check() on the input often
// does not register (Leidos, AeroVironment). Close any open menu first, then try the input, its
// label, and a DOM click, and report whether the choice actually stuck.
async function chooseRadio(name, index) {
  const input = page.locator(`input[name="${name}"]`).nth(index);
  await page.keyboard.press('Escape').catch(() => {}); await pause(300);
  await input.scrollIntoViewIfNeeded().catch(() => {});
  const attempts = [
    () => input.check({force: true, timeout: 4000}),
    async () => { const id = await input.getAttribute('id'); if (id) await page.locator(`label[for="${id}"]`).first().click({force: true, timeout: 4000}); },
    () => input.evaluate(el => el.click()),
  ];
  for (const attempt of attempts) {
    await attempt().catch(() => {});
    await pause(400);
    if (await input.isChecked().catch(() => false)) return true;
  }
  return false;
}

// Date segments and other spinbuttons reject clicks outside the viewport and swallow fill(); typing
// into the focused element is what sticks. A one-digit month waits for a second digit, so pad it.
async function typeInto(locator, value) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  // Control+A on macOS jumps to the line start and would collapse a Cmd+A selection, so pick one.
  await locator.focus(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(String(value), {delay: 40}); await page.keyboard.press('Tab'); await pause(400);
  return locator.inputValue().catch(() => '');
}
const setText = async (id, value) => {
  const el = page.locator(`[id="${id}"]`);
  if (!await el.count() || (await el.inputValue()) === value) return;
  const got = await typeInto(el, value);
  if (got !== value) console.log(`  ! ${id} reads "${got}" after typing "${value}"`);
};

// Every visible question on the step, with its label read from its form-field container: the
// control's own label is often just "Select One Required".
const fields=()=>readWorkdayFields(page);

// Answer whatever on this step is settled or approved; return what nobody has decided.
async function answerQuestions() {
  const pending = [...educationPending];
  educationPending = [];
  await normalizeExistingLinks(page);
  for (const f of await fields()) {
    if (!f.label) continue;
    if (EDUCATION_ROW.test(f.id ?? '')) continue;
    // Segmented dates: only a confirmed profile date is typed; history/education dates have their
    // own drivers, and an unknown date is never guessed or sent to the agent.
    if (f.kind === 'date') {
      const d = workdayDateAnswer(f.label, ctx.answers, ctx.approvedAnswers);
      if (d && !(await fillWorkdayDate(page, page.locator(`[id=${JSON.stringify(f.id)}]`), d)))
        pending.push({...f, question:f.label.replace(/\*\s*$/, '').trim(), note:'Workday did not keep the confirmed date'});
      // A required date with no confirmed answer goes to Approvals instead of stalling the step.
      else if (!d && f.required && !f.value)
        pending.push({...f, question:f.label.replace(/\*\s*$/, '').trim(), note:'Required date with no confirmed answer'});
      continue;
    }
    // Older rules answered an optional ID text field with the prior-employment
    // answer "No". Remove that placeholder for a confirmed external applicant.
    if(f.kind==='text'&&!f.required&&/^Employee ID \(if applicable\)\s*\*?$/i.test(f.label)&&f.value==='No'&&resolveQuestion('Have you worked with us before?',bank,ctx)?.candidates[0]==='No'){
      await page.locator(`[id=${JSON.stringify(f.id)}]`).fill('');continue;
    }
    const q = f.label.replace(/\*\s*$/, '').trim();
    // A closed listbox hides its choices from the fact rules, the agent and the approval card
    // (ASML "Please indicate your current status."); read them before anything decides.
    if (f.kind === 'listbox' && f.required && !f.value && !f.options?.length) f.options = await readWorkdayListboxOptions(page, page.locator(`button[id="${f.id}"]`));
    const known = resolveQuestion(q, bank, {...ctx,options:f.options});
    const optionalWriting = shouldApproveOptionalWriting({...f,label:q});
    if(!optionalWriting&&!needsWorkdayAnswer(f,known))continue;
    if(['text','textarea','listbox','prompt'].includes(f.kind)){
      const current=page.locator(`[id=${JSON.stringify(f.id)}]`);
      if(!await current.count()||!await current.isVisible())continue;
    }
    if (optionalWriting) Object.assign(f,{required:true,employerRequired:false,
      approvalReason:'Optional application-strengthening answer requested for review'});
    if (optionalWriting && known?.source !== 'approved') {
      pending.push({...f, question:q, maxWords:wordLimit(q)});
      continue;
    }
    if (f.kind === 'checkbox') {
      if (f.required && isAcknowledgement(q)) await setCheckedControl(page,page.locator(`[id="${f.id}"]`),true);
      else if (f.required) {
        const answer = await agentAnswer({...f, label:q, options:['Yes','No']});
        if (answer && ['Yes','No','true','false'].includes(answer.candidates[0]))
          await page.locator(`[id="${f.id}"]`).setChecked(['Yes','true'].includes(answer.candidates[0]));
        else pending.push({...f, question:q});
      }
      continue;
    }
    if (!known && !f.required) continue;
    const r = known ?? await agentAnswer({...f, label:q});
    if (!r) { if (f.required || f.kind === 'textarea') pending.push({...f, question: q, maxWords: wordLimit(q)}); continue; }
    if (f.kind === 'listbox') {
      const res = await chooseListbox(page.locator(`button[id="${f.id}"]`), r.candidates);
      if (!res.ok) {
        const inferred = await agentAnswer({...f, label:q, options:res.offered});
        if (!inferred || !(await chooseListbox(page.locator(`button[id="${f.id}"]`), inferred.candidates)).ok)
          pending.push({...f, question:q, options:res.offered, note:'No confirmed answer matches the offered options'});
      }
    } else if (f.kind === 'prompt') {
      let offeredChoices = [];
      const search=/^(school|school or university)\s*\*?$/i.test(q)?A.schoolSearch:undefined;
      let got = await choosePrompt(page.locator(`[id="${f.id}"]`), offered => { offeredChoices = offered; return pickOption(offered, r.candidates); },{search});
      if (!got) {
        if(search)throw new Error('School dropdown did not resolve the confirmed university; retrying the search');
        const inferred = await agentAnswer({...f, label:q, options:offeredChoices});
        if (inferred) got = await choosePrompt(page.locator(`[id="${f.id}"]`), offered => pickOption(offered, inferred.candidates),{search});
      }
      if (!got) {
        if(lastOffered.length&&lastOffered.every(o=>/^(No Items\.?|No results|Loading.*)$/i.test(o)))throw new Error('Workday menu did not load valid options; retrying instead of requesting an answer');
        pending.push({...f, question: q, options: lastOffered.length ? lastOffered : undefined, note: 'No confirmed answer was saved; choose from the offered options'}); continue;
      }
    } else if (f.kind === 'radio'||f.kind==='choice-checkbox') {
      let want = pickOption(f.options, r.candidates);
      if (!want) {
        const inferred = await agentAnswer({...f, label:q});
        if (inferred) want = pickOption(f.options, inferred.candidates);
      }
      if (!want) pending.push({...f, question: q});
      else if(f.kind==='choice-checkbox'){
        for(const [i,id] of f.optionIds.entries())await setCheckedControl(page,page.locator(`[id=${JSON.stringify(id)}]`),i===f.options.indexOf(want));
        await verifyWorkdayCheckboxChoice(page,f.id,want);
      }else if (!await chooseRadio(f.id, f.options.indexOf(want))) pending.push({...f, question: q, note: `could not select "${want}"; Workday did not register the click`});
    } else if (f.kind === 'textarea' || f.kind === 'text') {
      // Free text is only ever his approved wording, typed verbatim and read back.
      // Settled profile facts (address, postal code) are typed; other text only as his approved wording.
      if (r.source === 'profile') {
        const el = page.locator(`[id="${f.id}"]`);
        if(f.invalid)await el.fill('');
        await el.fill(normalizeApplicationLink(r.candidates[0])); await el.press('Tab');
        if ((await el.inputValue()) !== normalizeApplicationLink(r.candidates[0])) pending.push({...f, question: q, note: 'profile value did not read back exactly'});
        continue;
      }
      if (r.source !== 'approved') { pending.push({...f, question: q}); continue; }
      const original = allJobs.find(j => j.id === r.approvedFor);
      if (r.approvedFor !== jobId && staleReference(r.candidates[0], original?.title, job.title)) {
        pending.push({...f, question: q, maxWords: wordLimit(q), draft: r.candidates[0],
          note: `approved for "${original.title}" and names it; needs wording for this posting`});
        continue;
      }
      const el = page.locator(`[id="${f.id}"]`);
      if(f.invalid)await el.fill('');
      await el.fill(normalizeApplicationLink(r.candidates[0])); await el.press('Tab');
      if ((await el.inputValue()) !== normalizeApplicationLink(r.candidates[0])) pending.push({...f, question: q, note: 'approved text did not read back exactly'});
    }
  }
  return pending;
}

async function myInformation() {
  await setText('name--legalName--firstName', A.firstName);
  await setText('name--legalName--lastName', A.lastName);
  const src = page.locator('input[id="source--source"]');
  if (await src.count() && !(await page.locator('[data-automation-id="formField-source"] [data-automation-id="selectedItem"]').count())) {
    const heard = resolveQuestion('How Did You Hear About Us?', bank, ctx);
    const got = await choosePrompt(src, offered => pickOption(offered, heard.candidates));
    console.log(`  how heard: ${got ?? 'no company-website option'}`);
  }
  const phoneType = page.locator('button[id="phoneNumber--phoneType"]');
  if (await phoneType.count() && /Select One/.test(await phoneType.innerText())) await chooseListbox(phoneType, resolveQuestion('Phone Device Type', bank, ctx).candidates);
  const code = page.locator('input[id="phoneNumber--countryPhoneCode"]');
  if (await code.count() && !(await page.locator('[data-automation-id="formField-countryPhoneCode"] [data-automation-id="selectedItem"]').count()))
    await choosePrompt(code, o => o.find(x => /United States of America \(\+1\)/.test(x)) ?? null, {search: 'United States'});
  await setText('phoneNumber--phoneNumber', A.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''));
}

// Education rows answered by myExperience; answerQuestions leaves these controls alone.
let educationPending = [];
const EDUCATION_ROW = /^education-\d+--(degree|fieldOfStudy|schoolName)$/;
async function mapEducation(label, options, key, value, row) {
  if (!questionAgent || !options?.length) return null;
  console.log(`Consulting ${questionAgent.engine} to match education row ${row + 1} ${label}: ${value}`);
  const mapped = await mapConfirmedOption({label, options, confirmed:{key, value}, facts:{education:profile.education, degree:A.degree}, job,
    engine:questionAgent.engine, command:questionAgent.command, model:questionAgent.model, execImpl:meteredExec});
  console.log(mapped.resolved ? `Agent matched education row ${row + 1} ${label}: ${mapped.value}` : `Agent found no ${label} option for ${value}`);
  return mapped.resolved ? mapped.value : null;
}

async function myExperience() {
  educationPending = [];
  // The resume is required here, but as a file input it never shows up as an unanswered question.
  if (await page.locator('input[type="file"]').count() && !/successfully uploaded/i.test(await body())) {
    await page.locator('input[type="file"]').first().setInputFiles(profile.resumePath); await pause(6000);
  }
  historyRequired = !await isResumeOnlyExperience(page);
  await reconcileWorkdayHistory(page,profile.workHistory,{
    onEvent:message=>console.log(message),
    onAudit:async(stage,rows)=>writeFile(`${dir}/work-history-${stage}.json`,JSON.stringify({fingerprint:historyFingerprint(profile.workHistory),rows},null,2),{mode:0o600}),
  });

  const edu = await ensureWorkdayEducationRows(page,profile.education);
  const chosenDegrees = [];
  for (const [i, n] of edu.entries()) {
    const e = profile.education[i]; if (!e) break;
    const school = page.locator(`[id="education-${n}--schoolName"]`);
    if (await school.count()) {
      if (await school.getAttribute('data-uxi-widget-type') === 'selectinput')
        await choosePrompt(school, o => o.find(x => /Springfield/i.test(x)) ?? null, {search: e.searchAs});
      else await setText(`education-${n}--schoolName`, e.school);
    }
    // Each row is filled from its own confirmed degree, never from an answer banked for another
    // employer's list. Wording the tenant uses differently ("BS", "Mechanical") is mapped by the
    // agent onto the offered options; only a row it cannot place goes to Approvals.
    const degree = page.locator(`button[id="education-${n}--degree"]`);
    if (await degree.count()) {
      const approved = lookupBank(bank, `Degree (${e.field})`)?.answer;
      const res = await chooseListbox(degree, approved ? [approved, ...DEGREE_CANDIDATES] : DEGREE_CANDIDATES);
      if (res.ok) chosenDegrees[i] = res.value;
      else {
        const mapped = await mapEducation('Degree', res.offered, `education.${i}.degree`, e.degree, i);
        if (mapped && (await chooseListbox(degree, [mapped])).ok) chosenDegrees[i] = mapped;
        else educationPending.push({id:`education-${n}--degree`, kind:'listbox', required:true, question:`Degree (${e.field})`, options:res.offered, note:`Confirmed: ${e.degree} in ${e.field}; no offered option matched`});
      }
    }
    const field = page.locator(`[id="education-${n}--fieldOfStudy"]`);
    const fieldSet = () => page.locator(`[data-automation-id="formField-fieldOfStudy"]`).nth(i).locator('[data-automation-id="selectedItem"]').count();
    if (await field.count() && !await fieldSet()) {
      const first = e.field.split(' ')[0];
      const approved = lookupBank(bank, `Field of Study (${e.field})`)?.answer;
      const offered = new Set();
      let got = null;
      for (const search of [...new Set([approved, e.field, first].filter(Boolean))]) {
        got = await choosePrompt(field, o => { o.forEach(x => offered.add(x)); return pickOption(o, [approved, e.field, first].filter(Boolean)); }, {search});
        if (got) break;
      }
      if (!got) {
        const mapped = await mapEducation('Field of Study', [...offered].filter(o => !/^(Partial List|All$|No Items|No results)/i.test(o)), `education.${i}.field`, e.field, i);
        if (mapped) got = await choosePrompt(field, o => pickOption(o, [mapped]), {search: mapped});
      }
      if (!got && !await fieldSet())
        educationPending.push({id:`education-${n}--fieldOfStudy`, kind:'prompt', required:true, question:`Field of Study (${e.field})`, options:[...offered].slice(0,60), note:`Confirmed field: ${e.field}; no offered option matched`});
    }
    if (i === 0) await setText(`education-${n}--gradeAverage`, A.gpaExact);
    for (const [part, val] of [['firstYearAttended', e.from[1]], ['lastYearAttended', e.to[1]]]) {
      const y = page.locator(`[id="education-${n}--${part}-dateSectionYear-input"]`);
      if (await y.count() && (await y.inputValue()) !== val) await typeInto(y, val);
    }
  }
  const skills=await fillWorkdaySkills(page,resumeSkills);
  if(skills.length)console.log(`Verified ${skills.length} skills from the selected original resume`);
  // Re-read every degree after the rest of the step is filled; a row that drifted from its
  // confirmed choice is set once more, and if it still drifts it parks instead of submitting.
  const shownDegrees = async () => Promise.all(edu.map(async n => { const b = page.locator(`button[id="education-${n}--degree"]`); return await b.count() ? (await b.innerText()).trim() : null; }));
  for (const i of educationDegreeMismatches(await shownDegrees(), chosenDegrees)) {
    console.log(`Education row ${i + 1} Degree changed after it was set; setting ${chosenDegrees[i]} again`);
    await chooseListbox(page.locator(`button[id="education-${edu[i]}--degree"]`), [chosenDegrees[i]]);
  }
  const shown = await shownDegrees();
  for (const i of educationDegreeMismatches(shown, chosenDegrees))
    educationPending.push({id:`education-${edu[i]}--degree`, kind:'listbox', required:true, question:`Degree (${profile.education[i].field})`, options:[chosenDegrees[i]], note:`Confirmed: ${profile.education[i].degree}; the form kept showing ${shown[i]}`});
}

// A tenant-specific entry wins because it exists exactly where his password differs (Boeing).
// Otherwise every tenant uses his email and the one password he keeps in private/workday.env.
async function credential() {
  const creds = (await exists('private/credentials.json')) ? await readJson('private/credentials.json') : {};
  const own = creds[`workday-${tenant}`] ?? Object.values(creds).find(c => c?.password && String(c.tenant ?? '').split('.')[0] === tenant) ?? creds['workday-default'];
  if (own) return {...own, shared: false};
  const password = await sharedWorkdayPassword();
  return password ? {email: process.env.WORKDAY_EMAIL || A.email, password, shared: true} : null;
}

// Some tenants (Hitachi, RTX) open on Apple/Google/LinkedIn buttons and hide the email form behind
// "Sign in with email". Single sign-on is never used; this only reveals the email form.
async function revealEmailForm(scope=page) {
  if (await scope.locator('[data-automation-id="email"]').first().isVisible().catch(() => false)) return;
  const byEmail = scope.locator('button, a, [role="button"]').filter({hasText: /^\s*(sign in|continue|log in) with email\s*$/i}).first();
  if (await byEmail.count()) { await byEmail.click({force: true}); await pause(2500); }
}

async function signIn(c) {
  if (!await openSignInForm(page)) {
    // A bot/rate-limit wall in place of the form is the employer's edge, not his account (12799).
    const wall = siteThrottled(await body());
    if (wall) { console.log(`Workday sign-in page showed a ${wall}`); return 'throttled'; }
    console.log('the Sign In form never replaced Create Account'); return 'unknown';
  }
  await revealEmailForm(await workdayAuthScope(page));
  const scope = await fillWorkdaySignInCredentials(page,c);
  if (!await submitWorkdaySignIn(scope)) { console.log('no Sign In button to press'); return 'unknown'; }
  await pause(9000);
  if (await signedIn()) return 'ok';
  const t = await body();
  if (/verify your (account|email)|verification (email|link)/i.test(t)) return 'needs_verification';
  if (/wrong email|incorrect|invalid|not match/i.test(t)) return 'rejected';
  // An unexplained result (KLA 10182, ASML 9067) left only the chooser screenshot; keep what
  // Workday showed right after Sign In. Alerts and URLs never contain the typed password.
  await snapshot('signin-after-submit');
  const alerts = await page.locator('[role="alert"]:visible, [data-automation-id*="rror"]:visible').allInnerTexts().catch(() => []);
  console.log(`Workday sign-in result unclear at ${page.url().split('?')[0]}${alerts.length ? `: ${alerts.join(' | ').replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  return 'unknown';
}

// An unverified account's sign-in page offers to resend the link; the old one expires after 24 hours.
async function resendVerification() {
  const resend = page.locator('button, a, [role="button"]').filter({hasText: /resend account verification/i}).first();
  if (!await resend.count()) return false;
  console.log('asking Workday to resend the verification email');
  await resend.click({force: true}); await pause(4000);
  await snapshot('resend');
  return true;
}

// Creating an account cannot clobber an existing one: Workday refuses a second account for the
// same email, which is exactly the case where his password for that tenant is different.
async function createAccount(c, {afterRejectedSignIn = false} = {}) {
  await revealEmailForm();
  if (await page.locator('button[data-automation-id="createAccountLink"]').count()) { await press('createAccountLink'); await pause(2500); }
  await revealEmailForm();
  await page.locator('[data-automation-id="email"]').first().fill(c.email);
  await page.locator('[data-automation-id="password"]').first().fill(c.password);
  await page.locator('[data-automation-id="verifyPassword"]').first().fill(c.password);
  const ack = page.locator('input[data-automation-id="createAccountCheckbox"]');
  if (await ack.count()) await ack.check({force: true});
  const filter = page.locator('div[data-automation-id="click_filter"][aria-label="Create Account"]').first();
  if (await filter.count()) await filter.click(); else await press('createAccountSubmitButton');
  await pause(10000);
  const result=await completeWorkdayAccountCreation(page,{signedIn,signIn:()=>signIn(c),afterRejectedSignIn});
  if(result!=='unknown')return result;
  await snapshot('create-account-after-submit');
  const alerts = await page.locator('[role="alert"]:visible, [data-automation-id*="rror"]:visible').allInnerTexts().catch(() => []);
  console.log(`Workday account creation result unclear at ${page.url().split('?')[0]}${alerts.length ? `: ${alerts.join(' | ').replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  return 'unknown';
}

// His instruction (2026-10-18): where an account exists with a password he does not have, use
// "Forgot your password?" and set the saved password. The reset link is read from his mailbox and
// must be on this Workday host; the password is typed by code and never logged.
async function resetPassword(c) {
  if (!await openSignInForm(page)) return 'unknown';
  await revealEmailForm(await workdayAuthScope(page));
  const forgot = page.locator('[data-automation-id="forgotPasswordLink"]:visible').first();
  if (!await forgot.count()) { console.log('no Forgot your password link on this tenant'); return 'exists'; }
  const after = Math.floor(Date.now() / 1000) - 60;
  await forgot.click({force: true}); await pause(2500);
  const email = page.locator('[data-automation-id="email"]:visible').first();
  if (!await email.count()) { console.log('the reset form has no email field'); return 'exists'; }
  await email.fill(c.email);
  const request = page.locator('[data-automation-id="resetPasswordSubmitButton"]:visible, div[data-automation-id="click_filter"][aria-label*="Reset" i]:visible, div[data-automation-id="click_filter"][aria-label*="Submit" i]:visible')
    .or(page.locator('button:visible').filter({hasText: /^\s*(?:reset password|submit|send|continue)\s*$/i})).first();
  if (!await request.count()) { console.log('no button to request the reset email'); await snapshot('reset-request'); return 'exists'; }
  await request.click({force: true}); await pause(4000);
  console.log('requested a Workday reset email; checking the mailbox for the link');
  const mailbox = questionAgent ? {engine: questionAgent.engine, command: questionAgent.command, model: questionAgent.model} : {};
  const link = await fetchResetLink(job.url, {...mailbox, after});
  if (!link) { console.log('no reset email arrived'); return 'exists'; }
  await page.goto(link, {waitUntil: 'domcontentloaded'}); await pause(6000);
  const fields = page.locator('input[type="password"]:visible');
  const count = await fields.count();
  if (count < 1 || count > 3) { console.log(`the reset page shows ${count} password fields; not guessing`); await snapshot('reset-page'); return 'exists'; }
  for (let i = 0; i < count; i++) await fields.nth(i).fill(c.password);
  const save = page.locator('div[data-automation-id="click_filter"][aria-label]:visible').filter({hasNotText: /cancel/i})
    .or(page.locator('button:visible').filter({hasText: /^\s*(?:reset password|submit|save|change password|continue|done)\s*$/i})).first();
  if (!await save.count()) { console.log('no button to save the new password'); await snapshot('reset-page'); return 'exists'; }
  await save.click({force: true}); await pause(6000); await snapshot('reset-after-submit');
  console.log('saved the new Workday credentials; signing in again');
  await page.goto(applyUrl(job.url), {waitUntil: 'domcontentloaded'}); await pause(7000);
  await startApplication();
  return await signedIn() ? 'ok' : await signIn(c);
}

// A session handed over by tools/workday-signin-window.mjs: he signed in in a visible window,
// and the rest runs here without one. Workday's session cookies are session-only, so they are
// added to this browser explicitly; they last as long as Workday keeps the session alive.
const sessionPath = `private/workday-sessions/${tenant}.json`;
let usedSession = false;
if (!attached && await exists(sessionPath)) {
  const {cookies, savedAt} = await readJson(sessionPath);
  await ctxBrowser.addCookies(cookies);
  usedSession = true;
  console.log(`using the session he signed into at ${savedAt}`);
}

async function startApplication() {
  const text=await body();
  await assertWorkdayPostingAvailable(page);
  if (!/Start Your Application/.test(text)) return;
  const autofill=page.locator('a[data-automation-id="autofillWithResume"], a:has-text("Autofill with Resume")').first();
  const manual=page.getByRole('link', {name:'Apply Manually', exact:true}).or(page.getByRole('button', {name:'Apply Manually', exact:true})).first();
  if(await manual.isVisible())await manual.click();
  else if(await autofill.isVisible())await autofill.click();
  else if(await manual.isVisible())await manual.click();
  else throw new Error('No supported application start option is available');
  await pause(6000);
}

try {
  if (await exists(`state/${jobId}.verifylink`)) {
    await page.goto((await readFile(`state/${jobId}.verifylink`, 'utf8')).trim(), {waitUntil: 'domcontentloaded'}); await pause(6000);
  }
  await openWorkdayApplicationPage(page,applyUrl(job.url),{onEvent:message=>console.log(message)}); await pause(7000);
  let t = await body();
  // Prefer manual preparation from confirmed history; reconcile parser output when manual entry is unavailable.
  await startApplication();
  if (!await signedIn()) {
    const c = await credential();
    let r = c ? await signIn(c) : 'no_credential';
    // A rejected shared password means no account on this tenant yet, so make one with it.
    // Wording here avoids the word the dashboard filters from events, so the step stays visible.
    if (r === 'rejected' && c.shared) { console.log('The shared Workday sign-in was rejected; creating an account on this tenant'); r = await createAccount(c, {afterRejectedSignIn: true}); }
    // An account already exists with a password he does not have: reset it to the saved credentials.
    // An existing account (or creation that could not succeed) is reset to the saved credentials:
    // a stored per-tenant password that no longer works, or registration rejected (Northrop 12146).
    if (c && (r === 'exists' || r === 'rejected' || (r === 'unknown' && c.shared))) r = await resetPassword(c);
    // Workday emails an activation link to a new account (valid 24 hours); read it from his mailbox,
    // open it and sign in. Opening a stale link makes Workday send a fresh one, so there are two rounds.
    for (let round = 0, after; r === 'needs_verification' && round < 2; round++) {
      console.log('checking your mailbox for the Workday verification link');
      const mailbox=questionAgent?{engine:questionAgent.engine,command:questionAgent.command,model:questionAgent.model}:{};
      let link = await fetchVerifyLink(job.url, {...mailbox,after, tries: round ? Math.max(1, setting('workday.mail_lookup_tries', 4) - 1) : 1});
      if (!link && await resendVerification()) link = await fetchVerifyLink(job.url, {...mailbox,after: Math.floor(Date.now() / 1000) - 120});
      if (!link) break;
      after = Math.floor(Date.now() / 1000) - 60;
      console.log('opening the emailed verification link');
      // The link opens a sign-in form; signing in there completes the activation.
      await page.goto(link, {waitUntil: 'domcontentloaded'}); await pause(6000);
      if (!await signedIn()) await signIn(c);
      await page.goto(applyUrl(job.url), {waitUntil: 'domcontentloaded'}); await pause(7000);
      await startApplication();
      r = await signedIn() ? 'ok' : await signIn(c);
    }
    // A wall at sign-in: refresh once after a pause, then let the queue cool the employer down.
    if (r === 'throttled') {
      await pause(throttlePauseMs()); await page.reload({waitUntil: 'domcontentloaded'}).catch(() => {}); await pause(6000);
      const wall = siteThrottled(await body());
      if (wall) { await snapshot('throttled'); await setState('throttled', {reason: throttledReason(wall)}); exitCode = 5; throw new Error('stop'); }
      await startApplication().catch(() => {});
      r = await signedIn() ? 'ok' : await signIn(c);
      if (r === 'throttled') { await snapshot('throttled'); await setState('throttled', {reason: throttledReason(siteThrottled(await body()) ?? 'security checkpoint')}); exitCode = 5; throw new Error('stop'); }
    }
    if (r !== 'ok') {
      await snapshot('signin');
      const reasons = {no_credential: usedSession
          ? `the saved session has expired; run tools/workday-signin-window.mjs for ${tenant} again`
          : `not signed in; add WORKDAY_PASSWORD to private/workday.env, or run tools/workday-signin-window.mjs so he can sign in`,
        rejected: `the saved credential for ${tenant} was rejected; update workday-${tenant} in private/credentials.json`,
        exists: `an account already exists on ${tenant} with a different credential; add workday-${tenant} to private/credentials.json, or sign in once through tools/workday-signin-window.mjs`,
        needs_verification: 'Workday is waiting for an emailed verification link that was not found in your mailbox', unknown: 'sign-in did not complete'};
      await setState(r === 'needs_verification' ? 'needs_verification' : 'needs_account', {reason: reasons[r]});
      exitCode = 3; throw new Error('stop');
    }
    t = await body();
    await startApplication();
  }

  let stuck = 0, refreshed = false;
  for (let guard = 0; guard < setting('workday.max_wizard_steps', 16); guard++) {
    t = await waitForStep(page, {n:-1,name:''});
    // Workday's "Something went wrong" page keeps the step bar, so it must be caught before the
    // step is read. One refresh after a pause; if it persists the queue cools the role down.
    const throttled = siteThrottled(t);
    if (throttled) {
      if (!refreshed) { refreshed = true; console.log(`Workday showed a ${throttled}; refreshing once after a pause`); await pause(throttlePauseMs()); await page.reload({waitUntil: 'domcontentloaded'}).catch(() => {}); await pause(6000); continue; }
      await snapshot('throttled'); await setState('throttled', {reason: throttledReason(throttled)}); exitCode = 5; break;
    }
    // An employer limit on applications stops the run until he decides on the Approvals page.
    const cap = detectCap(t);
    if (cap && !capAllowed(job.company, {...(profile.policy?.applicationCaps ?? {}), ...(questionAgent?.applicationCaps ?? {})})) {
      await snapshot('application-limit');
      await setState('needs_cap_approval', {reason: cap.quote, cap}); exitCode = 5; break;
    }
    const step = stepOf(t);
    const priorApplication = !step && alreadyAppliedNotice(t);
    if (priorApplication) { await snapshot('already-applied'); await setState('needs_human', {reason: `Workday says: "${priorApplication}" Nothing was submitted in this run; confirm the earlier application in Candidate Home > My Applications.`, phase: 'already_applied'}); exitCode = 4; break; }
    if (!step) { await snapshot('unknown'); await setState('blocked', {reason: 'could not tell which step the wizard is on'}); exitCode = 4; break; }
    console.log(`step ${step.n}/${step.of}: ${step.name}`);
    if(!await workdayFormReady(page)) throw new Error('Workday form did not finish loading: timed out');

    // A resumed application may open after My Experience. Revisit its saved
    // history before answering more questions or submitting an old draft.
    if (!historyVerified && /Application Questions|Voluntary|Self.?Ident|Review/i.test(step.name)) {
      const back = await goBackWorkday(page,step);
      if(sameStep(step,stepOf(back)))throw new Error('Workday did not return to the previous step for history verification');
      continue;
    }
    if (/^Review$/i.test(step.name)) {
      await writeFile(`${dir}/review.txt`, t);
      await snapshot('review');
      const problems = reviewProblems(t,A);
      if(!t.includes(basename(profile.resumePath)))problems.push('Review does not show the selected resume filename');
      if (problems.length) { await setState('blocked', {reason: problems.join('; ')}); exitCode = 4; break; }
      if (!SUBMIT) { await setState('at_review'); break; }
      submissionAttempted = true;
      const submittedAt=new Date().toISOString(),submittedFromUrl=page.url();
      await setState('submitting',{canonicalUrl:job.url,submissionAttempted:true,submittedAt});
      await page.locator('button[data-automation-id="pageFooterNextButton"]:has-text("Submit")').first().click({force: true});
      await pause(12000);
      const webpageEvidence=await collectWebpageAcceptance(page,job,{submittedAt,submittedFromUrl,screenshotPath:`${dir}/submission-confirmation.png`});
      await snapshot('after-submit');
      await setState(webpageEvidence ? 'submitted' : 'submission_unknown', webpageEvidence ? {submittedAt,receiptUrl:page.url(),receiptSource:'webpage',receiptEvidence:webpageEvidence,webpageEvidence} : {reason:'Submit did not reach a positive employer confirmation'});
      exitCode = webpageEvidence ? 0 : 4; break;
    }

    if (/Autofill with Resume/i.test(step.name)) {
      if (!/successfully uploaded/i.test(t)) { await page.locator('input[type="file"]').first().setInputFiles(profile.resumePath); await pause(8000); }
    } else if (/My Information/i.test(step.name)) await myInformation();
    else if (/My Experience/i.test(step.name)) await myExperience();
    else if (/Self.?Ident/i.test(step.name)) await fillWorkdaySignedDate(page);

    if (!await page.locator('button[data-automation-id="pageFooterNextButton"]').isVisible().catch(()=>false)) throw new Error('Workday form did not finish loading: timed out');
    const pending = await settleWorkdayQuestions(page,fields,answerQuestions);
    if (pending.length) {
      const request = {jobId, company: job.company, title: job.title, url: job.url, step: step.name,
        questions: pending.map(p => ({question: p.question, kind: p.kind, required: p.required, employerRequired:p.employerRequired, approvalReason:p.approvalReason, options: p.options, maxWords: p.maxWords ?? null, note: p.note, draft: p.draft}))};
      await writeFile(`${dir}/approval-request.json`, JSON.stringify(request, null, 2));
      await snapshot(`pending-${step.n}`);
      await setState('needs_approval', {reason: `${pending.length} question(s) on ${step.name}`, approvalRequest: `${dir}/approval-request.json`});
      exitCode = 2; break;
    }

    await snapshot(`step-${step.n}`);
    await continueWorkdayPreparation(page);
    const after = await waitForStep(page, step, {leaveName:/My Experience/i.test(step.name)});
    const nowStep = stepOf(after);
    if (siteThrottled(after)) continue;
    if (sameStep(step, nowStep)) {
      const errs = (await page.locator('[data-automation-id="errorMessage"], [data-automation-id="errorBanner"], [data-automation-id="errorMessageText"], [role="alert"]').allInnerTexts().catch(() => []))
        .filter(e => e && !/successfully|uploaded|saved/i.test(e));
      if (errs.length || ++stuck >= setting('workday.stuck_limit', 2)) { await snapshot(`blocked-${step.n}`); await setState('blocked', {reason: `stayed on ${step.name}${errs.length ? ': ' + errs.join('; ').slice(0,400) : ''}`, errors: errs}); exitCode = 4; break; }
    }
    else {
      stuck = 0;
      if (/My Experience/i.test(step.name) && nowStep) {
        // Verify a server round trip, not just the controls we filled locally.
        console.log(`Verifying saved work history: returning from ${nowStep.name}`);
        const saved=await goBackWorkday(page,nowStep);
        if(!/My Experience/i.test(stepOf(saved)?.name??'')||!await workdayFormReady(page))throw new Error('Cannot reopen saved My Experience');
        const rows=await readWorkdayHistory(page),problems=await savedWorkdayHistoryProblems(page,rows,profile.workHistory,{required:historyRequired});
        await writeFile(`${dir}/work-history-saved.json`,JSON.stringify({fingerprint:historyFingerprint(profile.workHistory),rows,problems},null,2),{mode:0o600});
        if(problems.length){
          console.log('Workday discarded saved history; repairing the confirmed entries once');
          await reconcileWorkdayHistory(page,profile.workHistory);
          await press('pageFooterNextButton');
          const forward=await waitForStep(page,stepOf(saved));
          await goBackWorkday(page,stepOf(forward));
          const repaired=historyProblems(await readWorkdayHistory(page),profile.workHistory);
          if(repaired.length)throw new Error(`Saved work-history verification failed after repair: ${repaired.join('; ')}`);
        }
        historyVerified = true;
        console.log(`Saved work history read back correctly: ${rows.length} entries`);
        await press('pageFooterNextButton');
        await waitForStep(page,stepOf(saved));
      }
    }
  }
} catch (e) {
  if (e.message !== 'stop') {
    const failure=siteThrottled(await body());
    await snapshot('error');
    await setState(submissionAttempted ? 'submission_unknown' : failure ? 'throttled' : 'blocked', {
      reason: failure && !submissionAttempted ? `Rate-limited: the employer's site showed a ${failure} while preparing the draft. Cooling down before another try.` : e.message.split('\n')[0],
    });
    exitCode = 4;
  }
} finally {
  await live?.stop();
  if (attached) await attached.close().catch(() => {}); else await ctxBrowser.close();
}
process.exit(exitCode);
