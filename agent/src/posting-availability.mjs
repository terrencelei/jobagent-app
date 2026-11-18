// Greenhouse sends a missing job to its board with error=true, which can then
// redirect to an employer careers page and hide the original closure signal.
export async function greenhousePostingUnavailable(postingUrl, response) {
  let posting;
  try { posting = new URL(postingUrl); } catch { return false; }
  if (posting.protocol !== 'https:' || posting.username || posting.password || posting.port ||
      !['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(posting.hostname)) return false;
  const match = posting.pathname.match(/^\/([a-zA-Z0-9_-]+)\/jobs\/([0-9]+)\/?$/);
  if (!match) return false;
  for (let request = response?.request(); request; request = request.redirectedFrom()) {
    const source = new URL(request.url());
    if (!['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(source.hostname) ||
        source.protocol !== 'https:' || source.port || source.pathname.replace(/\/$/, '') !== `/${match[1]}/jobs/${match[2]}`) continue;
    const prior = await request.response();
    if (!prior || ![301, 302, 303, 307, 308].includes(prior.status())) continue;
    const location = (await prior.allHeaders()).location;
    if (!location) continue;
    const target = new URL(location, source);
    if (target.origin === source.origin && target.pathname === `/${match[1]}` &&
        target.search === '?error=true' && !target.hash) return true;
  }
  return false;
}
// ZipRecruiter can leave an email-entry modal open over an expired posting.
// Require the notice in the exact primary job's section, never recommendation
// cards, hidden templates or a form's mere presence/absence.
export function zipRecruiterSearchRedirect(postingUrl, currentUrl) {
 let posting,current;
 try {posting=new URL(postingUrl);current=new URL(currentUrl);}catch{return false;}
 const trusted=url=>url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['ziprecruiter.com','www.ziprecruiter.com'].includes(url.hostname);
 // Search cards, including a matching title, cannot establish the identity of
 // the opaque listing we originally opened. This is not evidence of expiration.
 return trusted(posting)&&trusted(current)&&/^\/jobs\/v2\/[^/]+\/?$/.test(posting.pathname)&&/^\/jobs-search\/?$/.test(current.pathname);
}

export async function zipRecruiterPostingUnavailable(page, job) {
  let posting, current;
  try { posting = new URL(job.url); current = new URL(page.url()); } catch { return null; }
  if (posting.protocol !== 'https:' || !['ziprecruiter.com', 'www.ziprecruiter.com'].includes(posting.hostname) ||
      current.origin !== posting.origin || current.pathname !== posting.pathname || !job.title || !job.company) return null;
  return page.evaluate(({title, company}) => {
    const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const headings = [...document.querySelectorAll('[data-testid="serp-job-details-title"]')]
      .filter(el => normalize(el.innerText) === normalize(title));
    if (headings.length !== 1) return null;
    for (let section = headings[0].parentElement, depth = 0; section && depth < 6; section = section.parentElement, depth++) {
      if (section.matches('body,html')) return null;
      if (section.querySelectorAll('[data-testid="serp-job-details-title"]').length !== 1) return null;
      const text = section.innerText;
      const notice = text.match(/This job post has\s+expired\s+[^.\n]{1,80}\.\s*Applications are no longer accepted\./i);
      if (notice && normalize(text.slice(0, notice.index)).includes(normalize(company))) return notice[0].replace(/\s+/g, ' ');
      if (section.matches('section,article,main')) return null;
    }
    return null;
  }, {title: job.title, company: job.company}).catch(() => null);
}

// IBM's careers site (careers.ibm.com/<locale>/careers/JobDetail?jobId=N) answers a closed job with
// a client-side redirect to /<locale>/closedjob: "Sorry, this job is closed and we are no longer
// accepting applications". The detail URL itself still returns 202, so only the browser sees it.
// Bound to the exact posting: the run navigated to that JobDetail URL and the same origin moved it
// to its closedjob page. A talent-network form on that page is not an application.
export async function ibmPostingUnavailable(page, job) {
  let posting, current;
  try { posting = new URL(job.url); current = new URL(page.url()); } catch { return null; }
  const trusted = url => url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname === 'careers.ibm.com';
  if (!trusted(posting) || !trusted(current) || !/^\/[a-z]{2}_[A-Z]{2}\/careers\/JobDetail\/?$/.test(posting.pathname) ||
      !/^\d+$/.test(posting.searchParams.get('jobId') ?? '') || !/^\/[a-z]{2}_[A-Z]{2}\/closedjob\/?$/.test(current.pathname)) return null;
  const text = await page.locator('body').innerText().catch(() => '');
  const notice = text.replace(/\s+/g, ' ').match(/Sorry, this job is closed and we are no longer accepting applications/i);
  return notice ? `IBM says "${notice[0]}" for this exact job.` : null;
}

// Amazon answers a removed requisition (account.amazon.jobs/.../jobs/N/apply, even after sign-in)
// by redirecting to www.amazon.jobs/<locale>/jobs/404: "Sorry, the job you're looking for isn't
// available". That page's only inputs are the header job search (a hidden "city" box), which the
// worker must not treat as an application form (Amazon Leo 11845).
export async function amazonPostingUnavailable(page, job) {
  let posting, current;
  try { posting = new URL(job.url); current = new URL(page.url()); } catch { return null; }
  const trusted = url => url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    ['amazon.jobs', 'www.amazon.jobs', 'account.amazon.jobs'].includes(url.hostname);
  if (!trusted(posting) || !trusted(current) || !/\/jobs\/\d+(?:\/apply)?\/?$/.test(posting.pathname) ||
      !/^(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/jobs\/404\/?$/.test(current.pathname)) return null;
  const text = await page.locator('body').innerText().catch(() => '');
  const notice = text.replace(/\s+/g, ' ').match(/Sorry, the job you.re looking for isn.t available/i);
  return notice ? `Amazon says "${notice[0]}" for this exact job.` : null;
}

// Amazon's public posting page (www.amazon.jobs/en/jobs/N) answers a removed requisition with HTTP 404 and
// the same "Sorry, the job you're looking for isn't available" notice, with no sign-in. An open job redirects
// (302) to its slugged URL instead. Checking this before the A to Z sign-in keeps a dead posting (11845) from
// requesting an emailed code at all; the closure is bound to the exact job id, the 404 status and the notice.
export async function amazonPostingClosedPublicly(job, {fetch} = {}) {
  let posting;
  try { posting = new URL(job?.url ?? ''); } catch { return null; }
  if (typeof fetch !== 'function' || posting.protocol !== 'https:' || posting.username || posting.password || posting.port ||
      !['amazon.jobs', 'www.amazon.jobs', 'account.amazon.jobs'].includes(posting.hostname)) return null;
  const id = posting.pathname.match(/^(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/jobs\/(\d+)(?:\/apply)?\/?$/)?.[1];
  if (!id) return null;
  let response;
  try { response = await fetch(`https://www.amazon.jobs/en/jobs/${id}`); } catch { return null; }
  if (!response || response.status() !== 404) return null;
  const text = String(await response.text().catch(() => '')).replace(/<[^>]*>/g, ' ').replace(/&#39;|&apos;|&rsquo;/g, "'").replace(/\s+/g, ' ');
  const notice = text.match(/Sorry, the job you.re looking for isn.t available/i);
  return notice ? `Amazon's public posting page answers 404 with "${notice[0]}" for this exact job.` : null;
}

// A stored job URL that is itself a sign-in page can never open an application: the import kept a login
// redirect instead of the posting (Freeform 13281: MyGreenhouse's my.greenhouse.io/users/sign_in, whose only
// controls are an emailed security code and Google/Apple/LinkedIn single sign-on). Stopping before the browser
// opens keeps the worker from typing his email into that login form and flags the link for correction.
// iCIMS job links imported from its apply redirect end in /jobs/<id>/login; the same job's public page is /jobs/<id>/job
// (Rivian 11925). Rewrite just that shape so it is not mistaken for a sign-in page.
export function icimsPostingUrl(postingUrl) {
  let posting;
  try { posting = new URL(postingUrl); } catch { return null; }
  if (posting.protocol !== 'https:' || posting.username || posting.password || posting.port || !/\.icims\.com$/i.test(posting.hostname)) return null;
  const id = posting.pathname.match(/^\/jobs\/(\d+)\/login\/?$/i)?.[1];
  return id ? `https://${posting.hostname}/jobs/${id}/job` : null;
}

export function signInPagePostingUrl(postingUrl) {
  let posting;
  try { posting = new URL(postingUrl); } catch { return null; }
  if (posting.protocol !== 'https:') return null;
  const path = posting.pathname.replace(/\/+$/, '') || '/';
  if (posting.hostname === 'my.greenhouse.io' && !/^\/jobs\/[A-Za-z0-9_-]+\/\d+$/.test(path)) {
    return `${posting.hostname}${path} is the MyGreenhouse candidate login, not a job posting`;
  }
  if (/(?:^|\/)(?:users\/)?(?:sign_?in|log_?in|sessions\/new)$/i.test(path)) {
    return `${posting.hostname}${path} is a sign-in page, not a job posting`;
  }
  return null;
}

// Apple Careers answers a removed role at its own details URL (jobs.apple.com/<locale>/details/<id>/...) with
// HTTP 200 and an h1 "Page not found." plus "Sorry, this role does not exist or is no longer available." The
// URL does not change, so bind the closure to the exact details path still being shown and the page's h1/notice.
// Its header search box is not an application form (Human Factors Engineer-ARC 11806).
export async function applePostingUnavailable(page, job) {
  let posting, current;
  try { posting = new URL(job.url); current = new URL(page.url()); } catch { return null; }
  const trusted = url => url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname === 'jobs.apple.com';
  const id = posting.pathname.match(/^\/[a-z]{2}-[a-z]{2}\/details\/([0-9][0-9-]*)(?:\/|$)/i)?.[1];
  if (!trusted(posting) || !trusted(current) || !id || current.pathname.match(/^\/[a-z]{2}-[a-z]{2}\/details\/([0-9][0-9-]*)(?:\/|$)/i)?.[1] !== id) return null;
  const found = await page.evaluate(() => {
    const heading = [...document.querySelectorAll('h1')].some(h => /^\s*Page not found\.?\s*$/i.test(h.innerText));
    const notice = document.body?.innerText.replace(/\s+/g, ' ').match(/Sorry, this role does not exist or is no longer available\.?/i)?.[0];
    return heading && notice ? notice : null;
  }).catch(() => null);
  return found ? `Apple says "Page not found. ${found}" for this exact job.` : null;
}

// Meta Careers answers a removed requisition two ways. Its public posting (/jobs/<id>/, /v2/jobs/<id>/) redirects
// to /jobs/position-not-available/ ("Sorry, this job is no longer available"); its signed-in profile page
// (/profile/job_details/<id>/) stays on the URL and shows "The Perfect Job Exists, But This Page Doesn't". That
// heading alone is a generic missing-page notice, so it counts only when Meta's public URL for the same job id
// also redirects to position-not-available (Manufacturing Test Engineering Intern 9850). Meta answers Playwright's request
// client with 400, so the caller passes a plain fetch with redirect: 'manual'.
export async function metaPostingUnavailable(page, job, {fetch} = {}) {
  let posting, current;
  try { posting = new URL(job.url); current = new URL(page.url()); } catch { return null; }
  const trusted = url => url.protocol === 'https:' && !url.username && !url.password && !url.port && ['metacareers.com', 'www.metacareers.com'].includes(url.hostname);
  const idOf = url => url.pathname.match(/^\/(?:profile\/job_details|(?:v2\/)?jobs)\/(\d{6,})\/?$/)?.[1];
  const id = idOf(posting);
  if (!trusted(posting) || !trusted(current) || !id) return null;
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (/^\/jobs\/position-not-available\/?$/.test(current.pathname)) {
    const notice = text.match(/Sorry, this job is no longer available/i);
    return notice ? `Meta redirected this exact job to its position-not-available page: "${notice[0]}".` : null;
  }
  if (idOf(current) !== id || !/The Perfect Job Exists, But This Page Doesn.t/i.test(text) || typeof fetch !== 'function') return null;
  let response;
  try { response = await fetch(`https://www.metacareers.com/jobs/${id}/`); } catch { return null; }
  if (!response || ![301, 302, 303, 307, 308].includes(response.status)) return null;
  let target;
  try { target = new URL(response.headers.get('location') ?? '', 'https://www.metacareers.com/'); } catch { return null; }
  return trusted(target) && /^\/jobs\/position-not-available\/?$/.test(target.pathname)
    ? `Meta shows "The Perfect Job Exists, But This Page Doesn't" for this exact job, and its public posting redirects to position-not-available.`
    : null;
}

// Oracle Recruiting Cloud Candidate Experience answers a closed requisition at its own job URL
// (/hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id>, reached from .../requisitions/preview/<id>, possibly
// on another site of the same tenant) with "This job is no longer available." and a "View all jobs" button,
// and no Apply control (Honeywell Aerospace 12972). Bind it to the same tenant host and requisition id.
export async function oraclePostingUnavailable(page, job, {timeout = 10000} = {}) {
  let posting, current;
  try { posting = new URL(job.url); current = new URL(page.url()); } catch { return null; }
  const trusted = url => url.protocol === 'https:' && !url.username && !url.password && !url.port && /^[a-z0-9-]+\.fa(?:\.[a-z0-9-]+)?\.oraclecloud\.com$/i.test(url.hostname);
  const idOf = url => url.pathname.match(/^\/hcmUI\/CandidateExperience\/[a-z]{2}(?:-[a-z]{2})?\/sites\/[^/]+\/(?:job|requisitions\/preview)\/(\d+)(?:\/|$)/i)?.[1];
  const id = idOf(posting);
  if (!trusted(posting) || !trusted(current) || posting.hostname !== current.hostname || !id || idOf(current) !== id) return null;
  // Oracle CX is a single-page app: right after navigation the body holds only its "Skip to main content" link and
  // the notice (or the Apply control) paints a moment later. Checking that first paint missed the closure (12972,
  // second run), so wait until the page has rendered something beyond that link before deciding.
  const inspect = () => {
    const text = document.body?.innerText.replace(/\s+/g, ' ') ?? '';
    const notice = text.match(/This job is no longer available\.?/i)?.[0];
    const apply = [...document.querySelectorAll('button,a,[role=button]')].some(e => /^\s*apply(?: now)?\s*$/i.test(e.innerText || e.getAttribute('aria-label') || ''));
    const rendered = Boolean(text.replace(/skip to main content/ig, '').trim());
    return {notice: notice ?? null, apply, rendered};
  };
  const deadline = Date.now() + timeout;
  let state = {notice: null, apply: false, rendered: false};
  do {
    state = await page.evaluate(inspect).catch(() => ({notice: null, apply: false, rendered: true}));
    if (state.notice || state.apply || state.rendered || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  } while (!page.isClosed());
  return state.notice && !state.apply ? `Oracle shows "${state.notice}" for this exact requisition and offers no Apply control.` : null;
}

// SuccessFactors Recruiting Marketing (RMK) career sites run on the employer's own domain
// (careers.<employer>.com/job/<slug>/<numeric id>/) and answer a closed requisition at that same URL with
// HTTP 200 and "Thank you for your interest. This position is no longer posted at this time." plus only the
// header search and a job-alert widget (HII 12780). Bound to the exact posting: same host and job id, the
// RMK notice, and no Apply control.
export async function successFactorsPostingUnavailable(page, job) {
  let posting, current;
  try { posting = new URL(job.url); current = new URL(page.url()); } catch { return null; }
  const trusted = url => url.protocol === 'https:' && !url.username && !url.password && !url.port;
  const idOf = url => url.pathname.match(/^\/job\/[^/]+\/(\d+)\/?$/)?.[1];
  const id = idOf(posting);
  if (!trusted(posting) || !trusted(current) || posting.hostname !== current.hostname || !id || idOf(current) !== id) return null;
  const found = await page.evaluate(() => {
    const text = document.body?.innerText.replace(/\s+/g, ' ') ?? '';
    const notice = text.match(/This position is no longer posted at this time\.?/i)?.[0];
    const apply = [...document.querySelectorAll('button,a,[role=button],input[type=submit]')].some(e => /^\s*apply(?: now| for this job)?\s*$/i.test(e.innerText || e.value || e.getAttribute('aria-label') || ''));
    return notice && !apply ? notice : null;
  }).catch(() => null);
  return found ? `The employer's career site says "${found}" for this exact job and offers no Apply control.` : null;
}

// SmartRecruiters sends a closed posting's own apply URL (jobs.smartrecruiters.com/<Company>/<id>-<slug>?oga=true)
// to /oneclick-ui/company/<Company>/publication/<uuid>/expired, which shows only "This job ad has expired" and a
// link to the generic job board (Intuitive 12314; the public postings API reported the ad active:false). Bound
// to the same company slug, the /expired route, the notice, and no Apply control.
export async function smartRecruitersPostingUnavailable(page, job) {
  let posting, current;
  try { posting = new URL(job.url); current = new URL(page.url()); } catch { return null; }
  const trusted = url => url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname === 'jobs.smartrecruiters.com';
  if (!trusted(posting) || !trusted(current)) return null;
  const company = posting.pathname.match(/^\/(?:oneclick-ui\/company\/)?([^/]+)\/\d+(?:-[^/]*)?\/?$/)?.[1];
  const expiredFor = current.pathname.match(/^\/oneclick-ui\/company\/([^/]+)\/publication\/[0-9a-f-]{36}\/expired\/?$/i)?.[1];
  if (!company || !expiredFor || company.toLowerCase() !== expiredFor.toLowerCase()) return null;
  const found = await page.evaluate(() => {
    const text = document.body?.innerText.replace(/\s+/g, ' ') ?? '';
    const notice = text.match(/This job ad has expired\.?/i)?.[0];
    const apply = [...document.querySelectorAll('button,a,[role=button],input[type=submit]')].some(e => /^\s*(?:apply|i'?m interested)(?: now| for this job)?\s*$/i.test(e.innerText || e.value || e.getAttribute('aria-label') || ''));
    return notice && !apply ? notice : null;
  }).catch(() => null);
  return found ? `SmartRecruiters says "${found}" for this exact posting and offers no Apply control.` : null;
}

// LLNL's career site (www.llnl.gov/join-our-team/careers/find-your-job/<...>/<16-digit id>) answers a closed
// requisition at its own URL with HTTP 200, the h2 "This position is no longer posted", a post-details block
// whose id is still the posting id, and only the job-search filters around it (12783, lesson 464). Bound to
// the exact posting: same host, same id in the current URL and in the details block, the notice, and no Apply.
export async function llnlPostingUnavailable(page, job) {
  let posting, current;
  try { posting = new URL(job.url); current = new URL(page.url()); } catch { return null; }
  const trusted = url => url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname === 'www.llnl.gov';
  const idOf = url => url.pathname.match(/^\/join-our-team\/careers\/find-your-job\/(?:[^/]+\/)*(\d{6,})\/?$/)?.[1];
  const id = idOf(posting);
  if (!trusted(posting) || !trusted(current) || !id || idOf(current) !== id) return null;
  const found = await page.evaluate(id => {
    const heading = [...document.querySelectorAll('h1,h2,h3')].map(h => h.innerText.replace(/\s+/g, ' ').trim()).find(t => /^This position is no longer posted\.?$/i.test(t));
    const details = document.getElementById(id);
    const apply = [...document.querySelectorAll('button,a,[role=button],input[type=submit]')].some(e => /^\s*apply(?: now| for this job)?\s*$/i.test((e.innerText || e.value || e.getAttribute('aria-label') || '').replace(/\u00a0/g, ' ')));
    return heading && details && !apply ? heading : null;
  }, id).catch(() => null);
  return found ? `LLNL's career site says "${found}" for this exact job and offers no Apply control.` : null;
}

// A careers site in maintenance answers every page under it with a bare 404 (Hyundai HATCI 15771: each
// careers-americas.hyundai.com/hatci/ path, job and search alike, returned 404 while the site root served
// "Site Maintenance / We will be back soon"). The 404 alone cannot tell a removed posting from the outage,
// so when the posting document answered 404 the probe fetches the site's own root: a maintenance notice or a
// 5xx there makes this a site-wide outage, reported as "Site unavailable" for the queue's cooldown rather
// than Needs help. A normal careers home page (even one listing a "Site Maintenance Technician" job) is not.
const MAINTENANCE_NOTICE = /\b(?:site|scheduled|planned|system|routine) maintenance\b|\b(?:down|offline|unavailable) (?:for|due to) maintenance\b|\bunder(?:going)? (?:scheduled |planned |system )?maintenance\b|\bwe(?:'|’| wi)ll be back (?:soon|shortly|online)\b|\bbe right back\b|\btemporarily unavailable\b/i;
export async function siteMaintenanceOutage(job, {status, fetch} = {}) {
  let posting;
  try { posting = new URL(job?.url ?? ''); } catch { return null; }
  if (status !== 404 || typeof fetch !== 'function' || posting.protocol !== 'https:' || posting.username || posting.password || posting.port) return null;
  let response;
  try { response = await fetch(`${posting.origin}/`); } catch { return null; }
  if (!response) return null;
  const rootStatus = response.status();
  if (rootStatus >= 500) return `${posting.hostname} answers its own home page with HTTP ${rootStatus} and this posting with 404 (site-wide outage).`;
  const html = String(await response.text().catch(() => ''));
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&#39;|&apos;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
  // A real maintenance page is a short notice; a careers home page is long and only mentions maintenance in job titles.
  const notice = (MAINTENANCE_NOTICE.test(title) && title) || (text.length <= 1500 && text.match(MAINTENANCE_NOTICE)?.[0]) || null;
  return notice ? `${posting.hostname} shows a maintenance page ("${notice}") on its home page and answers this posting with 404 (site-wide outage).` : null;
}
