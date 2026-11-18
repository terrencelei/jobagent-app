import { normalizeApplicationLink } from './application-links.mjs';
import { applicationChromium } from './captcha-vendor.mjs';
const chromium = await applicationChromium();
import { basename } from 'node:path';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { receiptMatches } from './core.mjs';

// Remote typeaheads ignore a programmatic fill and answer slowly or not at all, so type
// real keystrokes and give the menu a bounded retry before treating the field as unfillable.
// A menu may show the chosen option in its own node, or write it back into the input.
async function shownSelection(scope, f) {
  const at = scope.locator(f.selectedSelector);
  return ((f.selectedIsValue ? await at.inputValue() : await at.innerText()) ?? '').trim();
}

async function chooseOption(page, el, f, value, attempts = 3, scope = page) {
  const exactText = new RegExp('^\\s*' + String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');
  const option = f.optionSelector
    ? scope.locator(f.optionSelector).filter({hasText: exactText})
    : scope.getByRole('option', {name: value, exact: true});
  // Most menus list every choice as soon as they open, so the option can simply be clicked.
  // Only a menu that queries as you type needs keystrokes, and then a short prefix is enough
  // to narrow it: typing a long label in full costs seconds per field and buys nothing.
  const query = f.typeText ?? (f.search === false ? null : value.slice(0, f.searchChars ?? 4));
  for (let i = 1; i <= attempts; i++) {
    // Any menu left open from a previous field can swallow the click or the keystrokes.
    await page.keyboard.press('Escape');
    await el.click();
    try {
      await option.first().waitFor({state: 'visible', timeout: 1500});
      await option.first().click();
      await page.waitForTimeout(150);
      return;
    } catch { /* Not listed yet: this menu filters on a query. */ }
    if (query) {
      await el.fill('');
      await el.pressSequentially(query, {delay: 60});
    }
    try {
      await option.first().waitFor({state: 'visible', timeout: 12000});
      await option.first().click();
      await page.waitForTimeout(150);
      return;
    } catch (e) {
      if (i === attempts) throw new Error(`Option never offered for ${f.key} after ${attempts} attempts: ${value}`);
    }
  }
}

export async function fillAndVerify(page, plan, answers, resumePath, scope = page) {
  for (const f of plan.fields) {
    const el = scope.locator(f.selector);
    const value = f.type === 'text' ? normalizeApplicationLink(answers[f.key]) : answers[f.key];
    if (f.type === 'text') {
      await el.fill(String(value));
      // A control may normalise what it was given (a date, a phone number); the plan says so.
      const want = f.expectDisplay ?? String(value);
      const got = await el.inputValue();
      if (got !== want) throw new Error(`Text verification failed: ${f.key} expected ${JSON.stringify(want)} but form holds ${JSON.stringify(got)}`);
    } else if (f.type === 'radio') {
      // A radio group addressed by name: the answer names which option to take, so the
      // approved answer stays the readable choice rather than a bare true.
      const opt = scope.locator(`${f.selector}[value="${String(value).replace(/"/g, '\\"')}"]`);
      if (await opt.isVisible()) await opt.check();
      else {
        const id = await opt.getAttribute('id');
        if (id) await scope.locator(`label[for="${id}"]`).first().click();
        else await opt.check({force: true});
      }
      if (!await opt.isChecked()) throw new Error(`Radio did not take: ${f.key} = ${value}`);
    } else if (f.type === 'buttongroup') {
      // Some forms answer a yes/no with a pair of buttons rather than an input, and record the
      // answer in aria-pressed. Read that back rather than trusting the click.
      const btn = scope.locator(f.selector).getByRole('button', {name: String(value), exact: true});
      await btn.click();
      await page.waitForTimeout(200);
      if (await btn.getAttribute('aria-pressed') !== 'true') throw new Error(`Button group did not register: ${f.key} = ${value}`);
    } else if (f.type === 'checkbox') {
      // An approved answer is the wording the user read and agreed to, which for a consent box
      // is "Yes", not a bare true. Accept either and decide what the box should end up as.
      const want = typeof value === 'boolean' ? value : /^(yes|true|on|checked)$/i.test(String(value).trim());
      // A styled radio or checkbox hides its input and takes clicks on the label, so the
      // control itself is never actionable; go through the label when that is the case.
      if (await el.isVisible()) await el.setChecked(want);
      else {
        const id = await el.getAttribute('id');
        if (!id) throw new Error(`Hidden control with no id cannot be clicked: ${f.key}`);
        if (await el.isChecked() !== want) await scope.locator(`label[for="${id}"]`).first().click();
      }
      if (await el.isChecked() !== want) throw new Error(`Checkbox verification failed: ${f.key} expected ${value}`);
    } else if (f.type === 'select') {
      await el.selectOption({label: String(value)});
      if ((await el.locator('option:checked').textContent()).trim() !== String(value)) throw new Error(`Select verification failed: ${f.key}`);
    } else {
      const label = f.optionLabel ?? String(value);
      await chooseOption(page, el, f, label, 3, scope);
      const shown = f.expectDisplay ?? label;
      const seen = await shownSelection(scope, f);
      if (seen !== shown) throw new Error(`Displayed selection mismatch: ${f.key} expected ${JSON.stringify(shown)} but form shows ${JSON.stringify(seen)}`);
    }
  }
  // Upload only to the mapped resume control, never the first arbitrary file input.
  await scope.locator(plan.resume.selector).setInputFiles(resumePath);
  await scope.locator(plan.resume.uploadedSelector).filter({hasText: basename(resumePath)}).waitFor({state:'visible'});
  // Recheck after React rerenders: a successful click is not proof of a persisted answer.
  for (const f of plan.fields) {
    const el=scope.locator(f.selector), value=f.type === 'text' ? normalizeApplicationLink(answers[f.key]) : answers[f.key];
    const actual=f.type==='combobox' ? await shownSelection(scope, f)
      : f.type==='radio' ? await scope.locator(`${f.selector}[value="${String(value).replace(/"/g, '\\"')}"]`).isChecked()
      : f.type==='checkbox' ? await el.isChecked()
      : f.type==='buttongroup' ? (await scope.locator(f.selector).getByRole('button', {name: String(value), exact: true}).getAttribute('aria-pressed')) === 'true'
      : f.type==='select' ? (await el.locator('option:checked').textContent()).trim()
      : await el.inputValue();
    // A checkbox holds a boolean however its approved answer was worded.
    const expected = f.type==='checkbox'
      ? (typeof value === 'boolean' ? value : /^(yes|true|on|checked)$/i.test(String(value).trim()))
      : (f.type==='buttongroup' || f.type==='radio') ? true
      : (f.expectDisplay ?? f.optionLabel ?? String(value));
    if(actual !== expected) throw new Error(`Final verification failed: ${f.key} expected ${JSON.stringify(expected)} but form holds ${JSON.stringify(actual)}`);
  }
  const invalid = await scope.locator('input:invalid,select:invalid,textarea:invalid').evaluateAll(
    els => els
      // A "pick one" list is often rendered as checkboxes that all carry required, so the
      // boxes left unticked read as invalid even though the question is answered. Judge the
      // group by whether any of its members is checked.
      .filter(e => !(e.type === 'checkbox' && e.name &&
                     document.querySelector(`input[type="checkbox"][name="${CSS.escape(e.name)}"]:checked`)))
      .map(e => ({tag: e.tagName, id: e.id, name: e.name, type: e.type, required: e.required,
                  label: e.labels?.[0]?.innerText?.trim()?.slice(0, 60),
                  message: e.validationMessage})));
  if (invalid.length) throw new Error(`${invalid.length} required or invalid control(s) remain: ${JSON.stringify(invalid)}`);
}

// A code is often collected as one box per character rather than a single field. Type it and
// let the widget advance itself, then check every box, because a partially landed code would
// otherwise be submitted as a wrong answer.
async function enterCode(page, v, code, scope = page) {
  if (!v.codeInputs) {
    const field = v.codeSelector ? scope.locator(v.codeSelector) : scope.getByLabel(v.codeLabel ?? 'Security code', {exact: false});
    await field.fill(code);
    if (await field.inputValue() !== code) throw new Error('Verification code did not persist in the form');
    return;
  }
  const boxes = scope.locator(v.codeInputs);
  const count = await boxes.count();
  if (count !== code.length) throw new Error(`Form offers ${count} code boxes but the supplied code is ${code.length} characters`);
  await boxes.first().click();
  await page.keyboard.type(code, {delay: 80});
  const landed = async () => (await boxes.allTextContents(), Promise.all(
    Array.from({length: count}, (_, i) => boxes.nth(i).inputValue())));
  let values = await landed();
  if (values.join('') !== code) {
    // Auto-advance did not place every character; set each box directly instead.
    for (let i = 0; i < count; i++) await boxes.nth(i).fill(code[i]);
    values = await landed();
  }
  if (values.join('') !== code) throw new Error(`Verification code did not persist: form holds ${JSON.stringify(values.join(''))}`);
}

// An employer may email a code before it accepts the application. The runner never reads
// email itself: it records what it is waiting for and blocks on an operator dropping the
// code into state/<job>.code, so credentials for a mailbox stay outside this process.
async function supplyVerificationCode(page, plan, job, artifactDir, saveStatus, scope = page) {
  const v = plan.verification;
  const codePath = `state/${job.id}.code`;
  await writeFile(`${artifactDir}/verification-form.json`,
    JSON.stringify(await scope.locator('input,button').evaluateAll(
      els => els.map(e => ({tag: e.tagName, id: e.id, name: e.name, type: e.type,
                            label: e.labels?.[0]?.innerText?.trim(), text: e.innerText?.trim()?.slice(0,40)}))), null, 2),
    {mode: 0o600});
  await page.screenshot({path: `${artifactDir}/verification.png`, fullPage: true});
  await saveStatus('awaiting_verification_code', {codePath, expectedIn: v.sentTo ?? null});
  const deadline = Date.now() + (v.timeoutMs ?? 300000);
  let code = null;
  while (Date.now() < deadline) {
    try { code = (await readFile(codePath, 'utf8')).trim(); if (code) break; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await page.waitForTimeout(3000);
  }
  if (!code) throw new Error(`No verification code supplied at ${codePath} within the wait window`);
  await unlink(codePath).catch(() => {});
  if (v.codePattern && !new RegExp(`^${v.codePattern}$`).test(code)) throw new Error('Supplied verification code does not match the expected shape');
  await enterCode(page, v, code, scope);
  const resubmit = scope.locator(v.submitSelector ?? plan.submitSelector);
  await resubmit.click();
  try { await resubmit.waitFor({state: 'hidden', timeout: plan.submitTimeoutMs ?? 90000}); } catch { /* evidence below decides */ }
}

export async function runBrowser({job, plan, answers, resumePath, artifactDir, submit, beforeSubmit, saveStatus}) {
  let traceFlush = async () => {};
  // Headed mode allows the applicant to complete a human challenge in person.
  // Browser choice and profile persistence do not guarantee verification acceptance.
  const headed = process.env.APPLICATION_AGENT_HEADED === '1';
  const channel = process.env.APPLICATION_AGENT_CHANNEL || undefined;
  const profileDir = process.env.APPLICATION_AGENT_PROFILE_DIR || undefined;
  // CDP attaches only to an explicitly configured debugging browser.
  const cdp = process.env.APPLICATION_AGENT_CDP || undefined;
  const attached = cdp ? await chromium.connectOverCDP(cdp) : null;
  const context = attached
    ? (attached.contexts()[0] ?? await attached.newContext())
    : profileDir
      ? await chromium.launchPersistentContext(profileDir, {headless: !headed, channel, viewport: null})
      : null;
  const browser = (attached || context) ? null : await chromium.launch({headless: !headed, channel});
  const page = attached ? await context.newPage()
    : context ? (context.pages()[0] ?? await context.newPage())
    : await browser.newPage();
  page.setDefaultTimeout(15000);
  // Challenge requests are a verification signal, not proof of the rejection cause.
  // The widget may live in a frame and leave the top-level body text unchanged.
  let challengeServed = false;
  page.on('request', r => { if (/\/getcaptcha|\/recaptcha\/api2\/(userverify|reload)/.test(r.url())) challengeServed = true; });
  // A submit that neither navigates nor errors leaves no evidence on the page. Tracing the
  // POST and the app's own console is the only way to tell a rejected form from a dead click.
  if (process.env.APPLICATION_AGENT_TRACE === '1') {
    const log = [];
    page.on('console', m => log.push(`console.${m.type()}: ${m.text()}`));
    page.on('pageerror', e => log.push(`pageerror: ${e.message}`));
    page.on('request', r => { if (r.method() !== 'GET') log.push(`>> ${r.method()} ${r.url()}`); });
    page.on('response', async r => { if (r.request().method() !== 'GET') log.push(`<< ${r.status()} ${r.url()} ${(await r.text().catch(()=>'')).slice(0,400)}`); });
    traceFlush = () => writeFile(`${artifactDir}/trace.log`, log.join('\n'), {mode:0o600});
  }
  try {
    // Some boards keep the posting and its form on separate pages. A plan may name the form,
    // but only on the same employer origin the scraper approved.
    const target = plan.formUrl ?? job.url;
    if (new URL(target).origin !== new URL(job.url).origin) throw new Error('Plan form URL is on a different origin than the job');
    // A board that is briefly slow is not a failed application; give the first load room.
    await page.goto(target, {waitUntil:'domcontentloaded', timeout: plan.gotoTimeoutMs ?? 45000});
    if (new URL(page.url()).origin !== new URL(job.url).origin) throw new Error('Unexpected redirect; review destination');
    // Filling before the client app hydrates is silently undone: the server-rendered input
    // accepts the value, the immediate check passes, then hydration resets it to empty.
    // Wait for the app to take over before touching a single field.
    // Boards that hold a socket or poll in the background never reach networkidle, so treat it
    // as the good case and fall back to the form's own readiness signal.
    await page.waitForLoadState('networkidle', {timeout: plan.idleTimeoutMs ?? 15000}).catch(() => {});
    // The form may live in an embedded frame on the employer's own page.
    const scope = plan.formFrame ? page.frameLocator(plan.formFrame) : page;
    if (plan.readySelector) await scope.locator(plan.readySelector).first().waitFor({state:'visible'});
    // The scraper's title can be stale: a posting retitled "Senior" still answers on the same URL,
    // and the application goes to a requisition the applicant was never screened against. The page
    // itself is the authority on what is being applied for.
    const SENIORITY = /\b(senior|sr\.?|staff|principal|lead|manager|director|head of|iii|iv)\b/i;
    const liveTitle = (await page.title().catch(() => '')) + ' ' +
      (await page.locator('h1').first().innerText().catch(() => ''));
    if (liveTitle.trim() && SENIORITY.test(liveTitle) && !SENIORITY.test(job.title))
      throw new Error(`Posting reads as a more senior role than the queue records: page says ${JSON.stringify(liveTitle.trim().slice(0, 90))}, queue says ${JSON.stringify(job.title)}`);
    // Give a still-busy app a moment to finish hydrating before the first keystroke.
    await page.waitForTimeout(plan.hydrateMs ?? 1500);
    // A consent banner pinned over the page swallows the submit click, so clear it first.
    for (const sel of plan.dismissSelectors ?? []) {
      const b = page.locator(sel).first();
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
    await fillAndVerify(page, plan, answers, resumePath, scope);
    await page.screenshot({path:`${artifactDir}/prepared.png`,fullPage:true});
    if (!submit) {
      // Handoff: a challenge that will not pass for an automated browser is finished by the
      // applicant in this same session, rather than by the agent imitating a person.
      if (process.env.APPLICATION_AGENT_HANDOFF === '1') {
        await saveStatus('awaiting_human_submit');
        console.log(`\n  The form is filled and verified. Finish it in the open window:`);
        console.log(`    1. Click Submit application.`);
        console.log(`    2. Complete any verification yourself. If emailed a code, enter it and resubmit.`);
        console.log(`  Waiting up to 30 minutes for the confirmation page; the mailbox receipt is checked separately.\n`);
        const deadline = Date.now() + 1800000;
        while (Date.now() < deadline) {
          if (page.isClosed()) throw new Error('Window closed before a confirmation page was observed');
          const seen = await page.locator('body').innerText().catch(() => '');
          if (receiptMatches(page.url(), seen, plan.confirmation, new URL(job.url).origin)) {
            await page.screenshot({path:`${artifactDir}/result.png`,fullPage:true});
            await writeFile(`${artifactDir}/result.txt`, `url: ${page.url()}\n\n${seen}`, {mode:0o600});
            await saveStatus('submitted_pending_receipt', {receiptUrl: page.url(), receiptText: plan.confirmation.text, submittedBy: 'applicant in handoff'});
            return;
          }
          await page.waitForTimeout(5000);
        }
        throw new Error('No confirmation page observed within the handoff window');
      }
      await saveStatus('prepared'); return;
    }
    // Some boards save every field to the server as it is filled. Clicking submit while those
    // writes are still in flight is refused client-side with no request and no error, so let the
    // form settle first.
    await page.waitForTimeout(plan.preSubmitSettleMs ?? 2500);
    await page.waitForLoadState('networkidle', {timeout: 15000}).catch(() => {});
    await beforeSubmit(); // Persist intent BEFORE clicking; uncertain outcomes must not be retried blindly.
    const submitButton = scope.locator(plan.submitSelector);
    await submitButton.click();
    try {
      // The button spins while the POST is in flight. Screenshotting during that window
      // captures neither a receipt nor a failure, which is unreconcilable afterwards.
      // Wait for it to settle before classifying anything.
      await submitButton.waitFor({state: 'hidden', timeout: plan.submitTimeoutMs ?? 90000});
    } catch { /* It may spin in place instead of unmounting; the evidence below decides. */ }
    try {
    } catch { /* Still spinning or replaced; the evidence below decides. */ }
    try {
      await page.waitForURL(url => url.origin === new URL(job.url).origin && url.pathname.includes(plan.confirmation.urlIncludes), {timeout:20000});
      await page.getByText(plan.confirmation.text, {exact:false}).first().waitFor();
    } catch { /* Classify below, never assume a successful POST. */ }
    let body = await (plan.formFrame ? scope.locator('body') : page.locator('body')).innerText();
    let challengeAnswered = false;
    // Classify the challenge before the receipt: a code prompt is not a failed submission,
    // it is an unfinished one, and this session can still finish it.
    if (plan.verification && new RegExp(plan.verification.promptPattern, 'i').test(body)) {
      await supplyVerificationCode(page, plan, job, artifactDir, saveStatus, scope);
      challengeAnswered = true;
      // The employer may take a moment to accept it; do not judge the outcome immediately.
      await page.waitForTimeout(plan.verification?.settleMs ?? 15000);
      body = await (plan.formFrame ? scope.locator('body') : page.locator('body')).innerText();
    }
    await page.screenshot({path:`${artifactDir}/result.png`,fullPage:true});
    // Persist the page text too: a screenshot alone is not searchable evidence when a
    // submission has to be reconciled later.
    await writeFile(`${artifactDir}/result.txt`, `url: ${page.url()}\n\n${body}`, {mode:0o600});
    if (receiptMatches(page.url(), body, plan.confirmation, new URL(job.url).origin)) {
      await saveStatus('submitted_pending_receipt', {receiptUrl:page.url(),receiptText:plan.confirmation.text});
    } else if (challengeAnswered) {
      // The challenge was answered in this run, so leftover prompt text on the page proves
      // nothing: the employer may already have accepted it. Saying "blocked" here is what
      // turned a completed submission into a duplicate. Await an out-of-band receipt.
      await saveStatus('submitted_pending_receipt', {note: 'Challenge answered; confirm against the applicant mailbox before recording or retrying.'});
    } else {
      await saveStatus(challengeServed || /verification code|security code|captcha|verify.*human/i.test(body) ? 'needs_human_verification' : 'submission_unknown');
    }
  } finally {
    await traceFlush();
    // His own browser stays open and stays his; only the tab this run made is cleaned up.
    if (attached) { await page.close().catch(() => {}); await attached.close().catch(() => {}); }
    else await (context ?? browser).close();
  }
}
