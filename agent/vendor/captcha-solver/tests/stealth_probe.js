// STEALTH FINGERPRINT REGRESSION TEST (2026-10-16) — offline, hidden browser, two fake https origins served from memory.
//   node automation/tests/stealth_probe.js
// Asserts what a site (and a cross-site CAPTCHA iframe) can read is consistent with a real Chrome on this Mac:
// reduced UA without "Headless", client-hint brands + high-entropy values that match the machine (not Playwright's
// x86 / "10_15_7" guess), native WebGL reporting the real GPU, a screen larger than the window with no JS-patched
// properties, webdriver false, and the Sec-CH-UA headers the server receives. Fails loudly if a Playwright or Chrome
// upgrade breaks the client-hint hook (stealth.uachStatus()).
const fs = require('fs'), os = require('os');
const { execSync } = require('child_process');
const st = require('../stealth');

const FAILS = [];
const check = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + JSON.stringify(info))); if (!cond) FAILS.push(name); };
const MAC = execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim();
const ARCH = /arm/i.test(os.arch()) ? 'arm' : 'x86';

const probe = async () => {
  const d = navigator.userAgentData;
  const he = d ? await d.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'fullVersionList']) : {};
  let gl = null;
  try { const c = document.createElement('canvas').getContext('webgl'); const x = c.getExtension('WEBGL_debug_renderer_info');
    gl = { r: c.getParameter(x.UNMASKED_RENDERER_WEBGL), native: /\[native code\]/.test(WebGLRenderingContext.prototype.getParameter.toString()) }; } catch (e) {}
  return { ua: navigator.userAgent, brands: d ? d.brands.map((b) => b.brand) : [], platform: d && d.platform, pv: he.platformVersion, arch: he.architecture,
    bit: he.bitness, full: (he.fullVersionList || []).map((b) => b.brand + ' ' + b.version), webdriver: navigator.webdriver, gl,
    sw: screen.width, sh: screen.height, aw: screen.availWidth, ah: screen.availHeight, iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight,
    screenOwn: Object.getOwnPropertyNames(screen).length, outerOwn: !!Object.getOwnPropertyDescriptor(window, 'outerHeight') && typeof Object.getOwnPropertyDescriptor(window, 'outerHeight').get !== 'function' };
};

(async () => {
  const ctx = await st.chromium.launchPersistentContext(fs.mkdtempSync(os.tmpdir() + '/stealth-probe-'), {
    headless: true, viewport: { width: 1280, height: 1000 }, locale: 'en-US', timezoneId: 'America/Los_Angeles', args: st.STEALTH_ARGS });
  await st.injectStealth(ctx);
  const headers = {};
  await ctx.route('https://site.example/**', (r) => { headers.main = r.request().headers();
    r.fulfill({ status: 200, contentType: 'text/html', body: '<p>main</p><iframe src="https://captcha.other-site.test/w" width="300" height="80"></iframe>' }); });
  await ctx.route('https://captcha.other-site.test/**', (r) => { headers.frame = r.request().headers(); r.fulfill({ status: 200, contentType: 'text/html', body: '<p>widget</p>' }); });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://site.example/');
  await page.waitForTimeout(800);
  check('client-hint hook installed', st.uachStatus() === 'installed', st.uachStatus());

  const m = await page.evaluate(probe);
  const fr = page.frames().find((f) => /other-site/.test(f.url()));
  const f = fr ? await fr.evaluate(probe) : null;
  for (const [where, r] of [['page', m], ['cross-site iframe', f]]) {
    if (!r) { check(where + ' reachable', false, 'no frame'); continue; }
    check(`${where}: UA has no "Headless"`, !/Headless/i.test(r.ua), r.ua);
    check(`${where}: UA version is reduced (Chrome/N.0.0.0)`, /Chrome\/\d+\.0\.0\.0 /.test(r.ua), r.ua);
    check(`${where}: brands include Google Chrome`, r.brands.includes('Google Chrome'), r.brands);
    check(`${where}: platform macOS`, r.platform === 'macOS', r.platform);
    check(`${where}: platformVersion is this Mac (${MAC})`, r.pv === MAC, r.pv);
    check(`${where}: architecture is ${ARCH}`, r.arch === ARCH, r.arch);
    check(`${where}: fullVersionList present`, r.full.some((x) => /^Google Chrome \d+\.\d+\.\d+\.\d+$/.test(x)), r.full);
    check(`${where}: webdriver false`, r.webdriver === false, r.webdriver);
  }
  check('WebGL renderer is the real GPU, natively', m.gl && m.gl.native && /Apple/.test(m.gl.r), m.gl);
  check('screen is larger than the window', m.sw >= m.ow && m.sh >= m.oh && m.ow >= m.iw && m.oh >= m.ih, m);
  check('available area fits inside the screen', m.aw <= m.sw && m.ah <= m.sh, m);
  check('no JS-patched screen/outer properties', m.screenOwn === 0 && !m.outerOwn, { screenOwn: m.screenOwn, outerOwn: m.outerOwn });
  for (const [where, h] of [['page', headers.main], ['iframe', headers.frame]]) {
    check(`${where} request: User-Agent header reduced, not headless`, h && /Chrome\/\d+\.0\.0\.0 /.test(h['user-agent']) && !/Headless/.test(h['user-agent']), h && h['user-agent']);
    check(`${where} request: Sec-CH-UA names Google Chrome`, h && /"Google Chrome"/.test(h['sec-ch-ua'] || ''), h && h['sec-ch-ua']);
  }
  await ctx.close();
  // locale / timezone that merely restate this Mac's must not be emulated (odoo.com's Turnstile never issued a token under
  // locale emulation, 2026-10-16) — the live guard is `captcha_live_bench.js odoo`
  const code = fs.readFileSync(require('path').join(__dirname, '..', 'stealth.js'), 'utf8');
  check('stealth drops a locale/timezone that equals the Mac\'s own (no emulation)', /function nativeLocaleTz/.test(code) && /opts = nativeLocaleTz\(opts\)/.test(code), 'nativeLocaleTz missing');
  // the live session browser (session.js / lib.js) uses a 1280×1600 viewport: the screen must still hold the window
  const tall = await st.chromium.launchPersistentContext(fs.mkdtempSync(os.tmpdir() + '/stealth-probe-'), { headless: true, viewport: { width: 1280, height: 1600 }, args: st.STEALTH_ARGS });
  const tp = tall.pages()[0] || await tall.newPage();
  await tp.route('https://tall.example/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>t</p>' }));
  await tp.goto('https://tall.example/');
  const t = await tp.evaluate(probe);
  check('1280×1600 viewport: screen holds the window', t.sw >= t.ow && t.sh >= t.oh && t.oh >= t.ih && t.aw <= t.sw, { sw: t.sw, sh: t.sh, ow: t.ow, oh: t.oh, ih: t.ih });
  await tall.close();
  // a launch that loads an extension must actually load it (branded Chrome ignores --load-extension → Chrome for Testing)
  const EXT = require('path').join(__dirname, '..', '..', 'extension');
  const ex = await st.chromium.launchPersistentContext(fs.mkdtempSync(os.tmpdir() + '/stealth-probe-'), { headless: true, args: [...st.STEALTH_ARGS, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let sw = ex.serviceWorkers(); if (!sw.length) { try { await ex.waitForEvent('serviceworker', { timeout: 8000 }); } catch {} sw = ex.serviceWorkers(); }
  check('a launch with --load-extension really loads the Relay extension', sw.length > 0, { serviceWorkers: sw.length, how: st.extStatus() });
  check('the extension runs on real Chrome (loaded over CDP), not Chrome for Testing', st.extStatus() === 'system-chrome', st.extStatus());
  const ep = ex.pages()[0] || await ex.newPage();
  await ep.route('https://ext.example/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>e</p>' }));
  await ep.goto('https://ext.example/');
  const e = await ep.evaluate(probe);
  check('extension browser: UA and client hints consistent with its own binary', !/Headless/.test(e.ua) && e.pv === MAC && e.arch === ARCH && e.full.some((x) => x.split(' ').pop().split('.')[0] === (e.ua.match(/Chrome\/(\d+)/) || [])[1]), { ua: e.ua.slice(-40), full: e.full, pv: e.pv });
  await ex.close();
  console.log(`\n${FAILS.length ? FAILS.length + ' FAILED' : 'ALL PASS'}`);
  process.exit(FAILS.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
