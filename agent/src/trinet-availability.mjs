// TriNet Hire (app.trinethire.com/companies/<id>-<name>/jobs/<id>-<slug>) keeps a closed job's page up with the
// full description and, in place of an Apply button, "This job is currently not open for applications." (KUNZ 6951,
// lesson 467). Bound to the exact posting: same host, same job path as the posting URL, the notice, no Apply control.
const HOST = 'app.trinethire.com';
const jobPath = url => url.pathname.match(/^\/companies\/[^/]+\/jobs\/(\d+)(?:-[^/]*)?\/?$/)?.[1];

export async function trinetPostingUnavailable(page, job) {
  let posting, current;
  try { posting = new URL(job.url); current = new URL(page.url()); } catch { return null; }
  const trusted = url => url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname === HOST;
  const id = jobPath(posting);
  if (!trusted(posting) || !trusted(current) || !id || jobPath(current) !== id) return null;
  const found = await page.evaluate(() => {
    const notice = (document.body?.innerText.replace(/\s+/g, ' ') ?? '').match(/This job is currently not open for applications\.?/i)?.[0];
    const apply = [...document.querySelectorAll('button,a,[role=button],input[type=submit]')].some(e => /^\s*(?:apply|apply now|apply for this job|apply online)\s*$/i.test((e.innerText || e.value || e.getAttribute('aria-label') || '').replace(/ /g, ' ')));
    return notice && !apply ? notice : null;
  }).catch(() => null);
  return found ? `TriNet Hire says "${found}" for this exact job and offers no Apply control.` : null;
}
