// Domain guard — makes the autopilot behave like a considerate client instead of a burst of identical
// automated hits from one IP (which is what actually trips ATS/WAF bot+spam heuristics). This is the
// OPPOSITE of evasion: we don't hide what we are, we just stop hammering.
//
// Two jobs:
//   1) COOLDOWNS  — after we apply to / get blocked by / fail to sign into a site, that site's key goes
//      into pipeline/domain_cooldown.json with an `until` timestamp. No worker will pick a job on a
//      cooling-down key until it expires. 403 / anti-bot walls / repeated sign-in fails set LONG cools;
//      a normal successful apply sets a SHORT spacing cool so we don't machine-gun the same tenant.
//   2) FAIL COUNTING — repeated sign-in failures to the same tenant look like credential stuffing, so
//      after a couple of fails we stop trying that tenant for hours (noteSignInFail).
//
// Key granularity: per ATS *tenant/company*, not per raw URL.
//   - subdomain-per-tenant hosts (rtx.wd1.myworkdayjobs.com, careers-x.icims.com) -> full hostname
//   - shared hosts (boards.greenhouse.io/<co>, jobs.lever.co/<co>, jobs.ashbyhq.com/<co>) -> host + '/<co>'
// so throttling RTX's Workday never throttles Honeywell's, but two hits to RTX ARE spaced.
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'pipeline', 'domain_cooldown.json');

// tunables (seconds)
const SPACING_AFTER_APPLY = 12 * 60;      // don't re-hit the same tenant within 12 min of an apply
const COOL_ANTIBOT        = 12 * 60 * 60; // 403 / "access denied" / anti-bot interstitial → 12h
const COOL_SPAM           = 24 * 60 * 60; // ATS flagged our submission as spam → 24h
const COOL_SIGNIN_FAIL    = 6 * 60 * 60;  // after MAX_SIGNIN_FAILS failed logins → 6h
const MAX_SIGNIN_FAILS    = 1;   // 2026-09-27: cool on the FIRST failed sign-in — re-trying the same tenant is what burned 100-min agent sessions (20 account steps, 4 submits)

function key(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    const seg = u.pathname.split('/').filter(Boolean)[0] || '';
    // shared-host ATS: group by the company path segment
    if (/(^|\.)greenhouse\.io$|(^|\.)lever\.co$|(^|\.)ashbyhq\.com$|(^|\.)smartrecruiters\.com$|(^|\.)jobvite\.com$/.test(h) && seg) {
      return h + '/' + seg.toLowerCase();
    }
    return h;
  } catch { return (url || '').split('?')[0].slice(0, 80); }
}

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function save(o) {
  // prune expired + stale-fail entries so the file stays tiny
  const now = Date.now();
  for (const k of Object.keys(o)) {
    const e = o[k];
    if ((!e.until || e.until < now) && (!e.failAt || now - e.failAt > 12 * 60 * 60 * 1000)) delete o[k];
  }
  const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, FILE);
}

// is this url's tenant currently cooling down? -> { blocked, until, reason, secsLeft }
function status(url) {
  const k = key(url); const e = load()[k]; const now = Date.now();
  if (e && e.until && e.until > now) {
    return { blocked: true, key: k, until: e.until, reason: e.reason || 'cooldown', secsLeft: Math.round((e.until - now) / 1000) };
  }
  return { blocked: false, key: k };
}

function cool(url, seconds, reason) {
  const o = load(); const k = key(url);
  const until = Date.now() + seconds * 1000;
  o[k] = Object.assign({}, o[k], { until: Math.max(until, (o[k] && o[k].until) || 0), reason: reason || 'cooldown' });
  save(o); return { key: k, until: o[k].until, reason: o[k].reason };
}

// call after a successful application → short spacing window before the same tenant is hit again
function noteApply(url) { return cool(url, SPACING_AFTER_APPLY, 'spacing (applied)'); }
// call on 403 / anti-bot interstitial → long back-off, stop hitting this site
function noteAntiBot(url, reason) { return cool(url, COOL_ANTIBOT, reason || 'anti-bot wall'); }
// call when an ATS flags our submission as spam
function noteSpam(url) { return cool(url, COOL_SPAM, 'flagged as spam'); }
// call on a failed sign-in → count; after MAX_SIGNIN_FAILS, cool the tenant for hours (stops the
// credential-stuffing pattern of re-running the driver against the same login).
function noteSignInFail(url) {
  const o = load(); const k = key(url);
  const fails = ((o[k] && o[k].fails) || 0) + 1;
  o[k] = Object.assign({}, o[k], { fails, failAt: Date.now() });
  if (fails >= MAX_SIGNIN_FAILS) { o[k].until = Date.now() + COOL_SIGNIN_FAIL * 1000; o[k].reason = `${fails} sign-in fails`; }
  save(o); return { key: k, fails, cooled: fails >= MAX_SIGNIN_FAILS };
}
// call on any success → clear fail count + cooldown for this tenant
function clear(url) { const o = load(); const k = key(url); if (o[k]) { delete o[k]; save(o); } return { key: k }; }

// the set of tenant keys that are currently cooling down (used by the claimer to skip them)
function blockedKeys() {
  const o = load(); const now = Date.now(); const out = {};
  for (const k of Object.keys(o)) if (o[k].until && o[k].until > now) out[k] = o[k].until;
  return out;
}

// Deterministic anti-bot / spam page-content detector. The drivers call this on page load AND after a
// submit so we back off WITHOUT relying on the LLM to notice (which was unreliable → repeated hits →
// escalating flags/ban risk, 2026-09-26). Returns 'antibot' | 'spam' | null.
const ANTIBOT_RE = /just a moment|cloudflare (ray id|to restore access|is checking|security)|ray id:|cf[-_]chl|attention required!?|access (to this page )?(has been )?denied|unusual traffic|we (think|believe) (you|your browser)(?:'| a)?re? (a )?(robot|bot|human)|are you a (human|robot)|verify (you are|you.?re|your identity)|press & hold|perimeterx|datadome|px-captcha|checking your browser|enable javascript and cookies|bot ?detection|automated (access|traffic|requests?)|please verify you are human/i;
const SPAM_RE = /flagged as (possible )?spam|looks like spam|possible spam|we could ?n.?t (submit|process|complete|verify)|submission (was )?(flagged|blocked|rejected|could not)|detected (unusual|automated|suspicious)|too many (requests|attempts|submissions)/i;
// 2026-09-28: the bare word "cloudflare" used to be an anti-bot signature — every CLOUDFLARE job posting
// (brand name all over the JD) was flagged as a wall and the tenant cooled 12h. Only challenge-page
// markers count now (ray id / "is checking your browser" / cf-chl), not the company name.
function sniff(text) {
  const t = String(text || '');
  if (SPAM_RE.test(t)) return 'spam';
  if (ANTIBOT_RE.test(t)) return 'antibot';
  return null;
}

module.exports = { key, status, cool, noteApply, noteAntiBot, noteSpam, noteSignInFail, clear, blockedKeys, sniff };

if (require.main === module) {
  const [op, url, arg] = process.argv.slice(2);
  const r =
    op === 'status'   ? status(url) :
    op === 'antibot'  ? noteAntiBot(url, arg) :
    op === 'spam'     ? noteSpam(url) :
    op === 'signinfail' ? noteSignInFail(url) :
    op === 'apply'    ? noteApply(url) :
    op === 'cool'     ? cool(url, parseInt(arg || '3600', 10), 'manual') :
    op === 'clear'    ? clear(url) :
    op === 'blocked'  ? blockedKeys() :
    { usage: 'status|antibot|spam|signinfail|apply|cool <secs>|clear|blocked <url>' };
  console.log(JSON.stringify(r, null, 1));
}
