// Stealth-enhanced Playwright chromium v3 (2026-10-16).
// Drop-in replacement for `require('playwright')`: the real system Chrome binary, and the fewest possible changes —
// every value a site can read is either Chrome's own, or set at the browser level so it stays consistent everywhere.
//
// What v3 fixed (measured with a fingerprint probe against this machine, not assumed):
//   • UA string: Chrome freezes the UA to "Chrome/<major>.0.0.0" (UA reduction). v2 sent the full build "155.0.8059.80",
//     which no real Chrome sends. Now the reduced form; only "HeadlessChrome" → "Chrome" changes.
//   • UA Client Hints: Playwright derives the hint metadata from the UA string — on a Mac that yields architecture "x86"
//     and platformVersion "10_15_7" (a format no real Chrome emits), next to an Apple-Silicon GPU. The CDP override is
//     corrected at the protocol layer (every target, cross-origin CAPTCHA iframes included) to what this Mac really is:
//     macOS <sw_vers>, arm, 64-bit. Brands / fullVersionList come from the binary itself.
//   • WebGL: v2 hard-coded "Apple M2, Version 15.5". Headless Chrome already reports the real GPU natively ("Apple M2 Pro")
//     — the patch was the wrong chip, the wrong macOS, and a non-native getParameter.toString(). Removed.
//   • Screen: v2 defined own properties on `screen` (detectable) and reported availWidth 1440 > width 1280 (impossible).
//     Removed; the screen size is now emulated natively (Playwright `screen` option) and larger than the viewport.
//   • navigator.webdriver stays false natively via --disable-blink-features=AutomationControlled (no JS override).
//
// Usage:  const { chromium, STEALTH_ARGS, injectStealth } = require('./stealth');

// AURA_PATCHRIGHT=1 → patchright (a Playwright fork that never sends CDP Runtime.enable / Console.enable — the last
// automation tells stealth v3 cannot remove). Same API; page.evaluate runs in an isolated world (the DOM is shared,
// page JS globals are not). Off by default until the live benchmark shows it helps.
const ENGINE = (process.env.AURA_PATCHRIGHT === '1' && (() => { try { require.resolve('patchright'); return true; } catch { return false; } })()) ? 'patchright' : 'playwright';
const { chromium: rawChromium } = require(ENGINE);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ── System Chrome binary ────────────────────────────────────────────────────
// Real Google Chrome (proprietary codecs, Widevine, matching TLS/JA4) instead of Chrome for Testing.
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SYSTEM_CHROME_EXISTS = fs.existsSync(SYSTEM_CHROME);

function findFallbackChromium() {
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    const dirs = fs.readdirSync(cacheDir).filter(d => /^chromium-\d+$/.test(d)).sort();
    for (const d of dirs.reverse()) {
      const bin = path.join(cacheDir, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(bin)) return bin;
    }
  } catch {}
  return null;
}
const CHROME_BIN = SYSTEM_CHROME_EXISTS ? SYSTEM_CHROME : findFallbackChromium();
// BRANDED CHROME IGNORES --load-extension (since Chrome 137). A launch that loads an extension — the Relay engine
// (universal_apply.js), the solver extension — must use Chrome for Testing, or the extension silently never loads
// (2026-10-16: the engine ran without its filler for a day after it was moved to system Chrome).
let CFT_BIN = null;
try { CFT_BIN = rawChromium.executablePath(); if (!fs.existsSync(CFT_BIN)) CFT_BIN = null; } catch {}
CFT_BIN = CFT_BIN || findFallbackChromium();
const loadsExtension = (opts) => (opts.args || []).some((a) => /^--load-extension=/.test(a));
const binaryFor = (opts) => (loadsExtension(opts) && CFT_BIN) ? CFT_BIN : CHROME_BIN;

// ── UA string + client hints, from the actual binary and machine ─────────────
const VERSIONS = {};
function versionOf(bin) {
  if (VERSIONS[bin]) return VERSIONS[bin];
  let v = '155.0.0.0';
  try { const m = execSync(`"${bin}" --version 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).match(/(\d+\.\d+\.\d+\.\d+)/); if (m) v = m[1]; } catch {}
  return (VERSIONS[bin] = v);
}
// macOS Chrome keeps "Intel Mac OS X 10_15_7" in the UA on every Mac (frozen); the real OS lives in the client hints.
const uaFor = (bin) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versionOf(bin).split('.')[0]}.0.0.0 Safari/537.36`;
const CHROME_VERSION = versionOf(CHROME_BIN || SYSTEM_CHROME);
const REAL_UA = uaFor(CHROME_BIN || SYSTEM_CHROME);
let MAC_VERSION = '';
try { MAC_VERSION = execSync('sw_vers -productVersion', { encoding: 'utf8', timeout: 3000 }).trim(); } catch {}
const UA_METADATA = {
  platform: 'macOS',
  platformVersion: MAC_VERSION || '15.0.0',
  architecture: /arm/i.test(os.arch()) ? 'arm' : 'x86',
  bitness: '64',
  model: '',
  mobile: false,
  wow64: false,
};

// Correct Playwright's derived UA metadata at the CDP layer. Playwright sends Emulation.setUserAgentOverride for every
// target it attaches to (pages, cross-origin iframes, workers) through one CRConnection._rawSend; the connection is
// reached through the exported DispatcherConnection (captured on its first dispatch). If a Playwright upgrade moves any
// of this, the hook simply does not install and `uachStatus` says so (tests/stealth_probe.js fails loudly).
let uachStatus = 'not-installed';
let extStatus = 'none';
let DISPATCH = null;
try {
  // the same file playwright itself loads (absolute path → the same module instance; the package's exports map hides it)
  const core = require(path.join(path.dirname(require.resolve(ENGINE)), '..', ENGINE + '-core', 'lib', 'coreBundle.js'));
  const DCP = core.server && core.server.DispatcherConnection && core.server.DispatcherConnection.prototype;
  if (DCP && !DCP.__auraCapture) {
    const orig = DCP.dispatch;
    DCP.dispatch = function (m) { DISPATCH = this; return orig.call(this, m); };
    DCP.__auraCapture = true;
  }
} catch (e) { uachStatus = 'no-dispatcher: ' + e.message.slice(0, 60); }

const fixParams = (params) => (params && params.userAgent)
  ? { ...params, userAgentMetadata: { ...(params.userAgentMetadata || {}), ...UA_METADATA } } : params;

async function installUach(ctx, locale, ua = REAL_UA) {
  try {
    const d = DISPATCH && DISPATCH._dispatcherByGuid && DISPATCH._dispatcherByGuid.get(ctx._guid);
    const conn = d && d._object && d._object._browser && d._object._browser._connection;
    if (!conn || typeof conn._rawSend !== 'function') { uachStatus = 'no-connection'; return false; }
    const proto = Object.getPrototypeOf(conn);
    if (!proto.__auraUach) {
      const orig = proto._rawSend;
      proto._rawSend = function (sessionId, method, params) {
        return orig.call(this, sessionId, method, method === 'Emulation.setUserAgentOverride' ? fixParams(params) : params);
      };
      proto.__auraUach = true;
    }
    // targets that attached before the hook (the first page) get the corrected override now
    const sends = [];
    for (const s of conn._sessions.values()) {
      if (s === conn.rootSession) continue;
      // no acceptLanguage unless a locale was asked for: Chrome's own header is "en-US,en;q=0.9", a forced "en-US" is a tell
      sends.push(s.send('Emulation.setUserAgentOverride', { userAgent: ua, ...(locale ? { acceptLanguage: locale } : {}), userAgentMetadata: UA_METADATA }).catch(() => {}));
    }
    await Promise.all(sends);
    uachStatus = 'installed';
    return true;
  } catch (e) { uachStatus = 'error: ' + e.message.slice(0, 80); return false; }
}

// The browser-level CDP session of a context this module launched (Extensions.loadUnpacked, Browser.* …).
function browserSession(ctx) {
  try {
    const d = DISPATCH && DISPATCH._dispatcherByGuid && DISPATCH._dispatcherByGuid.get(ctx._guid);
    const conn = d && d._object && d._object._browser && d._object._browser._connection;
    return conn ? conn.rootSession : null;
  } catch { return null; }
}

// Locale / timezone EMULATION is a tell (2026-10-16, measured on odoo.com's Turnstile: `locale: 'en-US'` → the token never
// came, 0/1; without it 752 chars at once). This Mac already IS en-US / America/Los_Angeles, so a launch that merely restates
// them gets nothing emulated; only a genuinely different value would be.
const SYS_LOCALE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return 'en-US'; } })();
const SYS_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
function nativeLocaleTz(o) {
  const out = { ...o };
  if (out.locale && SYS_LOCALE && out.locale.toLowerCase() === SYS_LOCALE.toLowerCase()) delete out.locale;
  if (out.timezoneId && SYS_TZ && out.timezoneId === SYS_TZ) delete out.timezoneId;
  return out;
}

// The smallest common Mac display (logical points) that holds the viewport plus window chrome, so a page never sees a
// window bigger than its screen (the drivers use 1280×1000 and 1280×1600 viewports).
const DISPLAYS = [[1512, 982], [1728, 1117], [1920, 1200], [2560, 1440], [3008, 1692], [3840, 2160]];
const screenFor = (vp) => {
  const w = (vp && vp.width) || 1280, h = (vp && vp.height) || 720;
  const [sw, sh] = DISPLAYS.find(([dw, dh]) => dw >= w && dh >= h + 100) || DISPLAYS[DISPLAYS.length - 1];
  return { width: sw, height: sh };
};
const SCREEN = screenFor({ width: 1280, height: 720 });

const chromium = new Proxy(rawChromium, {
  get(target, prop) {
    if (prop === 'launchPersistentContext') {
      return async (userDataDir, opts = {}) => {
        opts = nativeLocaleTz(opts);
        // An extension on REAL Chrome (2026-10-16): branded Chrome ignores --load-extension, so the extension is loaded over
        // CDP (Extensions.loadUnpacked, allowed by --enable-unsafe-extension-debugging). The engine keeps real Chrome's
        // network fingerprint — Chrome for Testing's was reset by odoo.com. Falls back to Chrome for Testing if it fails.
        if (loadsExtension(opts) && SYSTEM_CHROME_EXISTS && !opts.executablePath && !opts.channel && process.env.AURA_EXT_CFT !== '1') {
          const paths = [].concat(...(opts.args || []).filter((a) => /^--load-extension=/.test(a)).map((a) => a.slice('--load-extension='.length).split(',')));
          const args = (opts.args || []).filter((a) => !/^--(load-extension|disable-extensions-except)=/.test(a)).concat('--enable-unsafe-extension-debugging');
          const ignore = Array.isArray(opts.ignoreDefaultArgs) ? opts.ignoreDefaultArgs.concat('--disable-extensions') : ['--disable-extensions'];
          const ua = uaFor(SYSTEM_CHROME);
          const o2 = { ...opts, args, ignoreDefaultArgs: ignore, executablePath: SYSTEM_CHROME, userAgent: opts.userAgent || ua, ...(opts.screen || opts.viewport === null ? {} : { screen: screenFor(opts.viewport) }) };
          let ctx = null;
          try {
            ctx = await target.launchPersistentContext(userDataDir, o2);
            if (!opts.userAgent) await installUach(ctx, opts.locale, ua);
            const bs = browserSession(ctx);
            if (!bs) throw new Error('no browser session');
            for (const p of paths.filter(Boolean)) await bs.send('Extensions.loadUnpacked', { path: p });
            extStatus = 'system-chrome';
            return ctx;
          } catch (e) {
            extStatus = 'cft-fallback: ' + String(e.message || e).slice(0, 80);
            if (ctx) await ctx.close().catch(() => {});
            // fall through to Chrome for Testing with the original arguments
          }
        }
        const bin = opts.executablePath || (!opts.channel && binaryFor(opts));
        if (bin && !opts.executablePath && !opts.channel) opts = { ...opts, executablePath: bin };
        const ua = bin ? uaFor(bin) : null, ours = !opts.userAgent && !!ua;
        if (ours) opts = { ...opts, userAgent: ua };
        if (!opts.screen && opts.viewport !== null) opts = { ...opts, screen: screenFor(opts.viewport) };
        const ctx = await target.launchPersistentContext(userDataDir, opts);
        if (ours) await installUach(ctx, opts.locale, ua);
        return ctx;
      };
    }
    if (prop === 'launch') {
      return async (opts = {}) => {
        const bin = opts.executablePath || (!opts.channel && binaryFor(opts));
        if (bin && !opts.executablePath && !opts.channel) opts = { ...opts, executablePath: bin };
        const ua = bin ? uaFor(bin) : REAL_UA;
        const browser = await target.launch(opts);
        // contexts made from this browser get the same UA + corrected hints
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (o = {}) => {
          const co = nativeLocaleTz({ userAgent: ua, screen: screenFor(o.viewport), ...o });
          const ctx = await newContext(co);
          if (co.userAgent === ua) await installUach(ctx, co.locale, ua);
          return ctx;
        };
        return browser;
      };
    }
    return target[prop];
  }
});

// ── Launch args ─────────────────────────────────────────────────────────────
// Only the Blink automation flag (native webdriver=false) and hygiene flags. The UA is set through the context option
// (which also drives the Sec-CH-UA headers), never with --user-agent (that empties the high-entropy client hints).
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--metrics-recording-only',
  '--no-default-browser-check',
];

// Kept for the callers that still invoke it. v3 injects nothing: every JS-level patch v2 made was either already true
// natively or wrong for this machine, and each one was itself a detectable tell.
async function injectStealth(_context) {}

module.exports = { chromium, browserSession, ENGINE, STEALTH_ARGS, injectStealth, CHROME_BIN, CFT_BIN, REAL_UA, UA_METADATA, uaFor, uachStatus: () => uachStatus, extStatus: () => extStatus };
