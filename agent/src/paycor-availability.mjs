// Paycor Recruiting (recruitingbypaycor.com) answers a closed job's own JobIntroduction page, embedded in the
// employer's careers page (Campbell Scientific 12670: campbellsci.com/open-positions?gni=<id> frames
// JobIntroduction.action?id=<id>) or opened directly, with only "Sorry, this job is no longer active." and a link
// to the careers home (lesson 466). Bound to this posting: an https Paycor JobIntroduction frame whose id is the
// posting URL's own id (a query value, e.g. gni, or the Paycor id itself), the notice, and no Apply control.
const PAYCOR = 'recruitingbypaycor.com';
const postingIds = posting => [...posting.searchParams.values()].filter(v => /^[A-Za-z0-9]{16,}$/.test(v) && /\d/.test(v));

export async function paycorPostingUnavailable(page, job) {
  let posting;
  try { posting = new URL(job.url); } catch { return null; }
  const ids = postingIds(posting);
  if (!ids.length) return null;
  for (const frame of page.frames()) {
    let url;
    try { url = new URL(frame.url()); } catch { continue; }
    const trusted = url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.hostname === PAYCOR || url.hostname.endsWith('.' + PAYCOR));
    if (!trusted || url.pathname !== '/career/JobIntroduction.action' || !ids.includes(url.searchParams.get('id'))) continue;
    const found = await frame.evaluate(() => {
      const notice = (document.body?.innerText.replace(/\s+/g, ' ') ?? '').match(/Sorry, this job is no longer active\.?/i)?.[0];
      const apply = [...document.querySelectorAll('button,a,[role=button],input[type=submit],input[type=button]')].some(e => /^\s*apply(?: now| for this job| online)?\s*$/i.test((e.innerText || e.value || e.getAttribute('aria-label') || '').replace(/ /g, ' ')));
      return notice && !apply ? notice : null;
    }).catch(() => null);
    if (found) return `Paycor says "${found}" for this exact job and offers no Apply control.`;
  }
  return null;
}
