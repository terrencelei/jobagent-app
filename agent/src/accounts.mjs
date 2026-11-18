// Which email and password to use when an employer's application site asks him to sign in or
// create an account. Since 2026-09-25 he wants every such site to use his profile email and his
// one saved password (WORKDAY_PASSWORD in private/workday.env, or APPLICATION_PASSWORD there if he
// ever keeps a separate one). A site where his password differs gets its own entry in
// private/credentials.json, matched by host. Nothing here prints a password, and the model that
// reads the page never receives one: it only names the field, and the worker types the value.
import {readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv, WORKDAY_ENV} from './workday-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Hiring platforms that host sign-in for many employers. A password is typed only on one of
// these or on the posting's own site, so a link out of a posting can never collect it.
export const HIRING_PLATFORMS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'myworkdaysite.com', 'workday.com',
  'icims.com', 'smartrecruiters.com', 'successfactors.com', 'successfactors.eu', 'sapsf.com', 'ns2cloud.com', 'taleo.net', 'oraclecloud.com',
  'jobvite.com', 'amazon.jobs', 'eightfold.ai', 'avature.net', 'ultipro.com', 'ukg.com', 'paylocity.com', 'bamboohr.com',
  'workable.com', 'dayforcehcm.com', 'brassring.com', 'phenompeople.com', 'rippling.com', 'recruitee.com', 'teamtailor.com',
  'breezy.hr', 'jazzhr.com', 'applytojob.com', 'paycomonline.net', 'adp.com', 'dover.com', 'gem.com', 'recruitingbypaycor.com',
  'clearcompany.com'];

const site = host => host.split('.').slice(-2).join('.');
const within = (host, domain) => host === domain || host.endsWith('.' + domain);

// jobUrl may list several posting URLs: the one in JobAgent and the page it redirected to on
// opening. An Avature tenant (arcbest.avature.net) serves its postings from the employer's own
// domain (careers.arcb.com, ArcBest 12717); that redirect is the posting's own site.
export function passwordAllowedOn(pageUrl, jobUrl) {
  if (Array.isArray(jobUrl)) return jobUrl.some(url => url && passwordAllowedOn(pageUrl, url));
  let page, job;
  try { page = new URL(pageUrl); job = new URL(jobUrl); } catch { return false; }
  if (page.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(page.hostname)) return false;
  if (within(job.hostname, 'amazon.jobs') && page.hostname === 'atozpublic.idprism-auth.amazon.com') return true;
  return site(page.hostname) === site(job.hostname) || HIRING_PLATFORMS.some(d => within(page.hostname, d));
}

const hostOf = value => { try { return new URL(String(value).includes('://') ? value : `https://${value}`).hostname; } catch { return ''; } };

export async function accountFor(pageUrl, {email, root = ROOT, env = process.env} = {}) {
  const host = hostOf(pageUrl);
  let creds = {};
  try { creds = JSON.parse(await readFile(join(root, 'private/credentials.json'), 'utf8')); } catch {}
  const own = Object.values(creds).find(c => (c?.password || c?.sharedPassword === true) && [c.host, c.site, c.tenant, c.url].some(v => v && hostOf(v) === host));
  if (own?.password) return {email: own.email || email, password: own.password, source: 'site'};
  // A site that uses a different sign-in email with his one saved password (Apple ID, 2026-10-18).
  const siteEmail = own?.sharedPassword === true ? own.email : null;
  let file = {};
  try { file = parseEnv(await readFile(root === ROOT ? WORKDAY_ENV : join(root, 'private/workday.env'), 'utf8')); } catch {}
  const password = env.APPLICATION_PASSWORD || file.APPLICATION_PASSWORD || env.WORKDAY_PASSWORD || file.WORKDAY_PASSWORD;
  if (!password) return null;
  return {email: siteEmail || env.APPLICATION_EMAIL || file.APPLICATION_EMAIL || env.WORKDAY_EMAIL || file.WORKDAY_EMAIL || email, password, source: siteEmail ? 'site-shared' : 'shared'};
}

// Only a required "I agree to the terms" box may be ticked when creating an account; marketing,
// text-message and talent-community opt-ins never are.
export const termsCheckbox = label => /\b(terms|privacy|agree|accept|conditions|consent to (the )?processing)\b/i.test(label)
  && !/\b(market|newsletter|sms|text message|texts|promot|offers|updates|talent (community|network)|job alerts?)\b/i.test(label);

// Oracle CX's apply/email page renders its email input about 75 ms after the required terms checkbox and the
// Next button (Howmet 11608), so a snapshot taken in between lists the checkbox with no email control. The
// account-page terms guard reads the live frames as well before refusing to accept a required checkbox.
export async function liveEmailInput(page) {
  for (const frame of page.frames()) {
    try { if (await frame.locator('input[type=email]:visible').count()) return true; } catch {}
  }
  return false;
}

// "Submit" is left out on purpose: on a page that combines the account and the application it
// would send the application, so it goes through the final-review path instead.
export const authButton = label => /^(sign in|sign-in|log in|login|log on|sign up|sign-up|create account|create an account|create my account|register|continue|next|verify)$/i.test(label.trim());
// ApplicantPro links its registration page as "Need an account? Click here!" (X-Bow 12727).
export const authEntry = label => /^(sign in with (a |your )?(username and )?password( instead)?|use (a |your )?password instead|sign in|sign-in|log in|login|sign up|sign-up|create account|create an account|register|sign in to apply|log in to apply|(need|don't have|do not have) an account\?\s*(click here|sign up|register|create (one|an account))!?)$/i.test(label.trim());
export const ssoButton = label => /\b(google|linkedin|apple|facebook|microsoft|github|indeed|sso|single sign)\b/i.test(label);
