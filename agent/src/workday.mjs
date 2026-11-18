import {workdayAuthScope} from './workday-auth-form.mjs';
import {regionalAnswer} from './location-policy.mjs';
import {routineQuestionNeedsReview} from './routine-application-policy.mjs';
import {shouldApproveOptionalWriting} from './application-writing-policy.mjs';
import {preferenceAnswer,confirmedFactIsNewer,internshipCompensationQuestion} from './applicant-preferences.mjs';
import {setting} from './settings.mjs';
// Pure logic for Workday applications: which step the wizard is on, which of a menu's options is
// the confirmed answer, and which questions can be answered without asking. The browser driver in
// tools/workday-run.mjs does the clicking; everything here is testable without a browser.
import { questionId, intentOf, lookup } from './companies.mjs';

// The progress bar lists every step by name, so "My Information" appears on every page. Only the
// "current step N of M" marker says where the wizard actually is.
export function stepOf(text) {
  const m = String(text).match(/current step (\d+) of (\d+)\s*\n\s*([^\n]+)/);
  return m ? {n: Number(m[1]), of: Number(m[2]), name: m[3].trim()} : null;
}

// Tenants are separate employers with separate candidate accounts, so the session profile and the
// credential are both keyed by the tenant's subdomain.
export function tenantOf(url) {
  const m = new URL(url).hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (!m) throw new Error(`Not a Workday job URL: ${url}`);
  return m[1];
}

export function applyUrl(url) {
  const u = new URL(url);
  if (!/\/apply(\/|$)/.test(u.pathname)) u.pathname = u.pathname.replace(/\/$/, '') + '/apply';
  return u.toString();
}

const norm = s => String(s ?? '').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\s+/g, ' ').trim().toLowerCase();

// Employers word the same answer differently: "Asian" on one tenant is "Asian (United States of
// America)" on the next. Candidates are tried in order; an exact match wins over a qualified one,
// and nothing is chosen when no offered option is one of the confirmed answers.
// Candidates are exact texts in order of preference; a RegExp candidate accepts any option it
// matches (tenants word the same choice differently: "Mobile", "Mobile/Cell", "Cell Phone").
export function pickOption(offered, candidates) {
  const opts = offered.map(o => String(o).trim()).filter(o => o && !/^select one$/i.test(o));
  const texts = candidates.filter(c => !(c instanceof RegExp));
  const choiceNorm = value => norm(value).replace(/[.!?]+$/, '');
  for (const c of texts) {
    const hit = opts.find(o => choiceNorm(o) === choiceNorm(c));
    if (hit) return hit;
  }
  for (const c of texts) {
    const hit = opts.find(o => norm(o).startsWith(norm(c) + ' (') || norm(o).startsWith(norm(c) + ','));
    if (hit) return hit;
  }
  for (const c of candidates.filter(c => c instanceof RegExp)) {
    const hit = opts.find(o => c.test(o));
    if (hit) return hit;
  }
  return null;
}

export function needsWorkdayAnswer(field, resolved) {
  // A prefilled narrative is not proof that the applicant approved it.
  if (shouldApproveOptionalWriting(field) && resolved?.source !== 'approved') return true;
  // A matching DOM value can still be rejected by Workday's form model.
  // Re-enter only a known text answer through the normal fill/blur path.
  if (field.invalid && resolved && ['text','textarea'].includes(field.kind)) return true;
  if (!field.value) return true;
  if (field.kind === 'text' && /^(first name|last name|city|email(?: address)?|address line 1|postal code|zip code)\s*\*?$/i.test(field.label)) return true;
  return Boolean(resolved && !pickOption([field.value], resolved.candidates));
}

// Questions whose answer is a settled fact from the profile, so they never need approval. Each
// rule gives the acceptable option texts in order of preference. Anything not covered here or in
// the company's approved answers is held for approval rather than guessed.
const STATE_NAMES = Object.fromEntries('AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming'.split('|').map(s => s.split(':')));
export const ANSWER_RULES = [
  {match:/^first name\s*\*?$/i,answer:ctx=>ctx.answers?.firstName?[ctx.answers.firstName]:null},
  {match:/^last name\s*\*?$/i,answer:ctx=>ctx.answers?.lastName?[ctx.answers.lastName]:null},
  {match:/^city\s*\*?$/i,answer:ctx=>ctx.answers?.addressCity||ctx.answers?.city?[ctx.answers.addressCity||ctx.answers.city]:null},
  {match:/^(email|email address)\s*\*?$/i,answer:ctx=>ctx.answers?.email?[ctx.answers.email]:null},

  {match: /^country\s*\*?$/i, answer: ctx => {const country = ctx.answers?.country; if (!country) return null; return /^(us|usa|united states(?: of america)?)$/i.test(country) ? ['United States of America', 'United States', 'USA', 'US'] : [country];}},
  {match: /^(state|state or province|state\/province)\s*\*?$/i, answer: ctx => {const state = ctx.answers?.addressState; return state ? [state, STATE_NAMES[String(state).toUpperCase()]].filter(Boolean) : null;}},
  {match: /are you one of the following|citizenship status|citizen or national/i,
   answer: () => ['U.S. Citizen or National', 'U.S. Citizen', 'US Citizen', 'Yes']},
  {match: /(legally )?authori[sz]ed to work in the (united states|u\.s)/i, answer: () => ['Yes']},
  {match: /(require|need).*(sponsorship|visa)/i, answer: () => ['No']},
  {match: /(grade point average|gpa).*(above|at least|minimum|greater).*3\.0/i, answer: () => ['Yes']},
  {match:/^Have you worked with us before\??\s*\*?$/i,answer:ctx=>ctx.company&&(ctx.history??[]).length&&!(ctx.history??[]).some(h=>norm(h.company).includes(norm(ctx.company))||norm(ctx.company).includes(norm(h.company)))?['No']:null},
  // Only a No is settled: if the employer is in his history, someone has to say what he did there.
  // The wordings seen so far: "previously been employed by", "ever been employed by", "currently
  // working or have you previously worked as a ... employee", "prior employee of a ... company",
  // "worked as a contractor", "ever been issued a ... Employee ID".
  {match: /(previously|ever|currently) (completed an internship|worked|work(ing)?|been employed|been an? (employee|contractor|intern))\b.*\b(with|for|at|by|as)\b|(former|current|prior|previous) (employee|contractor|worker)\b|(?:have you|were you).*\b(?:issued|assigned)\b.*employee id|ever been employed/i,
   answer: ctx => (ctx.history ?? []).some(h => norm(h.company).includes(norm(ctx.company)) || norm(ctx.company).includes(norm(h.company))) ? null : ['No']},
  // Settled facts from his profile, typed into text fields as well as chosen from menus.
  {match: /^(street )?address( line)? ?1?\s*\*?$|^street address/i, answer: ctx => ctx.answers?.addressLine1 ? [ctx.answers.addressLine1] : null},
  {match: /postal code|zip ?code|^zip\b/i, answer: ctx => ctx.answers?.addressZip ? [String(ctx.answers.addressZip)] : null},
  {match: /phone (device )?type/i, answer: () => ['Mobile', 'Mobile Phone', 'Cell', 'Cell Phone', /mobile|cell/i]},
  {match: /\bu\.?s\.? person\b/i, answer: () => ['Yes', 'U.S. Person']},
  {match: /(eligible|able) to (obtain|receive|hold).*clearance/i, answer: () => ['Yes']},
  {match: /(do you (currently )?(have|hold)|active|current).*security clearance/i, answer: () => ['No', 'None', 'Never held a clearance', 'N/A']},
  {match: /^please select your gender|^gender|what is your (sex|gender)/i, answer: () => ['Male']},
  {match: /hispanic or latino/i, answer: () => ['No', 'Not Hispanic or Latino']},
  {match: /ethnicity|\brace\b|racial/i, answer: () => ['Asian', 'Asian (Not Hispanic or Latino)', 'East Asian']},
  {match: /veteran/i, answer: () => ['I am not a Veteran', 'I am not a protected Veteran', 'I am not a protected veteran', 'No']},
  {match: /disability/i, answer: () => ['No, I do not have a disability and have not had one in the past', 'No, I Don\'t Have A Disability', 'No']},
  {match: /confirm that the answers.*(correct|accurate)/i, answer: () => ['Yes']},
];

// A question is answered from the rules first, then from the answers the user approved for this
// company or for every company. Returns null when nobody has decided it: that question is held.
export function resolveQuestion(label, bank = {}, ctx = {}) {
  if(routineQuestionNeedsReview(label)){
    const exact=(ctx.approvedAnswers??[]).find(a=>questionId(a.question??'')===questionId(label))??bank[questionId(label)];
    return exact&&typeof exact.answer==='string'&&exact.answer.trim()?{candidates:[exact.answer],source:'approved',approvedFor:exact.approvedFor??ctx.id}:null;
  }
  const regional=regionalAnswer(label,ctx,ctx);if(regional)return regional.value?{candidates:regional.candidates,source:'profile'}:null;
  const preference = preferenceAnswer(label,ctx.answers,{...ctx,bank});
  // Before Workday's source prompt opens there are no options, so the routine default is a bare
  // 'Company Website'; keep the employer-site wordings behind it ('GM Careers Website', 12142).
  if(preference?.authoritative&&preference.key==='routineSourceChoiceAllowed'&&preference.value==='Company Website'&&!ctx.options?.length&&intentOf(label)==='how-heard')return {candidates:[...(preference.candidates??[String(preference.value)]),...HEARD_CANDIDATES],source:'profile'};
  if(preference?.authoritative)return {candidates:preference.candidates??[String(preference.value)],source:'profile'};
  const explicit=(ctx.approvedAnswers??[]).find(answer=>questionId(answer.question)===questionId(label));
  if(explicit&&String(explicit.answer??'').trim())return {candidates:[String(explicit.answer)],source:'approved',approvedFor:ctx.id};
  if(internshipCompensationQuestion(label,ctx))return null;
  if(preference?.key==='minimumAnnualSalary'||preference?.key==='fullName'&&/current date/i.test(label))return {candidates:preference.candidates??[String(preference.value)],source:'profile'};
  const saved=lookup(bank,label);
  if(preference&&confirmedFactIsNewer(preference.key,ctx,saved))return {candidates:preference.candidates??[String(preference.value)],source:'profile'};
  if(saved&&String(saved.answer??'').trim()&&(!ctx.options?.length||pickOption(ctx.options,[saved.answer])))return {candidates:[String(saved.answer)],source:'approved',approvedFor:saved.approvedFor};
  if(preference){const candidates=preference.candidates??[String(preference.value)];if(preference.value==='No'&&/to the best of your knowledge/i.test(label))candidates.push('Not to my knowledge');return {candidates,source:'profile'};}
  // With a real profile, unresolved eligibility must not fall through to legacy
  // hardcoded US/clearance answers that ignore jurisdiction or clearance level.
  if(ctx.answers&&/citizen|clearance|sponsorship|visa|authori[sz].*work|right to work/i.test(label)){
    const saved=lookup(bank,label);
    return saved?{candidates:[saved.answer],source:'approved',approvedFor:saved.approvedFor}:null;
  }
  // "How did you hear" is his employer-site answer wherever it is offered; an answer he approved
  // (for this employer, or learned from any employer) is tried first.
  if (intentOf(label) === 'how-heard') {
    const banked = lookup(bank, label);
    const names=[ctx.company, ...( /^[A-Z0-9]{2,}$/.test(String(ctx.company??'').split(' ')[0]) ? [ctx.company.split(' ')[0]] : [])].filter(Boolean);
    // Employer website alias verified at https://www.sncorp.com/contact-us .
    const aliases=/^Sierra Nevada (?:Corporation|Company)$/i.test(ctx.company??'')?['Website - SNCorp.com']:[];
    const ownSite=[...aliases,...names.flatMap(name=>[`Web - ${name}`, `${name} Website`, `${name} Career Site`,`${name} Careers`])];
    const discovered=ctx.answers?.heardJobBoard?['JobAgent','Other Job Board','Other']:[];
    return {candidates: [...(banked ? [banked.answer] : []), ...ownSite, ...HEARD_CANDIDATES,...discovered], source: 'profile'};
  }
  const rule = ANSWER_RULES.find(r => r.match.test(label));
  const ruled = rule ? rule.answer(ctx) : null;
  if (ruled) return {candidates: ruled, source: 'profile'};
  const banked = lookup(bank, label);
  if (banked) return {candidates: [banked.answer], source: 'approved', approvedFor: banked.approvedFor};
  return null;
}

// The employer's own site, in the wordings tenants use; a bare "Website" or "Online" category is
// last, so a nested menu is opened one level down to reach the leaf.
export const HEARD_CANDIDATES = ['Company Website', 'Career Site', 'Careers Website', 'Company Career Site', 'Careers Site',
  /(company|corporate|careers?) (web ?)?(site|page|portal)|career (site|page|portal|website)|company careers|careers? page/i,
  /^(websites?|online|internet|web|online\/website|company websites?)$/i];

// "How did you hear" is always the employer's own site where the menu offers it. Workday nests it
// one level down, so the category and the leaf are both matched by the same wording.
export const SOURCE_PATTERN = /(company|corporate|careers?) (web ?)?(site|page|portal)|career (site|page|portal|website)|company careers|careers? page|company website/i;

// Workday's degree menus are tenant-specific lists; these are the labels seen so far that mean a
// bachelor's in science or engineering, most specific first.
export const DEGREE_CANDIDATES = [
  'Bachelors of Science (BSc) or Engineering (BEng)', 'Bachelor of Science (BS)', 'Bachelor of Science', 'BS', 'B.S.', 'BSc', 'B.Sc.',"Bachelor's Level Degree",
  "Bachelor's Degree or Equivalent", "Bachelor's Degree", 'Bachelors', 'Other Bachelors Degree',
];

// A work-history entry the resume parser produced is matched to the profile by its start date,
// which the parser gets right even when it garbles the title or drops the company.
export function matchWork(entry, history) {
  return history.find(h => Number(h.from[0]) === Number(entry.fromMonth) && String(h.from[1]) === String(entry.fromYear)) ?? null;
}

// Checkboxes that are required acknowledgements may be ticked; anything that opts him into
// messages may not. Ticking every box once enrolled him in marketing SMS.
export function isAcknowledgement(label) {
  if(/^I certify that I have read, fully understand and accept all items of the foregoing statement\.?$/i.test(label.trim()))return true;
  return /(read|reviewed|consent|agree|accept).*(terms|privacy|conditions|notice)/i.test(label)
    && !/sms|text message|marketing|newsletter|job alerts?/i.test(label);
}

// The review page is the last chance to see a section that silently came through empty.
// A limit stated in the question ("Max 300 words") is enforced before anything is typed.
export function wordLimit(label) {
  const m = String(label).match(/max(?:imum)?\.?\s*(?:of\s*)?(\d+)\s*words/i);
  return m ? Number(m[1]) : null;
}

export function reviewProblems(text,answers={}) {
  const problems = [];
  for (const section of ['Work Experience', 'Education', 'Resume/CV'])
    if (new RegExp(`${section}\\s*\\nNo Response`).test(text)) problems.push(`${section} is empty`);
  if (/SMS Opt-?in\s*\n\s*Yes/i.test(text)&&answers.recruitmentSmsConsent!=='Yes') problems.push('SMS opt-in is ticked');
  if(answers.governmentEmployment==='No'&&answers.armedForcesService==='No'&&/official or employee of the (?:DoD|Department of Defense)\?[\s\S]{0,250}?\n\s*Yes,? I (?:have )?served\b/i.test(text))problems.push('DoD service answer contradicts confirmed government and military history');
  if(/^(?:High School|GED)/i.test(answers.highestCompletedEducation??'')&&/highest (?:level of )?(?:education|degree)[^\n]*(?:received|completed|earned)[^\n]*\n\s*(?:Bachelors?|Bachelor['’]s|Masters?|Master['’]s|Doctorate|PhD)\b/i.test(text))problems.push('Completed education answer contradicts the confirmed highest completed education');
  return problems;
}

// Approved wording is reused across an employer's postings, but an essay can name the posting it
// was written for. A LibertyWorks application went to Review saying the "Engineering and
// Technology Graduate Program" appealed to him. Reuse is held when the answer names the original
// posting's title and the current posting is a different one.
export function staleReference(answer, originalTitle, currentTitle) {
  if (!originalTitle || !currentTitle || norm(originalTitle) === norm(currentTitle)) return false;
  return norm(answer).includes(norm(originalTitle));
}

// Workday's apply page opens on Create Account, and its "Sign In" link can render after the form.
// Typing credentials before it appears fills Create Account's email and password and leaves
// "Verify New Password" empty, so nothing is submitted (Saab, job 3299). Switch to the sign-in
// form and confirm Create Account is gone before anything is typed; false means it never went.
export async function openSignInForm(page, {wait = ms => new Promise(r => setTimeout(r, ms)), tries = setting('workday.sign_in_form_tries', 8)} = {}) {
  let scope = page;
  // Hidden mounted auth fields must not mask the visible email chooser/form.
  const visible = sel => scope.locator(`:is(${sel}):visible`).first().isVisible().catch(() => false);
  // A resumed application can land back on Start Your Application with disabled
  // entry options (ABB). Open the header's email sign-in instead of waiting for
  // a Create Account form that was never mounted. Never select an SSO action.
  const headerSignIn = '[data-automation-id="utilityButtonSignIn"], button:text-is("Sign In"), a:text-is("Sign In"), [role="button"]:text-is("Sign In")';
  await page.locator(':is([data-automation-id="email"], [data-automation-id="verifyPassword"], button[data-automation-id="signInLink"], button:has-text("with email"), ' + headerSignIn + '):visible')
    .first().waitFor({state: 'visible', timeout: 15000}).catch(() => {});
  let reloaded = false;
  for (let i = 0; i < tries; i++) {
    scope = await workdayAuthScope(page);
    // After a browser disconnect/resume the page can stay completely blank (Boeing 14453); waiting never
    // fills it, so reload it once.
    if (!reloaded && i >= 2 && await Promise.resolve().then(() => page.evaluate(() => !(document.body?.innerText ?? '').trim() && !document.querySelector('input,button,iframe'))).catch(() => false)) {
      reloaded = true; await page.reload({waitUntil: 'domcontentloaded', timeout: 30000}).catch(() => {}); await wait(3000); continue;
    }
    if (!await visible('[data-automation-id="verifyPassword"]') && await visible('[data-automation-id="email"], button:has-text("with email")')) return true;
    const link = scope.locator('button[data-automation-id="signInLink"]:visible').first();
    if (await link.count() && await link.isVisible()) { await link.click({force: true}); await wait(2500); continue; }
    const header = page.locator(`:is(${headerSignIn}):visible`).first();
    if (await header.count() && await header.isVisible().catch(() => false)) {
      // A blank/loading dialog backdrop can cover the header (GM 12603): a plain click then waits out
      // its 20 s timeout and kills the run. Try briefly, and let the loop wait for the dialog instead.
      const clicked = await header.click({timeout: 4000}).then(() => true, () => false);
      await wait(clicked ? 2500 : 3000); continue;
    }
    if (!await visible('[data-automation-id="verifyPassword"]')&&await visible('[data-automation-id="email"], button:has-text("with email")')) return true;
    await wait(1500);
  }
  return false;
}
