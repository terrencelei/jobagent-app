// LIVE CAPTCHA BENCHMARK (2026-10-16) — the real vendors' own demo pages, verified by THEIR servers.
//   node automation/tests/captcha_live_bench.js [types…] [--n 3] [--gap 90]
//   types: recaptcha hcaptcha turnstile turnstile2 geetest text mtcaptcha   (default: all)
// Each run: fresh tab → our solver (captcha_solver.solveIfPresent, exactly what the drivers call) → the page's own
// submit/check → the site's verdict. Results append to pipeline/captcha_bench.jsonl; a summary per type is printed.
// THROTTLED ON PURPOSE: this shares the home IP with the real applications. A few runs per type, minutes apart, and a
// type stops at the first "automated queries" / rate-limit signal (a burned IP costs real applications).
const fs = require('fs'), os = require('os'), path = require('path');
const st = require('../stealth');
const solver = require('../captcha_solver');
solver.setContext({ via: 'bench' });

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const N = +opt('n', 3), GAP = +opt('gap', 90) * 1000;
const OUT = path.join(__dirname, '..', '..', 'pipeline', 'captcha_bench.jsonl');
// the solver's code version: the panel scores the newest version separately from older runs
const REV = require('crypto').createHash('sha1').update(['captcha_solver.js', 'captcha_service.py', 'stealth.js'].map((f) => { try { return fs.readFileSync(path.join(__dirname, '..', f)); } catch { return ''; } }).join('')).digest('hex').slice(0, 8);
const RATE = /automated queries|try again later|too many (requests|attempts)|rate limit/i;
const text = (p) => p.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 3000)).catch(() => '');
const clickText = async (p, re) => { const b = p.locator('button, input[type=submit]').filter({ hasText: re }).first(); if (await b.count()) { await b.click({ timeout: 5000 }).catch(() => {}); return true; } return false; };

const CASES = {
  recaptcha: { url: 'https://www.google.com/recaptcha/api2/demo', gap: Math.max(GAP, 120000),
    submit: async (p) => p.click('#recaptcha-demo-submit', { timeout: 5000 }).catch(() => {}),
    ok: (t) => /verification success/i.test(t) },
  hcaptcha: { url: 'https://accounts.hcaptcha.com/demo',
    submit: async (p) => p.click('#hcaptcha-demo-submit', { timeout: 5000 }).catch(() => {}),
    ok: (t) => /"success":\s*true|verification success|success!/i.test(t) && !/"success":\s*false/i.test(t) },
  turnstile: { url: 'https://demo.turnstile.workers.dev/',
    submit: async (p) => { await p.fill('[name=user]', 'demo', { timeout: 3000 }).catch(() => {}); await p.fill('[name=pass]', 'demo', { timeout: 3000 }).catch(() => {}); await clickText(p, /sign in/i); },
    ok: (t) => /"success":\s*true|success/i.test(t) && !/"success":\s*false|failure|error-codes":\s*\["/i.test(t) },
  turnstile2: { url: 'https://2captcha.com/demo/cloudflare-turnstile', submit: (p) => clickText(p, /^check$/i), ok: (t) => /captcha is passed successfully/i.test(t) },
  // a REAL job form (odoo.com careers): interaction-only Turnstile, stricter than the demos (it caught the locale emulation).
  // Nothing is submitted: ok = Cloudflare issued a token to the form.
  odoo: { url: 'https://www.odoo.com/jobs/apply/2804', gap: Math.max(GAP, 60000), submit: async () => {},
    okPage: (p) => p.evaluate(() => ((document.querySelector('input[name=turnstile_captcha]') || {}).value || '').length > 100).catch(() => false) },
  geetest: { url: 'https://2captcha.com/demo/geetest-v4',   // the solver presses "Click to verify" itself, as it must on a real site
    submit: (p) => clickText(p, /^check$/i), ok: (t) => /captcha is passed successfully/i.test(t) },
  text: { url: 'https://2captcha.com/demo/normal', submit: (p) => clickText(p, /^check$/i), ok: (t) => /captcha is passed successfully/i.test(t) },
  mtcaptcha: { url: 'https://2captcha.com/demo/mtcaptcha', submit: (p) => clickText(p, /^check$/i), ok: (t) => /captcha is passed successfully/i.test(t) },
};

(async () => {
  const types = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const todo = types.length ? types : Object.keys(CASES);
  const prof = path.join(__dirname, '..', 'browser_profile_bench');
  const ctx = await st.chromium.launchPersistentContext(prof, { headless: true, viewport: { width: 1280, height: 1000 }, locale: 'en-US', timezoneId: 'America/Los_Angeles', args: st.STEALTH_ARGS });   // same options as the drivers
  const summary = {};
  for (const type of todo) {
    const c = CASES[type]; if (!c) { console.log('unknown type', type); continue; }
    summary[type] = { ok: 0, n: 0, autoPass: 0, secs: [] };
    for (let i = 0; i < N; i++) {
      const page = await ctx.newPage(); const t0 = Date.now(); let rec = { ts: new Date().toISOString(), type, run: i + 1, engine: st.ENGINE, rev: REV };
      solver.setContext({ via: 'bench', company: 'benchmark: ' + type, url: c.url });
      try {
        await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3500);
        if (c.pre) await c.pre(page);
        const SH = process.env.BENCH_SHOTS; const shot = (n) => SH && page.screenshot({ path: path.join(SH, `${type}-${i + 1}-${n}.png`) }).catch(() => {});
        await shot('a-before');
        const before = await solver.identify(page);
        const sr = await solver.solveIfPresent(page, 3);
        await shot('b-solved');
        await c.submit(page);
        await page.waitForTimeout(4000);
        await (process.env.BENCH_SHOTS && page.screenshot({ path: path.join(process.env.BENCH_SHOTS, `${type}-${i + 1}-c-verdict.png`) }).catch(() => {}));
        const t = await text(page);
        rec = { ...rec, ok: c.okPage ? !!(await c.okPage(page)) : !!c.ok(t), solved: sr.solved, solverType: sr.type, attempts: sr.attempts, vendorsBefore: solver.vendorText(before), vendorsAfter: sr.vendorText,
          secs: Math.round((Date.now() - t0) / 1000), verdict: t.replace(/\s+/g, ' ').match(/.{0,60}(success|passed|fail|error|invalid|incorrect).{0,60}/i)?.[0] || t.replace(/\s+/g, ' ').slice(0, 120) };
        if (RATE.test(t)) rec.rateLimited = true;
      } catch (e) { rec = { ...rec, ok: false, error: e.message.slice(0, 160), secs: Math.round((Date.now() - t0) / 1000) }; }
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
      const s = summary[type]; s.n++; if (rec.ok) s.ok++; s.secs.push(rec.secs);
      console.log(`${type} #${i + 1}: ${rec.ok ? 'PASS' : 'FAIL'} in ${rec.secs}s — solver ${rec.solverType || '-'} (solved=${rec.solved}) — ${String(rec.verdict || rec.error || '').slice(0, 110)}`);
      await page.close().catch(() => {});
      if (rec.rateLimited) { console.log(`${type}: rate-limited — stopping this type to protect the IP`); break; }
      if (i < N - 1) await new Promise((r) => setTimeout(r, c.gap || GAP));
    }
  }
  await ctx.close();
  console.log('\n=== summary ===');
  for (const [t, s] of Object.entries(summary)) console.log(`${t.padEnd(11)} ${s.ok}/${s.n} (${s.n ? Math.round(100 * s.ok / s.n) : 0}%)  median ${s.secs.sort((a, b) => a - b)[Math.floor(s.secs.length / 2)] || 0}s`);
})().catch((e) => { console.error('FATAL', e.stack); process.exit(1); });
