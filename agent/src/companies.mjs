import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import {connectionQuestion} from './answer-scope.mjs';

// A question is recognised across postings by its visible wording alone, so the same
// question asked by a second posting at the same company reuses the approved answer.
export const questionId = q => q.trim().toLowerCase().replace(/\*+/g,'').replace(/\s+/g,' ').trim();
export const companySlug = c => c.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
export const placeholderAnswer = value => /^(?:select(?: one| an? (?:answer|option))?|please select(?: one| an? (?:answer|option))?|choose an? (?:answer|option))\s*(?:\.{3}|…)?$/i.test(String(value??'').trim());

export function bankPath(dir, company) { return `${dir}/${companySlug(company)}.json`; }

// Most multiple-choice questions are the same everywhere: work authorization, citizenship,
// veteran and disability status, clearance, how you heard. Answering those once and reusing
// them is the point of the shared bank; only wording written for one employer stays local.
export const SHARED = '_shared';

export async function loadBank(dir, company) {
  try { return JSON.parse(await readFile(bankPath(dir, company), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return {company, answers: {}}; }
}

// The company's own answers win over a shared one for the same question.
export async function loadAnswers(dir, company) {
  const shared = await loadBank(dir, SHARED);
  const own = await loadBank(dir, company);
  // The same employer appears with and without its legal suffix ("Hyundai America Technical
  // Center" vs "... Center, Inc." for Hyundai 12447); its approved answers apply to both.
  const legal=/[\s,]+(?:inc|llc|ltd|corp|corporation|co|company|incorporated|limited)\.?$/i;
  const alias=legal.test(company)?company.replace(legal,''):`${company} Inc`;
  const twin = alias && companySlug(alias)!==companySlug(company) ? await loadBank(dir, alias) : {answers:{}};
  own.answers = {...twin.answers, ...own.answers};
  const general=Object.fromEntries(Object.entries(shared.answers).filter(([,a])=>!placeholderAnswer(a.answer)&&!connectionQuestion(a.question??'')));
  const scoped=Object.fromEntries(Object.entries(own.answers).filter(([,a])=>!placeholderAnswer(a.answer)));
  return {shared, own, answers: {...general, ...scoped}};
}

export async function saveBank(dir, company, bank) {
  await mkdir(dir, {recursive: true, mode: 0o700});
  const p = bankPath(dir, company);
  const temporary=`${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try{await writeFile(temporary, JSON.stringify(bank, null, 2), {mode: 0o600});await rename(temporary, p);}
  finally{await rm(temporary,{force:true});}
}

// Approvals are recorded per question, never per posting: that is what lets a later
// posting at the same company skip straight to submission.
export function recordApprovals(bank, approvals, jobId) {
  for (const a of approvals) {
    if (a.shared !== undefined && typeof a.shared !== 'boolean') throw new Error('An approval\'s "shared" flag must be a boolean');
    if (!a.question || typeof a.answer !== 'string' || !a.answer.trim()) throw new Error(`Approval needs a question and a non-empty answer: ${a.question ?? '(no question)'}`);
    if(placeholderAnswer(a.answer))throw new Error('Select a real answer before approving');
    const previous=bank.answers[questionId(a.question)];
    if(a.approvedAt&&previous?.approvedAt&&Date.parse(a.approvedAt)<Date.parse(previous.approvedAt))continue;
    bank.answers[questionId(a.question)] = {
      question: a.question.trim(),
      answer: a.answer,
      approvedAt: a.approvedAt??new Date().toISOString(),
      approvedFor: jobId,
      shared: a.shared === true,
      type: a.type,
      sourceCompany: bank.company,
      // The draft he was shown, kept when he changed it, so drafting can learn from his edits.
      ...(typeof a.draft==='string'&&a.draft.trim()&&a.draft.trim()!==a.answer.trim()?{draft:a.draft}:{}),
    };
  }
  return bank;
}

// The same question comes in many wordings ("How did you hear about us?", "...about this role?",
// "(Select One)"). A recognised intent lets an answer approved at one employer be found at the next.
export const INTENTS = [
  ['how-heard', /how did you (first )?(hear|learn|find out|come to know) about|how did you (find|discover) (out about )?(us|this|the|our)|where did you (hear|find|learn) about|(referral|application|candidate) source\b|source of (your )?(application|referral)/i],
  ['phone-type', /phone (device )?type/i],
  ['address-line-1', /^(street )?address( line)? ?1?\s*\*?$|^street address/i],
  ['postal-code', /postal code|zip ?code|^zip\b/i],
  ['city', /^city\s*\*?$/i],
];
export const intentOf = q => INTENTS.find(([, re]) => re.test(String(q).trim()))?.[0] ?? null;

// Lookup order: this exact wording, then the same intent.
export function lookup(bank, label) {
  const intent = intentOf(label);
  const exact=bank[questionId(label)];
  const related=intent?bank[`intent:${intent}`]:undefined;
  return exact&&!placeholderAnswer(exact.answer)?exact:related&&!placeholderAnswer(related.answer)?related:undefined;
}

const GENERIC_WORDS = new Set(['inc', 'corp', 'corporation', 'company', 'the', 'group', 'technologies', 'technology', 'systems', 'labs', 'space', 'industries', 'international', 'holdings', 'usa', 'llc', 'and']);
const companyWords = company => String(company).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));

// An answer is reusable at every employer unless it is prose written for one (a long or multi-line
// answer, or any textarea) or the question or answer names this employer.
export function sharedEligible(question, answer, company = '', type = '') {
  if(connectionQuestion(question))return false;
  // Degree, field and school are per education row and per employer list ("Bachelor's Level
  // Degree" at Micron, "BS" at Draper); sharing one row's choice filled the wrong major elsewhere.
  if(/^(degree|field of study|major|area of study|discipline|school|school or university|university)(?:\s*\([^)]*\))?\s*\*?$/i.test(String(question).trim()))return false;
  const value = String(answer);
  if (type === 'textarea' || /\n/.test(value) || value.length > 150) return false;
  const text = `${question} ${value}`.toLowerCase();
  const names = [String(company).trim(), String(company).trim().split(/\s+/)[0]].filter(n => n.length >= 3).map(n => n.toLowerCase());
  if (names.some(n => text.includes(n))) return false;
  return !companyWords(company).some(w => new RegExp(`\\b${w}\\b`).test(text));
}

// Everything he approves is saved for the employer, and whatever is not employer-specific is also
// learned for every employer, under its wording and its intent.
export async function learnApprovals(dir, company, approvals, jobId) {
  await mkdir(dir,{recursive:true,mode:0o700});
  const lock=`${dir}/.answers.lock`;
  let acquired=false;
  for(let attempt=0;attempt<300;attempt++){
    try{await mkdir(lock);acquired=true;break;}catch(e){
      if(e.code!=='EEXIST')throw e;
      if(Date.now()-(await stat(lock).catch(()=>({mtimeMs:Date.now()}))).mtimeMs>120000)await rm(lock,{recursive:true,force:true});
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  if(!acquired)throw new Error('Approved answer storage is busy; try again');
  try{return await learnLocked(dir,company,approvals,jobId);}finally{await rm(lock,{recursive:true,force:true});}
}

async function learnLocked(dir, company, approvals, jobId) {
  approvals = approvals.filter(a => a?.question && String(a.answer ?? '').trim()&&!placeholderAnswer(a.answer)).map(a => ({...a, answer: String(a.answer)}));
  if (!approvals.length) return {own: 0, shared: 0};
  const own = await loadBank(dir, company);
  recordApprovals(own, approvals, jobId);
  await saveBank(dir, company, own);
  const general = approvals.filter(a => sharedEligible(a.question, a.answer, company, a.type));
  if (!general.length) return {own: approvals.length, shared: 0};
  const shared = await loadBank(dir, SHARED);
  recordApprovals(shared, general.map(a => ({...a, answer: String(a.answer), shared: true})), jobId);
  for (const a of general) {
    const intent = intentOf(a.question);
    if (intent) {
      const candidate=shared.answers[questionId(a.question)],previous=shared.answers[`intent:${intent}`];
      if(!previous?.approvedAt||Date.parse(candidate.approvedAt)>=Date.parse(previous.approvedAt))shared.answers[`intent:${intent}`] = {...candidate, learnedFrom: company};
    }
  }
  await saveBank(dir, SHARED, shared);
  return {own: approvals.length, shared: general.length};
}
