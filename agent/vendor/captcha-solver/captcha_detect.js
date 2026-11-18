// Robust "is there a LIVE, UNSOLVED CAPTCHA on this page RIGHT NOW?" detector — the triple-check that
// guarantees Aura only pops a window / notifies when there's genuinely a puzzle in front of Stanley.
//
// Triple-check (all three must hold):
//   1) PRESENT  — a hCaptcha / reCAPTCHA / Turnstile widget exists in the DOM (checkbox or challenge).
//   2) VISIBLE  — that widget has a real on-screen box (not 0-size, not parked off-screen at -10000).
//   3) UNSOLVED — its response token is still empty (a solved captcha has a token → nothing to do).
//
// Returns { live, kind, reason, solved } — live=true ONLY when present && visible && unsolved.
// Used by surface.js to verify before notifying/popping, and to poll for "solved" afterwards.

// 2026-10-16: the main-document check below cannot see a widget nested inside another iframe (iCIMS renders the form —
// and its hCaptcha — inside #icims_content_iframe) or the other vendors (DataDome, GeeTest, PerimeterX, Arkose, AWS WAF,
// text-image …). When it finds nothing live, captcha_solver.identify() looks through every frame; a token already
// issued in any frame still means solved.
async function detect(page) {
  const main = await detectMain(page);
  if (main.live || main.solved) return main;
  try {
    const { identify } = require('./captcha_solver');
    const v = (await identify(page)).filter((x) => x.solvable && x.kind !== 'invisible' && x.vendor !== 'cloudflare');
    if (!v.length) return main;
    let token = false;
    for (const f of page.frames()) {
      if (/challenges\.cloudflare\.com/.test(f.url())) continue;   // script in that frame fails Turnstile (2026-10-22)
      if (await f.evaluate(() => [...document.querySelectorAll('textarea[name*="h-captcha-response"],textarea[name*="g-recaptcha-response"],input[name*="cf-turnstile-response"]')]
        .some((t) => (t.value || '').trim().length > 20) || !!document.querySelector('#recaptcha-anchor[aria-checked="true"]')).catch(() => false)) { token = true; break; }
    }
    if (token) return { ...main, solved: true, reason: 'already-solved(token in a frame)' };
    return { live: true, kind: v[0].vendor, reason: 'LIVE (' + v.map((x) => x.vendor + '/' + x.kind).join(', ') + ')', solved: false, present: true, visible: true, vendors: v };
  } catch { return main; }
}

async function detectMain(page) {
  try {
    return await page.evaluate(() => {
      const onScreen = (el) => {
        const r = el.getBoundingClientRect();
        // rendered, not just sized: hCaptcha parks full-viewport "enclave" frames with visibility:hidden (Lever, 2026-10-16)
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = getComputedStyle(n); if (c.visibility === 'hidden' || c.display === 'none' || +c.opacity === 0) return false; }
        if (/frame=(enclave|checkbox-invisible)/.test(el.src || '')) return false;
        return r.width > 40 && r.height > 40 && r.bottom > 0 && r.right > 0 &&
               r.top < (innerHeight + 200) && r.left < (innerWidth + 200) && r.top > -2000;
      };
      // collect candidate widgets across the main doc (iframes are same-origin-opaque, but their
      // <iframe> elements live in this doc and carry the tell-tale src + are what we size/show).
      const frames = [...document.querySelectorAll('iframe')];
      const hcap = frames.filter(f => /hcaptcha\.com/i.test(f.src || ''));
      // INVISIBLE reCAPTCHA (v3 / v2-invisible / Enterprise score) is NOT a puzzle a human can solve —
      // it's a background bot score. Its badge iframe is on-screen (~256×60) and its token is empty, so
      // it satisfied present+visible+unsolved and produced a false "CAPTCHA ready" pop/push with an
      // unfilled form (Audax, 2026-09-27). Exclude: size=invisible anchors, the grecaptcha-badge, and
      // invisible-configured containers. Only a visible CHECKBOX anchor or a bframe CHALLENGE counts.
      const isInvisibleRecap = (f) => /size=invisible/i.test(f.src || '') || !!f.closest('.grecaptcha-badge') ||
        !!(f.closest('.g-recaptcha,[data-sitekey]') && (f.closest('.g-recaptcha,[data-sitekey]').getAttribute('data-size') || '').toLowerCase() === 'invisible');
      const recap = frames.filter(f => /google\.com\/recaptcha|recaptcha\.net/i.test(f.src || '') && !isInvisibleRecap(f));
      const invisibleOnly = !recap.length && frames.some(f => /google\.com\/recaptcha|recaptcha\.net/i.test(f.src || ''));
      const turn = frames.filter(f => /challenges\.cloudflare\.com/i.test(f.src || ''));
      const cont = [...document.querySelectorAll('.h-captcha,[data-hcaptcha-widget-id],.g-recaptcha,.cf-turnstile,[data-sitekey]')]
        .filter(c => (c.getAttribute('data-size') || '').toLowerCase() !== 'invisible' && !c.closest('.grecaptcha-badge'));

      // response-token fields (present + non-empty ⇒ already solved)
      const tokEls = [...document.querySelectorAll(
        'textarea[name*="h-captcha-response"],textarea[name*="hcaptcha"],textarea[name*="g-recaptcha-response"],input[name*="cf-turnstile-response"]')];
      const token = tokEls.map(t => (t.value || '').trim()).find(v => v.length > 20) || '';

      let kind = null, present = false, visible = false;
      const pick = (arr, k) => { if (arr.length) { present = true; kind = kind || k; if (arr.some(onScreen)) visible = true; } };
      pick(hcap, 'hcaptcha'); pick(recap, 'recaptcha'); pick(turn, 'turnstile');
      // container-based fallback (widget not yet iframed, or custom mount)
      if (cont.length) { present = true; kind = kind || 'captcha'; if (cont.some(onScreen)) visible = true; }

      const solved = token.length > 20;
      const live = present && visible && !solved;
      const reason = !present ? (invisibleOnly ? 'invisible-recaptcha(no puzzle to solve — score-based)' : 'no-captcha-element')
        : solved ? 'already-solved(token present)'
        : !visible ? 'present-but-offscreen/hidden'
        : 'LIVE';
      return { live, kind: kind || null, reason, solved, present, visible };
    });
  } catch (e) {
    return { live: false, kind: null, reason: 'eval-error:' + (e.message || '').slice(0, 40), solved: false };
  }
}

// wait up to timeoutMs for a live captcha to appear (returns the detect() result the moment it's live,
// or the last result if it never went live).
async function waitForLive(page, timeoutMs = 25000, stepMs = 800) {
  const end = Date.now() + timeoutMs; let last = null;
  while (Date.now() < end) {
    last = await detect(page);
    if (last.live) return last;
    await page.waitForTimeout(stepMs);
  }
  return last || { live: false, reason: 'timeout' };
}

// wait up to timeoutMs for a live captcha to be SOLVED / cleared (token appears, or the widget goes
// away / page advances). Returns true if it got solved, false on timeout.
async function waitForSolved(page, timeoutMs = 600000, stepMs = 1500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const d = await detect(page);
    if (d.solved || !d.present || !d.visible) return true;   // token issued, or the puzzle is gone
    await page.waitForTimeout(stepMs);
  }
  return false;
}

module.exports = { detect, waitForLive, waitForSolved };

if (require.main === module) {
  // CLI: node captcha_detect.js  → checks the active tab on CDP_PORT (default 9225)
  (async () => {
    const { chromium } = require('./node_modules/playwright');
    const b = await chromium.connectOverCDP('http://localhost:' + (process.env.CDP_PORT || '9225'));
    const ctx = b.contexts()[0];
    const ps = ctx.pages().filter(p => p.url() !== 'about:blank');
    const p = ps[ps.length - 1] || ctx.pages()[0];
    console.log(JSON.stringify(await detect(p), null, 1));
    await b.close(); process.exit(0);
  })();
}
