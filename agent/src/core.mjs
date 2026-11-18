import { createHash } from 'node:crypto';
import { questionId } from './companies.mjs';

export function validateJob(job) {
  if (!job || !/^[a-zA-Z0-9_-]+$/.test(job.id ?? '')) throw new Error('Job needs a safe, stable id');
  const url = new URL(job.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Job URL must be HTTPS without credentials');
  if (!job.company || !job.title) throw new Error('Company and title required');
  return job;
}

export const ACCEPTED_SOURCE_ELIGIBILITY = ['STRONG_MATCH', 'ELIGIBLE'];

export function filterJob(job, policy) {
  validateJob(job);
  const reasons = [];
  // Salary and start-date timing are screened upstream by the jobagent scraper, which
  // treats an unstated salary or start date as neutral rather than disqualifying.
  // Require its recorded verdict instead of re-deriving a stricter one here.
  if (!ACCEPTED_SOURCE_ELIGIBILITY.includes(job.sourceEligibility ?? '')) reasons.push('source_eligibility_not_confirmed');
  // A salary the employer actually states must still clear policy; an unstated one is neutral.
  if (job.salary !== undefined && job.salary !== null) {
    if (job.salary.currency !== 'USD' || job.salary.period !== 'year' || !Number.isFinite(job.salary.min) || job.salary.min < policy.minimumBaseSalary) reasons.push('stated_salary_below_policy');
  }
  if (job.country !== 'US') reasons.push('outside_us');
  // An exact start date must still be compatible; an unstated one is neutral per jobagent.
  if (job.startDate !== undefined && job.startDate !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(job.startDate) || job.startDate < policy.availableFrom) reasons.push('start_date_not_compatible');
  }
  if (!policy.allowedHosts.includes(new URL(job.url).hostname)) reasons.push('host_not_approved');
  return reasons;
}

export function validatePlan(plan) {
  if (!Array.isArray(plan.fields) || !plan.resume?.selector || !plan.resume?.uploadedSelector || !plan.submitSelector || !plan.confirmation?.urlIncludes || !plan.confirmation?.text) throw new Error('Plan needs fields, upload evidence, submit selector, and receipt rules');
  for (const f of plan.fields) {
    if (!['text', 'select', 'combobox', 'checkbox', 'buttongroup', 'radio'].includes(f.type) || !f.selector || !f.key) throw new Error('Invalid field mapping');
    if (f.type === 'combobox' && !f.selectedSelector) throw new Error('Combobox requires a displayed selection selector');
  }
}

// Settled profile facts answer themselves. A field marked source:"approval" carries wording
// the user has to see first, so it resolves only from an approval recorded for that company
// and otherwise lands in `pending` rather than quietly blocking with a missing-answer error.
export function resolveAnswers(plan, profile, bank = {}) {
  const answers = {}, pending = [];
  for (const f of plan.fields) {
    if (f.source === 'approval') {
      if (!f.question) throw new Error(`Field awaiting approval must carry its question text: ${f.key}`);
      const entry = bank[questionId(f.question)];
      if (!entry?.approvedAt) { pending.push({key: f.key, question: f.question, type: f.type, draft: f.draft ?? ''}); continue; }
      answers[f.key] = entry.answer;
      continue;
    }
    const answer = profile.answers[f.key];
    if (answer === undefined || answer === null || answer === '') throw new Error(`Missing confirmed answer: ${f.key}`);
    if (f.type === 'checkbox' && typeof answer !== 'boolean') throw new Error(`Expected boolean: ${f.key}`);
    answers[f.key] = answer;
  }
  return {answers, pending};
}

export function answersFor(plan, profile, bank = {}) {
  const {answers, pending} = resolveAnswers(plan, profile, bank);
  if (pending.length) throw new Error(`Awaiting your approval for: ${pending.map(p => p.key).join(', ')}`);
  return answers;
}

export function fingerprint(job, plan, answers, resume) {
  return createHash('sha256').update(JSON.stringify({job, plan, answers})).update(resume).digest('hex');
}

export function assertApproval(state, digest) {
  if (state.status !== 'approved' || state.fingerprint !== digest) throw new Error('Exact current application package has not been approved');
}

export function receiptMatches(url, body, rule, origin) {
  return new URL(url).origin === origin && new URL(url).pathname.includes(rule.urlIncludes) && body.includes(rule.text);
}

// Employers cap how many roles one person may apply to in a window. Exceeding it does not
// fail loudly at submission time: every application still returns a receipt, and the whole
// batch is thrown out days later. Counting what has already gone in is the only way to see it.
export function capExceeded(company, policy, submissions, now = new Date()) {
  const cap = policy?.applicationCaps?.[company];
  if (!cap) return null;
  const since = new Date(now.getTime() - cap.days * 86400000);
  // Reconciliation preserves submittedAt for audit even when the employer explicitly
  // rejected the attempt. Only that retry-safe terminal status releases cap capacity;
  // pending, uncertain and legacy timestamp-only records still count.
  const counted = submissions.filter(s => s.status !== 'verification_not_accepted' && s.company === company && new Date(s.submittedAt) >= since);
  if (counted.length < cap.max) return null;
  const next = new Date(Math.min(...counted.map(s => new Date(s.submittedAt).getTime())) + cap.days * 86400000);
  return {company, max: cap.max, days: cap.days, counted: counted.length,
          nextEligible: next.toISOString().slice(0, 10)};
}

// Human verification resumes the same reviewed package; it never erases uncertain history.
export function assertHumanHandoff(state, digest) {
  if (state.status !== 'needs_human_verification') throw new Error('Only a verification-blocked application may enter human handoff; reconcile other outcomes first');
  if (state.fingerprint !== digest) throw new Error('The handoff package differs from the approved submission attempt');
}
