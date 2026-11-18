// CAPTCHA SOLVER v3 — local, automated (2026-10-16).
//
// v3 (audit 2026-10-16) — what changed and why:
//   • FRAMES, NOT TOP-LEVEL LOCATORS. Widgets are found through page.frames() and placed with frame.frameElement()'s box.
//     v2 used page.locator('iframe[src*=…]'), which cannot see an iframe nested inside another iframe (iCIMS renders the
//     application — and its hCaptcha — inside #icims_content_iframe: "Complete the human check", 10+ stops) nor a
//     Turnstile mounted in a closed shadow root (Odoo, 10-15).
//   • TILES FROM THE DOM. Grid tiles are read from the challenge's own elements (reCAPTCHA td.rc-imageselect-tile, hCaptcha
//     .task-image) and numbered where they really are. v2 guessed the grid from the image's aspect ratio — every square
//     image became 3×3 (a 4×4 reCAPTCHA clicked the wrong tiles) and hCaptcha's prompt header shifted every tile.
//   • IDENTIFY. identify(page) names every challenge on the page (vendor + kind + solvable), including true walls (Akamai,
//     Kasada, Incapsula, DataDome hard block) that are never "solved", and score-only reCAPTCHA v3 with nothing to click.
//     Every result carries the vendors, so failures are classed per vendor (self-repair) instead of "CAPTCHA".
//   • CHALLENGE ≠ WALL. clearChallenge(page) is what a driver calls when the page looks like a bot check: a Cloudflare
//     "Just a moment…" interstitial, PerimeterX press-and-hold or a DataDome slider is a challenge — wait for the
//     stealth auto-pass / solve it — and only a true wall is reported ANTIBOT (domain_guard used to cool all of them 12 h
//     on sight, without one attempt).
//   • NEW TYPES: Cloudflare interstitial, PerimeterX/HUMAN press-and-hold, proof-of-work widgets (Friendly Captcha,
//     ALTCHA, mCaptcha), text-image CAPTCHAs (OCR, incl. MTCaptcha / Securimage), DataDome / GeeTest / generic sliders in
//     any frame, ByteDance "select the objects", AWS WAF image CAPTCHA, multi-round Arkose. Arithmetic CAPTCHAs are
//     detected but not answered (CLAUDE.md lists arithmetic among the questions never answered automatically).
//
// Never opens a window. Never tries to get past an edge block (Akamai / Kasada / Incapsula): those are ANTIBOT.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const RELAY = process.env.RELAY_PANEL || 'http://127.0.0.1:8787';
let sharp;
try { sharp = require('sharp'); } catch { sharp = null; }
const DEBUG = !!process.env.CAPTCHA_DEBUG;
const log = (...a) => { if (DEBUG) try { fs.writeSync(2, '[captcha] ' + a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n'); } catch {} };

// ── Human-like input ─────────────────────────────────────────────────────────

async function humanDrag(page, startX, startY, distanceX, opts = {}) {
  const distanceY = opts.verticalDist || 0;
  const overshootX = Math.floor(Math.random() * 4) + 3;
  const steps = 28 + Math.floor(Math.random() * 12);
  await page.mouse.move(startX - 20 - Math.random() * 30, startY + 10 + Math.random() * 10, { steps: 4 });
  await page.mouse.move(startX, startY, { steps: 6 });
  await page.waitForTimeout(80 + Math.floor(Math.random() * 60));
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 3);
    await page.mouse.move(startX + (distanceX + overshootX) * ease, startY + distanceY * ease + Math.sin(t * Math.PI * 2) * 2.5);
    await page.waitForTimeout(8 + Math.floor(Math.random() * 10));
  }
  await page.waitForTimeout(90 + Math.floor(Math.random() * 60));
  await page.mouse.move(startX + distanceX, startY + distanceY + 1, { steps: 5 });
  await page.waitForTimeout(120 + Math.floor(Math.random() * 80));
  await page.mouse.up();
}

async function humanClick(page, x, y) {
  const jx = x + (Math.random() - 0.5) * 4;
  const jy = y + (Math.random() - 0.5) * 4;
  await page.mouse.move(jx, jy, { steps: 6 + Math.floor(Math.random() * 6) });
  await page.waitForTimeout(40 + Math.floor(Math.random() * 60));
  await page.mouse.click(jx, jy);
}

async function humanDragTo(page, fromX, fromY, toX, toY) {
  const steps = 30 + Math.floor(Math.random() * 15);
  await page.mouse.move(fromX, fromY, { steps: 5 });
  await page.waitForTimeout(100 + Math.floor(Math.random() * 80));
  await page.mouse.down();
  await page.waitForTimeout(60 + Math.floor(Math.random() * 40));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(fromX + (toX - fromX) * ease + (Math.random() - 0.5) * 3, fromY + (toY - fromY) * ease + (Math.random() - 0.5) * 3);
    await page.waitForTimeout(6 + Math.floor(Math.random() * 12));
  }
  await page.mouse.move(toX, toY, { steps: 3 });
  await page.waitForTimeout(150 + Math.floor(Math.random() * 100));
  await page.mouse.up();
  await page.waitForTimeout(200 + Math.floor(Math.random() * 100));
}

// ── Solver backends ──────────────────────────────────────────────────────────

async function callSolverApi(payload) {
  try {
    const res = await fetch(RELAY + '/api/solve_captcha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) return { ok: false, error: 'API returned ' + res.status };
    const text = await res.text();
    if (!text) return { ok: false, error: 'empty response' };
    return JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'API call failed: ' + (e.message || '').slice(0, 100) };
  }
}

// ── Local model service (automation/captcha_service.py: ddddocr OCR + slider, faster-whisper audio, YOLO reCAPTCHA) ──
// Started on first use (detached, its own venv); every caller falls back to the older paths when it is unavailable.
const SVC = 'http://127.0.0.1:' + (process.env.AURA_CAPTCHA_PORT || 8796);
let svcStarting = null;
async function svcUp() { try { const r = await fetch(SVC + '/health', { signal: AbortSignal.timeout(1500) }); return r.ok && (await r.json()).ok === true; } catch { return false; } }
async function ensureSvc() {
  if (await svcUp()) return true;
  if (!svcStarting) svcStarting = (async () => {
    const py = path.join(__dirname, 'captcha_env', 'bin', 'python');
    if (!fs.existsSync(py)) return false;
    const out = fs.openSync(path.join(__dirname, '..', 'pipeline', 'captcha_service.log'), 'a');
    spawn(py, [path.join(__dirname, 'captcha_service.py')], { detached: true, stdio: ['ignore', out, out] }).unref();
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); if (await svcUp()) return true; }
    return false;
  })().finally(() => { svcStarting = null; });
  return svcStarting;
}
async function svc(route, body, timeoutMs = 120000) {
  if (process.env.AURA_CAPTCHA_LOCAL === '0') return { ok: false, error: 'local models disabled (AURA_CAPTCHA_LOCAL=0)' };   // mechanics tests
  if (!(await ensureSvc())) return { ok: false, error: 'local model service unavailable' };
  try {
    const r = await fetch(SVC + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return await r.json();
  } catch (e) { return { ok: false, error: 'service: ' + (e.message || '').slice(0, 100) }; }
}

// ── Gemini (free API key, optional): GEMINI_API_KEY in the environment or ~/aura/.env ──
function geminiKey() {
  if (process.env.AURA_GEMINI === '0') return null;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try { const m = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').match(/^\s*GEMINI_API_KEY\s*=\s*(.+)$/m); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null; } catch { return null; }
}
async function geminiJson(imageBuf, prompt, model = process.env.AURA_GEMINI_MODEL || 'gemini-2.5-flash') {
  const key = geminiKey(); if (!key) return null;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'image/png', data: imageBuf.toString('base64') } }, { text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' } }) });
    const j = await r.json();
    if (j.error) { log('gemini error', j.error.code, String(j.error.message).slice(0, 120)); return null; }
    const t = (((j.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || '').join('') || '';
    const m = t.match(/[\[{][\s\S]*[\]}]/); return m ? JSON.parse(m[0]) : null;
  } catch (e) { log('gemini failed', e.message); return null; }
}
// vision for anything that needs judgement: Gemini when a key exists, Claude otherwise (and when Gemini fails)
// 2026-10-19: Claude gets the image INLINE (claudeVision) — the old llm.js --image path made the model spend a turn on the
// Read tool and died with error_max_turns intermittently (every hCaptcha bench run from 10-17 13:00 to 10-19 07:40 had
// "j": null on every round: 2/10 solved). The old path stays as the last fallback.
let VISION_DECLINED = false;   // set when the vision model refused during this solve; reset per solveIfPresent
async function visionJson(imageBuf, prompt) {
  const g = await geminiJson(imageBuf, prompt);
  if (g && typeof g === 'object') return g;
  const c = await claudeVision(imageBuf, prompt);
  if (c && typeof c === 'object') return c;
  if (VISION_DECLINED) return null;   // the fallbacks reach the same model
  log('vision: inline call gave nothing — trying the llm.js --image path');
  return vlmJson(imageBuf, prompt);
}

// the last JSON object/array in a model reply
function lastJson(text) {
  const s = String(text || '').replace(/```(?:json)?/g, '');
  const cands = s.match(/\{[\s\S]*\}|\[[\s\S]*\]/g) || [];
  for (const c of cands.reverse()) { try { return JSON.parse(c); } catch {} }
  // a reply with prose around several objects: take the last balanced {...}
  for (let i = s.lastIndexOf('{'); i >= 0; i = s.lastIndexOf('{', i - 1)) {
    let depth = 0;
    for (let k = i; k < s.length; k++) { if (s[k] === '{') depth++; else if (s[k] === '}' && --depth === 0) { try { return JSON.parse(s.slice(i, k + 1)); } catch {} break; } }
    if (i === 0) break;
  }
  return null;
}
function claudeCli() {
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  if (fs.existsSync(local)) return local;
  try { return require('./llm').claudeBin(); } catch { return null; }
}
// One turn, no tools, the image as a base64 content block on stdin (stream-json). ~5 s per call.
// Usage limit on one model → the next one down (same prompt).
const VISION_MODEL = process.env.AURA_CAPTCHA_VISION_MODEL || 'sonnet';
const VISION_NEXT = { opus: 'sonnet', sonnet: 'haiku' };
async function claudeVision(imageBuf, prompt, model = VISION_MODEL, timeoutMs = 90000) {
  // replica tests: a mock answers (or says {passthrough:true} to let the real model answer)
  if (process.env.AURA_CAPTCHA_VISION_MOCK) {
    try {
      const r = await fetch(process.env.AURA_CAPTCHA_VISION_MOCK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'vision', prompt, image_b64: imageBuf.toString('base64') }) });
      const j = await r.json();
      if (j.declined) { VISION_DECLINED = true; trace('vision model declined to solve (left for Stanley)'); return null; }
      if (!j.passthrough) return j.answer ?? null;
    } catch { return null; }
  }
  return claudeVisionCli(imageBuf, prompt, model, timeoutMs);
}
function claudeVisionCli(imageBuf, prompt, model, timeoutMs) {
  const bin = claudeCli();
  if (!bin || process.env.AURA_CAPTCHA_VISION === '0') return Promise.resolve(null);
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-vis-'));
    const msg = { type: 'user', message: { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBuf.toString('base64') } },
      { type: 'text', text: prompt }] } };
    let p;
    try {
      p = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', '1',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', ''], { cwd, env: { ...process.env, MAX_THINKING_TOKENS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { log('vision spawn failed', e.message); return resolve(null); }
    let out = ''; const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => {});
    p.on('close', () => {
      clearTimeout(t); try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      let res = null;
      for (const line of out.split('\n').reverse()) { if (!line.trim()) continue; try { const d = JSON.parse(line); if (d.type === 'result') { res = d; break; } } catch {} }
      if (!res) { log('vision: no result line'); return resolve(null); }
      if (res.is_error || res.subtype !== 'success') {
        log('vision error', res.subtype, String(res.result || '').slice(0, 120));
        const next = /limit|overloaded|rate/i.test(String(res.result || '')) && VISION_NEXT[model];
        return next ? claudeVisionCli(imageBuf, prompt, next, timeoutMs).then(resolve) : resolve(null);
      }
      const j = lastJson(res.result);
      // THE MODEL DECLINED (2026-10-19, Waabi/Lever): a reply with no JSON that says it will not do this is a refusal, not
      // a parse failure. It is recorded and the solve stops; the prompt is never reworded to get past it — the job goes to
      // Stanley (the engine's CAPTCHA → his-browser path).
      if (!j && /can.?t help|won.?t (help|pick|solve|do)|cannot (help|assist)|not able to help|defeat (that|the) check|verify that a human/i.test(String(res.result || ''))) {
        VISION_DECLINED = true; trace('vision model declined to solve (left for Stanley)'); log('vision declined:', String(res.result).slice(0, 120));
      }
      resolve(j);
    });
    p.stdin.end(JSON.stringify(msg) + '\n');
  });
}

// a free-form vision answer (OCR, slider positions, Arkose rounds): the image goes to llm.js and the reply's last JSON
// object is returned
function vlmJson(imageBuf, prompt, model = 'sonnet', timeoutMs = 120000) {
  return new Promise((resolve) => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aura-vlm-')), 'c.png');
    fs.writeFileSync(tmp, imageBuf);
    const p = spawn(process.execPath, [path.join(__dirname, 'llm.js'), model, '--image', tmp], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => {
      clearTimeout(t); try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch {}
      const m = out.match(/\{[\s\S]*\}/g); let j = null;
      for (const s of (m || []).reverse()) { try { j = JSON.parse(s); break; } catch {} }
      resolve(j);
    });
    p.stdin.end(prompt);
  });
}

// ── Geometry ─────────────────────────────────────────────────────────────────

// a frame's iframe box relative to the main viewport (works for nested frames and closed shadow roots)
// (scrolls only a VISIBLE frame that sits off-screen, with a short timeout: scrollIntoViewIfNeeded on a hidden iframe —
// an hCaptcha challenge frame before it opens — waits out Playwright's 30 s visibility timeout on every check)
async function frameBox(frame) {
  try {
    const el = await frame.frameElement();
    let b = await el.boundingBox();
    const vp = (frame.page && frame.page().viewportSize()) || { width: 1280, height: 1000 };
    if (b && b.width > 0 && b.height > 0 && (b.y < 0 || b.y + b.height > vp.height || b.x < 0 || b.x + b.width > vp.width)) {
      await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      b = await el.boundingBox();
    }
    await el.dispose().catch(() => {});
    return b;
  } catch { return null; }
}
// the frame element and every ancestor are rendered (hCaptcha parks full-viewport "enclave" frames with visibility:hidden)
async function frameStyleVisible(frame) {
  try {
    const el = await frame.frameElement();
    const v = await el.evaluate((e) => { for (let n = e; n && n.nodeType === 1; n = n.parentElement) { const c = getComputedStyle(n); if (c.visibility === 'hidden' || c.display === 'none' || +c.opacity === 0) return false; } return true; });
    await el.dispose().catch(() => {});
    return v;
  } catch { return false; }
}
// NEVER RUN CODE INSIDE CLOUDFLARE'S CHALLENGE FRAME (2026-10-22, measured on odoo.com's job form: reading every frame once a
// second while Turnstile ran → no token in 45 s, 0/2; reading only the page → token in 19 s). Turnstile's frame notices script
// evaluated in it and fails the check with 600010 — that was every Turnstile miss at Submit (Rippling, Workable, Cursor). The
// token lives in the HOST page, so nothing is lost; the frame is still found by its URL and placed by its element's box.
const CF_FRAME = /challenges\.cloudflare\.com/;
const scan = (page) => page.frames().filter((f) => !CF_FRAME.test(f.url()));
const framesMatching = (page, re) => page.frames().filter((f) => f !== page.mainFrame() && re.test(f.url()));
async function visibleFrame(page, re, minW = 30, minH = 30) {
  for (const f of framesMatching(page, re)) {
    const b = await frameBox(f);
    // a reCAPTCHA challenge frame also has to be RENDERED (hidden full-size until it opens — see identify)
    if (b && b.width >= minW && b.height >= minH && b.y > -1000 && b.x > -1000 && (!/\/bframe/.test(f.url()) || await frameStyleVisible(f))) return { frame: f, box: b };
  }
  return null;
}
// element rect inside a frame → page coordinates
async function pageRect(page, frame, rect) {
  if (frame === page.mainFrame()) return rect;
  const b = await frameBox(frame);
  return b ? { x: b.x + rect.x, y: b.y + rect.y, width: rect.width, height: rect.height } : null;
}
async function shotClip(page, clip) {
  const vp = page.viewportSize() || { width: 1280, height: 1000 };
  const c = { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: Math.min(clip.width, vp.width - Math.max(0, clip.x)), height: Math.min(clip.height, vp.height - Math.max(0, clip.y)) };
  if (c.width < 5 || c.height < 5) return null;
  return page.screenshot({ clip: c, scale: 'css', type: 'png' }).catch(() => null);
}
// rects of every element matching sel inside a frame (frame-viewport coordinates)
const domRects = (frame, sel, min = 20) => frame.evaluate(({ sel, min }) => [...document.querySelectorAll(sel)]
  .map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })
  .filter((r) => r.width >= min && r.height >= min), { sel, min }).catch(() => []);
const textOf = (frame, sel) => frame.evaluate((sel) => { const e = document.querySelector(sel); return e ? e.innerText.trim() : ''; }, sel).catch(() => '');

// number each tile at its real center (Set-of-Mark), image coordinates = clip-relative CSS pixels
async function overlayNumbers(buf, centers, radius) {
  if (!sharp) return buf;
  const r = Math.max(11, Math.min(26, Math.round(radius)));
  const parts = centers.map((c, i) => `<circle cx="${Math.round(c.x)}" cy="${Math.round(c.y)}" r="${r}" fill="rgba(255,0,0,0.72)" stroke="white" stroke-width="2"/>` +
    `<text x="${Math.round(c.x)}" y="${Math.round(c.y + r * 0.36)}" text-anchor="middle" font-size="${r}" font-weight="bold" fill="white" font-family="Arial,sans-serif">${i + 1}</text>`);
  const meta = await sharp(buf).metadata();
  const svg = `<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  return sharp(buf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}

// Ask which numbered tiles match the instruction; tiles = page rects. Returns 1-based numbers, [] for none, null on failure.
async function pickTiles(page, region, tiles, instruction, label) {
  const shot = await shotClip(page, region);
  log('pickTiles: screenshot', shot ? shot.length + ' bytes' : 'failed');
  if (!shot) return null;
  const centers = tiles.map((t) => ({ x: t.x - region.x + t.width / 2, y: t.y - region.y + t.height / 2 }));
  const labeled = await overlayNumbers(shot, centers, Math.min(...tiles.map((t) => t.width)) / 5);
  log('pickTiles: numbered', tiles.length, 'tiles; asking the solver');
  const prompt = (instruction ? `Challenge instruction: "${instruction}"\n\n` : '') +
    `This is a ${label} image challenge with ${tiles.length} tiles, each marked with a red number 1-${tiles.length}. ` +
    'Look at each tile carefully. Return ONLY a JSON array of the tile NUMBERS that match the instruction, e.g. [2, 5, 9]. Return [] if none match. Do NOT return coordinates.';
  let res = null;
  const g = await geminiJson(labeled, prompt);
  if (g) res = { ok: true, tiles: Array.isArray(g) ? g : (g.tiles || g.numbers || []) , by: 'gemini' };
  if (!res) { const c = await claudeVision(labeled, prompt); if (c) res = { ok: true, tiles: Array.isArray(c) ? c : (c.tiles || c.numbers || []), by: 'claude' }; }
  if (!res && VISION_DECLINED) return null;
  if (!res) res = await callSolverApi({ type: 'vlm_grid', image_b64: labeled.toString('base64'), prompt });
  if (res && !res.ok && /can.?t help|won.?t|cannot (help|assist)|defeat (that|the) check/i.test(String(res.error || ''))) { VISION_DECLINED = true; trace('vision model declined to solve (left for Stanley)'); }
  log('pickTiles: solver answered', JSON.stringify(res).slice(0, 120));
  if (dbgDir()) { try { const d = dbgDir(), t = Date.now(); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/tiles-${t}.png`, labeled); fs.writeFileSync(`${d}/tiles-${t}.json`, JSON.stringify({ instruction, res })); } catch {} }
  if (!res.ok) return null;
  const nums = (res.tiles || (res.clicks || []).flat()).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= tiles.length);
  return [...new Set(nums)];
}
async function clickTiles(page, tiles, nums) {
  for (const n of nums) {
    const t = tiles[n - 1];
    await humanClick(page, t.x + t.width / 2, t.y + t.height / 2);
    await page.waitForTimeout(250 + Math.floor(Math.random() * 350));
  }
}

async function getDPR(page) { return page.evaluate(() => window.devicePixelRatio || 1).catch(() => 1); }

// ── Identification ───────────────────────────────────────────────────────────

// DOM signals, evaluated in every frame
function domSignals() {
  const q = (s) => document.querySelector(s);
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 8; };
  const body = (document.body ? document.body.innerText : '').slice(0, 3000);
  const title = document.title || '';
  const scripts = [...document.scripts].map((s) => s.src).join(' ');
  const html = (document.documentElement.outerHTML || '').slice(0, 60000);
  // the image's own path / id / class / alt — never its host name (every image on 2captcha.com "contains captcha"); no SVG logos
  const capSig = (e) => { let p = ''; try { p = e.src && !/^data:/.test(e.src) ? new URL(e.src).pathname : ''; } catch {}
    return (p + ' ' + e.id + ' ' + (typeof e.className === 'string' ? e.className : '') + ' ' + (e.alt || '') + ' ' + (e.getAttribute('name') || '')).toLowerCase(); };
  const isCapImg = (e) => { const s = capSig(e), r = e.getBoundingClientRect();
    return /captcha|securimage|kcaptcha|verif\w*[-_ ]?code|security[-_ ]?code/.test(s) && !/recaptcha|hcaptcha|\.svg\b/.test(s) && !/\.svg(\?|$)/.test(e.src || '') && r.width >= 50 && r.height >= 18 && r.height <= 220; };
  const capImg = [...document.querySelectorAll('img, canvas')].some(isCapImg);
  const capInput = [...document.querySelectorAll('input')].some((i) => /captcha|security.?code|verification.?code|characters|code.*(image|shown|above)/i
    .test((i.name || '') + ' ' + (i.id || '') + ' ' + (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '')) && vis(i) && !i.value && !/recaptcha|hcaptcha|turnstile/i.test(i.name || ''));
  return {
    cfInterstitial: /^just a moment/i.test(title) || !!q('#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running') || /cdn-cgi\/challenge-platform/.test(scripts) && /verify you are human|checking (if the site connection is secure|your browser)/i.test(body),
    turnstileHost: vis(q('.cf-turnstile, [data-sitekey][class*=turnstile], #cf-turnstile')),
    // solved widgets stay on screen (Friendly Captcha, ALTCHA): count them only while unsolved
    pxHold: vis(q('#px-captcha')),
    friendly: vis(q('.frc-captcha')) && !q('.frc-success') && !((q('input[name="frc-captcha-solution"], input[name="frc-captcha-response"]') || {}).value || '.').replace(/^\..*/, ''),
    altcha: vis(q('altcha-widget, .altcha')) && !/verified/i.test((q('altcha-widget, .altcha') || { getAttribute: () => '' }).getAttribute('data-state') || '') && !((q('input[name="altcha"]') || {}).value),
    mcaptcha: !!q('iframe[src*="mcaptcha"]') && !((q('input[name="mcaptcha__token"]') || {}).value),
    // a slider-captcha frame that still shows its puzzle (after a pass it redirects or empties)
    puzzleShown: !!q('canvas, .sliderContainer, .geetest_box, [class*="slider"], [class*="captcha"] img'),
    mtcaptcha: !!q('.mtcaptcha, iframe[src*="mtcaptcha"]') && !((q('input[name="mtcaptcha-verifiedtoken"]') || {}).value || '').length,
    // GeeTest's widget stays on the page after a pass: count it only while it is not marked success
    geetest: vis(q('.geetest_box, .geetest_holder, .geetest_panel, [class^="geetest_"], .geetest_radar_tip')) && !q('[class*="geetest_success"], .geetest_lock_success, .geetest_radar_success'),
    aws: !!q('awswaf-captcha, #captcha-container [class*=amzn], #aws-waf-token') || /captcha\.awswaf\.com|token\.awswaf\.com/.test(scripts),
    awsVisible: vis(q('awswaf-captcha, #captcha-container')),
    // a container counts only while it still shows a picture (TikTok leaves the container with a "complete" note after a pass)
    bytedance: vis(q('#captcha-verify-image, .vc-captcha-image')) || [...document.querySelectorAll('.captcha_verify_container, .captcha-verify-container, [class*="secsdk-captcha"], [id^="captcha-verify-container"]')].some((c) => vis(c) && [...c.querySelectorAll('img, canvas')].some(vis)),
    bytedanceSlide: !!q('.captcha_verify_img_slide, img.captcha-verify-img-slide, .secsdk-captcha-drag-icon, .captcha-slider-btn'),
    recaptchaV3: /recaptcha\/(api|enterprise)\.js\?[^ ]*render=(?!explicit)/.test(scripts) || !!q('.grecaptcha-badge'),
    textImage: capImg && capInput,
    math: capInput && /\b\d{1,2}\s*[+\-x×*]\s*\d{1,2}\s*=?\s*\??/.test(body) && /captcha|security|verif|human|spam/i.test(body),
    slider: vis(q('[class*="slider"][class*="captcha"], [id*="slider"][id*="captcha"], .sliderContainer, #captcha__puzzle, [class*="puzzle"][class*="slide"], .slider-captcha')),
    akamai: /access denied/i.test(title + ' ' + body.slice(0, 400)) && /reference\s*#\s*\d+\.|errors\.edgesuite\.net|you don.?t have permission to access/i.test(body),
    kasada: /ips\.js|KPSDK/i.test(scripts + html.slice(0, 20000)) && body.length < 400,
    incapsula: /_Incapsula_Resource|incident id/i.test(html) && /request unsuccessful|incapsula/i.test(body + html.slice(0, 5000)),
    ddBlock: /you have been blocked|blocked by datadome/i.test(body) || (/captcha-delivery\.com/.test(html) && /access is temporarily restricted/i.test(body)),
    forbidden: /^\s*(403 forbidden|forbidden|request blocked)\b/i.test(body.slice(0, 100)),
  };
}

async function mtcapVerified(page) {
  for (const f of scan(page)) if (await f.evaluate(() => [...document.querySelectorAll('input[name="mtcaptcha-verifiedtoken"]')].some((e) => (e.value || '').length > 10)).catch(() => false)) return true;
  return false;
}

async function identify(page) {
  const out = [];
  const add = (vendor, kind, solvable, note) => { if (!out.some((v) => v.vendor === vendor && v.kind === kind)) out.push({ vendor, kind, solvable, ...(note ? { note } : {}) }); };
  const mtVerified = () => mtcapVerified(page);
  const showsPuzzle = (f) => f.evaluate(() => !!document.querySelector('canvas, .sliderContainer, .geetest_box, [class*="slider"], [class*="captcha"] img, button, img')).catch(() => false);
  for (const f of page.frames()) {
    const u = f.url();
    // vendors recognised by their frame URL count only while the frame still shows a puzzle
    if (/captcha-delivery\.com|arkoselabs\.com|funcaptcha\.com|geetest\.com|awswaf\.com/.test(u) && !(await showsPuzzle(f))) continue;
    // a challenge frame counts only when it is OPEN on screen: reCAPTCHA/hCaptcha preload a hidden challenge frame on every
    // page (Ashby's invisible reCAPTCHA made every Ashby job "CAPTCHA on load", 2026-10-16)
    const shown = async () => { const b = await frameBox(f); return !!(b && b.width > 250 && b.height > 250 && b.y > -200 && b.x > -200); };
    if (/google\.com\/recaptcha|recaptcha\.net\/recaptcha/.test(u)) {
      // shown = on screen AND rendered: Google parks the challenge frame full-size under a visibility:hidden container until it
      // opens (Dayforce 2026-10-22: Interactive Brokers was parked "CAPTCHA" 3× with no challenge on screen — the form was unfinished)
      if (/\/bframe/.test(u)) { if ((await shown()) && (await frameStyleVisible(f))) add('recaptcha', 'challenge', true); }
      else if (/size=invisible/.test(u)) add('recaptcha', 'invisible', false, 'score-based (v3 / invisible / Enterprise): there is nothing to click; only the browser fingerprint and behaviour count');
      else if (/\/anchor/.test(u)) add('recaptcha', 'checkbox', true);
    }
    if (/hcaptcha\.com/.test(u) && !/frame=enclave/.test(u)) {
      if (/frame=checkbox-invisible/.test(u)) add('hcaptcha', 'invisible', true, 'invisible widget: opens on the form submit (hcaptcha.execute)');
      else add('hcaptcha', /frame=challenge|hcaptcha-challenge|\/challenge/.test(u) && (await shown()) && (await frameStyleVisible(f)) ? 'challenge' : 'checkbox', true);
    }
    if (/challenges\.cloudflare\.com/.test(u)) add('turnstile', 'widget', true);
    if (/captcha-delivery\.com/.test(u)) add('datadome', 'slider', true);
    if (/arkoselabs\.com|funcaptcha\.com/.test(u)) add('arkose', 'game', true, 'best effort (vision, multi-round)');
    if (/geetest\.com/.test(u)) add('geetest', 'challenge', true);
    if (/awswaf\.com/.test(u)) add('aws-waf', 'challenge', true);
    if (/mcaptcha/.test(u)) add('mcaptcha', 'proof-of-work', true);
    if (/mtcaptcha\.com/.test(u) && !(await mtVerified())) add('mtcaptcha', 'text-image', true);
  }
  for (const f of scan(page)) {
    const s = await f.evaluate(domSignals).catch(() => null);
    if (!s) continue;
    if (s.akamai) add('akamai', 'wall', false, 'edge block (Access Denied / Reference #) — never solved, the domain is cooled');
    if (s.kasada) add('kasada', 'wall', false, 'edge block — never solved');
    if (s.incapsula) add('incapsula', 'wall', false, 'edge block — never solved');
    if (s.ddBlock) add('datadome', 'wall', false, 'hard block — never solved');
    if (s.forbidden && f === page.mainFrame()) add('http-403', 'wall', false, 'the server refused the request');
    if (s.cfInterstitial) add('cloudflare', 'interstitial', true, 'managed challenge — usually passes on its own with the real browser');
    if (s.turnstileHost && !out.some((v) => v.vendor === 'turnstile')) add('turnstile', 'widget', true, 'widget host found (iframe in a closed shadow root)');
    if (s.pxHold) add('perimeterx', 'press-and-hold', true);
    if (s.friendly) add('friendly-captcha', 'proof-of-work', true);
    if (s.altcha) add('altcha', 'proof-of-work', true);
    if (s.mcaptcha) add('mcaptcha', 'proof-of-work', true);
    if (s.mtcaptcha) add('mtcaptcha', 'text-image', true);
    if (s.geetest) add('geetest', 'challenge', true);
    if (s.awsVisible || (s.aws && s.awsVisible)) add('aws-waf', 'challenge', true);
    if (s.bytedance) add('bytedance', s.bytedanceSlide ? 'slider' : 'select-objects', true);
    if (s.math) add('math', 'arithmetic', false, 'arithmetic questions are never answered automatically (CLAUDE.md trap-question rule) — needs your decision');
    else if (s.textImage) add('text-image', 'ocr', true);
    if (s.slider && !out.some((v) => /slider/.test(v.kind))) add('slider', 'slider', true);
    if (s.recaptchaV3 && !out.some((v) => v.vendor === 'recaptcha')) add('recaptcha', 'invisible', false, 'score-based (v3 / Enterprise): nothing to click');
  }
  // hCaptcha with no on-screen checkbox and no open challenge = an INVISIBLE widget (iCIMS sign-in): it opens on the form's
  // submit; the engine's own detection must not fire it early (that would submit an unfilled form)
  if (out.some((v) => v.vendor === 'hcaptcha')) {
    let onScreen = false;
    for (const f of framesMatching(page, /hcaptcha/)) {
      if (/frame=(enclave|checkbox-invisible)/.test(f.url())) continue;
      const b = await frameBox(f); if (b && b.width > 50 && b.height > 30 && b.y > -200 && b.x > -200 && (await frameStyleVisible(f))) { onScreen = true; break; }
    }
    if (!onScreen && !(await hcapChallenge(page))) {
      for (let i = out.length - 1; i >= 0; i--) if (out[i].vendor === 'hcaptcha') out.splice(i, 1);
      out.push({ vendor: 'hcaptcha', kind: 'invisible', solvable: true, note: 'invisible widget: opens on the form submit (hcaptcha.execute)' });
    }
  }
  // a widget that already holds its token stays on the page: report it as solved, not as work to do
  const done = async (vendor) => vendor === 'recaptcha' ? recapChecked(page) : vendor === 'hcaptcha' ? ((await hcapToken(page)) || (hcapPassedSince(page, Date.now() - 120000) && !(await hcapChallenge(page)))) : vendor === 'turnstile' ? (await tsToken(page)) > 10 : false;
  const final = [];
  for (const v of out) {
    if (['recaptcha', 'hcaptcha', 'turnstile'].includes(v.vendor) && !(v.vendor === 'recaptcha' && v.kind === 'invisible') && await done(v.vendor)) {
      if (!final.some((x) => x.vendor === v.vendor && x.kind === 'solved')) final.push({ vendor: v.vendor, kind: 'solved', solvable: false });
    } else final.push(v);
  }
  return final;
}
const isWall = (vendors) => vendors.some((v) => v.kind === 'wall');
const vendorText = (vendors) => vendors.map((v) => v.vendor + (v.kind ? '/' + v.kind : '')).join(', ') || 'unidentified';

// ── ByteDance / TikTok ───────────────────────────────────────────────────────

async function solveByteDance(page) {
  const slider = await page.locator('.captcha_verify_img_slide, img.captcha-verify-img-slide, .secsdk-captcha-drag-icon, .captcha-slider-btn').first().isVisible().catch(() => false);
  if (slider) return solveByteSlider(page);
  // "Select 2 objects that are the same shape" (3D objects) — vision picks the points, then Confirm.
  // 2026-10-16 (TikTok USDS: unsolved with no trace at all): the image is looked for in EVERY frame (it renders in an iframe
  // on some ByteDance sites — the old main-page-only lookup returned false silently), the vision model gets the red
  // coordinate grid that made hCaptcha point tasks reliable, a wrong answer gets a fresh challenge (up to 3 rounds), and
  // every round is saved as evidence (pipeline/captcha_debug).
  // 2026-10-19: also TikTok's newer layout (#captcha-verify-container-main-page / .cap-* classes, a plain <img> next to small
  // icons) — the LARGEST candidate wins, never the first (an icon came first and was too small, so nothing was found)
  const IMG = '#captcha-verify-image, .captcha_verify_img--wrapper, .captcha-verify-image, img[id*="captcha"][id*="image"], .vc-captcha-image, [id^="captcha-verify-container"] img, [class*="captcha-verify-container"] img, .cap-flex img';
  const findImg = async () => {
    for (const f of scan(page)) {
      const n = await f.locator(IMG).count().catch(() => 0);
      let best = null;
      for (let i = 0; i < Math.min(n, 12); i++) {
        const b = await f.locator(IMG).nth(i).boundingBox().catch(() => null);
        if (b && b.width > 80 && b.height > 60 && (!best || b.width * b.height > best.b.width * best.b.height)) best = { f, b };
      }
      if (best) return best;
    }
    return null;
  };
  for (let round = 0; round < 3; round++) {
    const hit = await findImg();
    if (!hit) { trace(round ? 'ByteDance select-objects cleared' : 'ByteDance select-objects: no challenge image found'); return round > 0; }
    const { f, b: box } = hit;
    let instruction = await f.locator('.captcha_verify_bar--title, .captcha-verify-title, [class*="verify_bar"] [class*="title"], [class*="captcha"] [class*="title"], .cap-text-left').first().innerText({ timeout: 1500 }).catch(() => '');
    if (!instruction) instruction = await f.evaluate(() => { const m = (document.body.innerText || '').match(/(select|click|drag)[^\n]{0,80}(object|shape|same|icon|image)[^\n]{0,40}/i); return m ? m[0] : ''; }).catch(() => '');
    const shot = await shotClip(page, box); if (!shot) return false;
    const gridded = await gridOverlay(shot);
    if (dbgDir()) { try { fs.mkdirSync(dbgDir(), { recursive: true }); fs.writeFileSync(`${dbgDir()}/bytedance-${Date.now()}-${round}.png`, gridded); } catch {} }
    const j = await visionJson(gridded, `ByteDance CAPTCHA. Instruction: "${instruction || 'select the objects that match'}". A red coordinate grid is drawn over the image ` +
      '(vertical lines labelled with their x pixel at the top, horizontal lines with their y pixel at the left, every 50 px). Identify exactly the objects the ' +
      'instruction asks for (e.g. the 2 objects with the same 3D shape — compare the shapes, ignore colour and size) and give the CENTER of each using the grid. ' +
      'Return ONLY JSON {"clicks": [[x, y], ...]} in pixels from the top-left of this image.');
    trace('ByteDance select-objects (grid-guided vision)');
    if (!j || !Array.isArray(j.clicks) || !j.clicks.length) {
      const rf = f.locator('#captcha_refresh_button, [class*="refresh"], .secsdk_captcha_refresh, a:has-text("Refresh")').first();
      if (await rf.isVisible().catch(() => false)) { await rf.click().catch(() => {}); await page.waitForTimeout(2000); continue; }
      return false;
    }
    for (const [x, y] of j.clicks) { await humanClick(page, box.x + x, box.y + y); await page.waitForTimeout(400 + Math.random() * 300); }
    const confirm = f.locator('.verify-captcha-submit-button, button:has-text("Confirm"), div[class*="submit"]:has-text("Confirm"), [class*="verify"][class*="submit"]').first();
    if (await confirm.isVisible().catch(() => false)) { const cb = await confirm.boundingBox(); if (cb) await humanClick(page, cb.x + cb.width / 2, cb.y + cb.height / 2); }
    await page.waitForTimeout(2500);
  }
  return !(await findImg());
}

async function solveByteSlider(page) {
  const grab = (sel) => page.evaluate((sel) => {
    const img = document.querySelector(sel); if (!img || !img.naturalWidth) return null;
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    try { c.getContext('2d').drawImage(img, 0, 0); return { b64: c.toDataURL('image/png').split(',')[1], scale: img.clientWidth / img.naturalWidth, src: img.src }; } catch { return { src: img.src, scale: img.clientWidth / img.naturalWidth }; }
  }, sel).catch(() => null);
  const bg = await grab('#captcha-verify-image, .captcha_verify_img--wrapper img, img[id*="captcha"][id*="image"], .vc-captcha-image img');
  const piece = await grab('.captcha_verify_img_slide, img.captcha-verify-img-slide, img[class*="slide"], .vc-captcha-piece img');
  if (!bg || !piece) return false;
  const b64 = async (g) => g.b64 || (await page.request.get(g.src).then((r) => r.body()).then((b) => b.toString('base64')).catch(() => null));
  const res = await slideOffset(await b64(bg), await b64(piece));
  if (!res.ok || res.x_offset == null) return false;
  const handle = page.locator('.secsdk-captcha-drag-icon, .captcha-slider-btn, [class*="slider-button"], [class*="drag-icon"], .vc-captcha-slider-handle').first();
  const box = await handle.boundingBox().catch(() => null);
  if (!box) return false;
  await humanDrag(page, box.x + box.width / 2, box.y + box.height / 2, Math.round(res.x_offset * bg.scale));
  await page.waitForTimeout(1500);
  return true;
}

// ── Sliders in any frame (DataDome, GeeTest, Tencent, generic) ───────────────

// where the slot is, in the background image's own pixels: local vote (ddddocr ×2 + OpenCV), then the panel's OpenCV
async function slideOffset(bgB64, pieceB64) {
  if (!bgB64 || !pieceB64) return { ok: false };
  const s = await svc('/slide', { bg: bgB64, piece: pieceB64 }, 30000);
  if (s.ok && typeof s.x === 'number') return { ok: true, x_offset: s.x, confidence: s.conf, method: 'local:' + s.method };
  const r = await callSolverApi({ type: 'slider', bg: bgB64, piece: pieceB64 });
  return { ...r, method: 'panel-opencv' };
}

const HANDLE_SEL = '.geetest_btn, .geetest_slider_button, .sliderIcon, .slider-icon, [class*="slider"] [class*="handle"], [class*="slider"][class*="btn"], [class*="slider-button"], [class*="drag"][class*="btn"], [class*="handler"], [role="slider"], .slider .knob, #captcha__puzzle ~ * [class*="slider"]';

// The slider must live inside a CAPTCHA container (rootSel; a DataDome frame is all CAPTCHA, so null there) — never a
// range slider that belongs to the application form.
const SLIDER_ROOT = '.geetest_box, .geetest_holder, .geetest_panel, .geetest_panel_box, [class*="slider"][class*="captcha"], [id*="slider"][id*="captcha"], .slider-captcha, .sliderContainer, [class*="captcha"][class*="slide"], [class*="puzzle"][class*="slide"], #captcha__puzzle, [class*="tcaptcha"]';
async function solveSliderInFrame(page, frame, rootSel = SLIDER_ROOT) {
  const info = await frame.evaluate(({ HANDLE_SEL, rootSel }) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 10 && r.height > 10; };
    const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    let root = document;
    if (rootSel) {
      let r = [...document.querySelectorAll(rootSel)].find(vis);
      if (!r) return null;
      // widen to the nearest ancestor that holds both the handle and the picture
      for (let i = 0; i < 4 && r.parentElement && !(r.querySelector(HANDLE_SEL) && r.querySelector('img, canvas, [style*="background"]')); i++) r = r.parentElement;
      root = r;
    }
    const handle = [...root.querySelectorAll(HANDLE_SEL)].find(vis);
    if (!handle) return null;
    // candidate images: <img>, <canvas>, or elements painted with a background-image
    const bgUrl = (e) => { const m = getComputedStyle(e).backgroundImage.match(/url\(["']?(.*?)["']?\)/); return m ? m[1] : null; };
    const els = [...root.querySelectorAll('img, canvas, div, span')].filter((e) => vis(e) && (e.tagName === 'IMG' || e.tagName === 'CANVAS' || bgUrl(e)));
    const data = (e) => {
      try {
        if (e.tagName === 'CANVAS') return { b64: e.toDataURL('image/png').split(',')[1], natW: e.width };
        if (e.tagName === 'IMG') { const c = document.createElement('canvas'); c.width = e.naturalWidth; c.height = e.naturalHeight; c.getContext('2d').drawImage(e, 0, 0); return { b64: c.toDataURL('image/png').split(',')[1], natW: e.naturalWidth }; }
      } catch {}
      return { url: e.tagName === 'IMG' ? e.src : bgUrl(e), natW: e.tagName === 'IMG' ? e.naturalWidth : 0 };
    };
    const sorted = els.map((e) => ({ e, r: rect(e) })).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const bg = sorted[0];
    const piece = bg && sorted.find((c) => c !== bg && c.r.width < bg.r.width * 0.45 && c.r.height <= bg.r.height * 1.05 && c.r.height > bg.r.height * 0.15
      && c.r.y >= bg.r.y - 5 && c.r.y + c.r.height <= bg.r.y + bg.r.height + 5);
    return { handle: rect(handle), bg: bg && { ...bg.r, ...data(bg.e) }, piece: piece && { ...piece.r, ...data(piece.e) } };
  }, { HANDLE_SEL, rootSel }).catch(() => null);
  if (!info) return false;
  const handle = await pageRect(page, frame, info.handle); if (!handle) return false;
  let dist = null;
  if (info.bg && info.piece) {
    const load = async (x) => x.b64 || (x.url ? await page.request.get(new URL(x.url, frame.url()).href).then((r) => r.body()).then((b) => b.toString('base64')).catch(() => null) : null);
    const [bgB, pcB] = [await load(info.bg), await load(info.piece)];
    if (bgB && pcB) {
      const res = await slideOffset(bgB, pcB);
      if (res.ok && res.x_offset != null && (res.confidence == null || res.confidence > 0.25)) {
        const scale = info.bg.natW ? info.bg.width / info.bg.natW : 1;
        dist = Math.round(res.x_offset * scale - (info.piece.x - info.bg.x));
        log('slider:', res.method, 'offset', res.x_offset, 'scale', scale, '→ drag', dist);
        trace('slider (' + res.method + ')');
      }
    }
  }
  if (dist == null || dist < 5) {
    // vision fallback: where the gap is, relative to where the piece is now
    const region = await pageRect(page, frame, info.bg || { x: info.handle.x - 20, y: info.handle.y - 180, width: 340, height: 220 });
    const shot = region && await shotClip(page, region);
    if (!shot) return false;
    const j = await visionJson(shot, 'This is a slider-puzzle CAPTCHA. Return ONLY JSON {"gap_x": <x of the LEFT edge of the empty slot>, "piece_x": <x of the LEFT edge of the movable puzzle piece>} in pixels from the left of this image.');
    if (!j || typeof j.gap_x !== 'number') return false;
    dist = Math.round(j.gap_x - (typeof j.piece_x === 'number' ? j.piece_x : 0));
    log('slider: vision gap', j, '→ drag', dist);
  }
  if (!(dist > 3)) return false;
  await humanDrag(page, handle.x + handle.width / 2, handle.y + handle.height / 2, dist);
  await page.waitForTimeout(2000);
  return true;
}

// ── GeeTest v4 / v3 ("Click to verify" → slide puzzle | click-in-order) ────────────

const gtPassed = (page) => anyFrame(page, () => !!document.querySelector('[class*="geetest_success"], .geetest_lock_success, .geetest_radar_success'));
async function imgDims(b64) { try { const m = await sharp(Buffer.from(b64, 'base64')).metadata(); return { w: m.width, h: m.height }; } catch { return null; } }

async function solveGeetest(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await gtPassed(page)) return true;
    for (const fr of scan(page)) {
      // 1. open the challenge: "Click to verify" (v4 .geetest_btn_click, v3 .geetest_radar_tip)
      const open = (await domRects(fr, '.geetest_btn_click, .geetest_radar_tip, .geetest_radar_btn', 20))[0];
      const shown = await fr.evaluate(() => !!document.querySelector('.geetest_boxShow, .geetest_panel_box, .geetest_widget')).catch(() => false);
      if (open && !shown) { const r = await pageRect(page, fr, open); if (r) { await humanClick(page, r.x + r.width / 2, r.y + r.height / 2); await page.waitForTimeout(3000); } }
      if (await gtPassed(page)) return true;   // passed on the click alone
      // 2. slide: background + piece are CSS background images
      const parts = await fr.evaluate(() => {
        const bgUrl = (e) => { const m = e && getComputedStyle(e).backgroundImage.match(/url\(["']?(.*?)["']?\)/); return m ? m[1] : null; };
        const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const vis = (e) => e && e.getBoundingClientRect().width > 10;
        const bg = document.querySelector('.geetest_bg, .geetest_canvas_bg canvas, .geetest_canvas_fullbg'), piece = document.querySelector('.geetest_slice_bg, .geetest_canvas_slice'), btn = document.querySelector('.geetest_btn, .geetest_slider_button');
        if (!vis(bg) || !vis(piece) || !vis(btn)) return null;
        const data = (e) => e.tagName === 'CANVAS' ? { b64: e.toDataURL('image/png').split(',')[1], natW: e.width } : { url: bgUrl(e) };
        return { bg: { ...rect(bg), ...data(bg) }, piece: { ...rect(piece), ...data(piece) }, btn: rect(btn) };
      }).catch(() => null);
      if (parts) {
        const load = async (x) => x.b64 || (x.url ? await page.request.get(new URL(x.url, fr.url()).href).then((r) => r.body()).then((b) => b.toString('base64')).catch(() => null) : null);
        const [bgB, pcB] = [await load(parts.bg), await load(parts.piece)];
        const dims = bgB && await imgDims(bgB);
        const res = await slideOffset(bgB, pcB);
        if (res.ok && res.x_offset != null && dims) {
          const scale = parts.bg.width / dims.w;
          const dist = Math.round(res.x_offset * scale - (parts.piece.x - parts.bg.x));
          const btn = await pageRect(page, fr, parts.btn);
          log('geetest slide:', res.method, 'x', res.x_offset, 'natW', dims.w, 'scale', scale.toFixed(3), '→ drag', dist);
          trace('slider (' + res.method + ')');
          if (btn && dist > 3) { await humanDrag(page, btn.x + btn.width / 2, btn.y + btn.height / 2, dist); await page.waitForTimeout(2500); }
          if (await gtPassed(page)) return true;
        }
      } else {
        // 3. click-in-order / icon / nine-grid: vision on the challenge box, then its confirm button
        const box = (await domRects(fr, '.geetest_box, .geetest_panel_box, .geetest_widget', 150))[0];
        if (box) {
          const r = await pageRect(page, fr, box); const shot = r && await shotClip(page, r);
          const tip = await textOf(fr, '.geetest_text_tips, .geetest_tip_content, .geetest_title');
          const j = shot && await visionJson(shot, `This is a GeeTest CAPTCHA. Instruction: "${tip}". Read any example icons/characters it shows. ` +
            'Return ONLY JSON {"clicks": [[x, y], ...]} — the points to click IN ORDER, in pixels from the top-left of this image (not the confirm button).');
          if (j && Array.isArray(j.clicks) && j.clicks.length) {
            for (const [x, y] of j.clicks) { await humanClick(page, r.x + x, r.y + y); await page.waitForTimeout(500 + Math.random() * 300); }
            const ok = (await domRects(fr, '.geetest_submit, .geetest_commit, .geetest_btn_submit', 10))[0];
            if (ok) { const o = await pageRect(page, fr, ok); if (o) await humanClick(page, o.x + o.width / 2, o.y + o.height / 2); }
            await page.waitForTimeout(2500);
            if (await gtPassed(page)) return true;
          }
        }
      }
    }
    // a fresh puzzle for the next attempt
    for (const fr of scan(page)) { const rf = (await domRects(fr, '.geetest_refresh, .geetest_refresh_1', 10))[0]; if (rf) { const r = await pageRect(page, fr, rf); if (r) { await humanClick(page, r.x + r.width / 2, r.y + r.height / 2); await page.waitForTimeout(2000); } break; } }
  }
  return gtPassed(page);
}

// ── reCAPTCHA v2 (checkbox → audio → numbered DOM tiles) ─────────────────────

const recapChecked = async (page) => {
  for (const f of framesMatching(page, /recaptcha.*\/anchor/)) if (await f.locator('#recaptcha-anchor[aria-checked="true"]').count().catch(() => 0)) return true;
  return false;
};

async function solveRecaptcha(page) {
  const anchor = await visibleFrame(page, /recaptcha.*\/anchor/, 60, 60);
  if (anchor && !(await recapChecked(page))) {
    await humanClick(page, anchor.box.x + 28, anchor.box.y + anchor.box.height / 2);
    await page.waitForTimeout(2500);
  }
  if (await recapChecked(page)) { trace('checkbox passed'); return true; }
  const bf = await visibleFrame(page, /recaptcha.*\/bframe/, 250, 250);
  if (!bf) { trace(anchor ? 'checkbox not passed, no challenge opened' : 'no reCAPTCHA box or challenge on screen'); return false; }
  const bframe = bf.frame;

  // audio first (fast); "multiple correct solutions required" → another clip, up to 3
  if (await bframe.locator('#recaptcha-audio-button').isVisible().catch(() => false)) {
    await bframe.locator('#recaptcha-audio-button').click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(2200);
    for (let i = 0; i < 3; i++) {
      if (await bframe.locator('.rc-doscaptcha-body').isVisible().catch(() => false)) { trace('audio refused by Google ("try again later")'); break; }
      const url = await bframe.locator('.rc-audiochallenge-tdownload-link, a[href*="payload"]').getAttribute('href', { timeout: 3000 }).catch(() => null);
      if (!url) break;
      const body = await page.request.get(url).then((r) => r.body()).catch(() => null);
      if (!body) break;
      // local Whisper first (no third party, no quota); Google's speech API as the fallback
      let res = await svc('/audio', { audio_b64: body.toString('base64') }, 180000); let eng = 'local Whisper';
      if (!res.ok || !res.text) { res = await callSolverApi({ type: 'audio', audio_b64: body.toString('base64') }); eng = 'Google speech'; }
      if (res.ok && res.text) trace('audio (' + eng + ')');
      log('recaptcha audio →', res.text || res.error);
      if (!res.ok || !res.text) { await bframe.locator('#recaptcha-reload-button').click().catch(() => {}); await page.waitForTimeout(1800); continue; }
      const inp = bframe.locator('#audio-response');
      await inp.click().catch(() => {}); await inp.pressSequentially(res.text, { delay: 60 + Math.random() * 40 }).catch(() => {});
      await page.waitForTimeout(300);
      await bframe.locator('#recaptcha-verify-button').click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(2200);
      if (await recapChecked(page)) return true;
    }
    if (await bframe.locator('#recaptcha-image-button').isVisible().catch(() => false)) {
      await bframe.locator('#recaptcha-image-button').click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
  }
  return solveRecaptchaGrid(page, bframe);
}

async function solveRecaptchaGrid(page, bframe) {
  for (let round = 0; round < 6; round++) {
    if (await recapChecked(page)) return true;
    const instruction = await textOf(bframe, '.rc-imageselect-desc-wrapper, .rc-imageselect-desc, .rc-imageselect-desc-no-canonical');
    const fr = await domRects(bframe, 'td.rc-imageselect-tile', 40);
    const chal = (await domRects(bframe, '.rc-imageselect-challenge', 100))[0];
    if (!fr.length || !chal) { trace('no image grid in the challenge' + (round ? ' (round ' + round + ')' : '')); return false; }
    const tiles = []; for (const r of fr) tiles.push(await pageRect(page, bframe, r));
    const region = await pageRect(page, bframe, chal);
    const dynamic = /once there are none left|click verify once there are none/i.test(instruction);
    const grid = Math.round(Math.sqrt(tiles.length));
    const vlm = () => pickTiles(page, region, tiles, instruction, `reCAPTCHA (${grid}×${grid})`);
    // local YOLO first (classifier per tile + COCO segmentation on 4×4); a vision model only settles the uncertain tiles
    let nums = null, how = 'vision';
    const shot = await shotClip(page, region);
    const y = shot ? await svc('/recaptcha', { image_b64: shot.toString('base64'), label: instruction, grid,
      cells: tiles.map((t) => [Math.max(0, t.x - region.x), Math.max(0, t.y - region.y), t.width, t.height]) }) : { ok: false };
    if (y.ok) {
      nums = y.tiles.slice(); how = 'yolo';
      if (y.uncertain.length || (!nums.length && grid === 3 && !dynamic)) {
        const v = await vlm();
        if (v) {
          if (!nums.length && !y.uncertain.length) nums = v;                       // the models saw nothing: trust vision
          else nums = [...new Set([...nums, ...y.uncertain.filter((n) => v.includes(n))])].sort((a, b) => a - b);
          how = 'yolo+vision';
        }
      }
    } else { log('recaptcha: local model', y.error); nums = await vlm(); }
    log('recaptcha round', round, tiles.length, 'tiles', instruction.slice(0, 60), '→', nums, how, y.ok ? 'probs ' + JSON.stringify(y.probs) : '');
    trace('image grid (' + how + ')');
    if (nums === null) return false;
    await clickTiles(page, tiles, nums);
    if (dynamic && nums.length) { await page.waitForTimeout(3500); continue; }   // replaced tiles fade in: look again
    await page.waitForTimeout(600);
    await bframe.locator('#recaptcha-verify-button').click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(2500);
    if (await recapChecked(page)) return true;
    const again = await bframe.evaluate(() => [...document.querySelectorAll('.rc-imageselect-incorrect-response, .rc-imageselect-error-select-more, .rc-imageselect-error-dynamic-more, .rc-imageselect-error-select-something')]
      .some((e) => e.offsetParent !== null)).catch(() => false);
    if (!again && !(await visibleFrame(page, /recaptcha.*\/bframe/, 250, 250))) return await recapChecked(page);
  }
  return false;
}

// ── hCaptcha (checkbox → numbered DOM tiles / canvas / drag) ─────────────────

// tokens land in whichever document hosts the widget — the iCIMS content iframe, not the top page — so look in every frame
async function anyFrame(page, fn) {
  for (const f of scan(page)) if (await f.evaluate(fn).catch(() => false)) return true;
  return false;
}
const hcapToken = (page) => anyFrame(page, () => [...document.querySelectorAll('textarea[name*="h-captcha-response"], textarea[name*="hcaptcha"]')].some((e) => (e.value || '').length > 10));
const hcapChallenge = async (page) => {
  for (const f of framesMatching(page, /hcaptcha/)) {
    const has = await f.evaluate(() => !!document.querySelector('.challenge-container, .task-image, .challenge-view, .prompt-text, canvas')).catch(() => false);
    if (!has) continue;
    if (/frame=(enclave|checkbox)/.test(f.url())) continue;
    const b = await frameBox(f);
    if (b && b.width > 250 && b.height > 250 && b.y > -500 && (await frameStyleVisible(f))) return { frame: f, box: b };
  }
  return null;
};

// HCAPTCHA'S OWN VERDICT (2026-10-19). Lever / Veeva misses ended "unsolved" with point answers that were right on the
// saved pictures: an invisible widget's token goes straight into the site's callback (Lever submits the form and resets
// the widget), so "no token in the textarea" is not proof of a miss. hCaptcha's /checkcaptcha reply says pass / fail;
// it is recorded per page and a pass counts as solved.
const HCAP_VERDICT = new WeakMap();       // page → { pass, at }
const HCAP_SITE_OPENED = new WeakMap();   // page → the URL on which a challenge was open (its Submit / Next called execute())
const siteOpened = (page) => HCAP_SITE_OPENED.get(page) === page.url();
const markOpened = (page) => HCAP_SITE_OPENED.set(page, page.url());
function watchHcapVerdict(page) {
  if (page.__relayHcapWatch) return;
  page.__relayHcapWatch = true;
  page.on('response', async (resp) => {
    try {
      if (!/hcaptcha\.com\/checkcaptcha\//.test(resp.url())) return;
      const j = await resp.json().catch(() => null);
      const pass = !!(j && (j.pass === true || j.generated_pass_UUID));
      HCAP_VERDICT.set(page, { pass, at: Date.now(), url: page.url(), raw: j ? Object.keys(j).join(',') : 'unreadable' });
      trace(pass ? 'hCaptcha server: pass' : 'hCaptcha server: rejected');
      log('hcaptcha checkcaptcha →', pass, j && JSON.stringify(j).slice(0, 120));
    } catch {}
  });
}
const hcapPassedSince = (page, t0) => { const v = HCAP_VERDICT.get(page); return !!(v && v.pass && v.at >= t0 && v.url === page.url()); };

async function solveHcaptcha(page) {
  const t0 = Date.now() - 1000;
  watchHcapVerdict(page);
  if (await hcapToken(page)) return true;
  // already passed in this solve (an earlier key — hcaptcha/challenge before hcaptcha/invisible — consumed the token through
  // the site's callback): opening it again would submit the application a second time
  if (hcapPassedSince(page, SOLVE_T0) && !(await hcapChallenge(page))) return true;
  if (await hcapChallenge(page)) markOpened(page);   // open before we touched anything = the site's submit opened it
  else {
    // an on-screen checkbox only (an invisible widget parks its frame at y≈−9915; clicking there does nothing)
    const onScreen = (b) => b && b.y > -200 && b.x > -200;
    const cb = await (async () => {
      for (const f of framesMatching(page, /hcaptcha/)) {
        if (/frame=(enclave|checkbox-invisible|challenge)/.test(f.url())) continue;
        const b = await frameBox(f);
        if (onScreen(b) && b.width > 100 && b.height < 150 && b.height > 30 && (await frameStyleVisible(f))) return { frame: f, box: b };
      }
      return null;
    })();
    if (cb && onScreen(cb.box)) { await humanClick(page, cb.box.x + 28, cb.box.y + cb.box.height / 2); await page.waitForTimeout(3500); }
    else {
      // INVISIBLE hCaptcha (iCIMS sign-in, 2026-10-16): no checkbox — the challenge opens when the site calls
      // hcaptcha.execute(), normally on Next. Open it the same way, in the frame that hosts the widget; the site's own
      // callback then continues the form exactly as its Next button would.
      // RETRY AFTER A REJECTED ROUND (2026-10-19, Lever/Veeva): when the site's own Submit opened the challenge and hCaptcha
      // closed it without a pass, re-opening it is exactly what pressing Submit again does — the "empty box" guard (meant
      // for a form nobody submitted yet) skipped attempts 2 and 3 on every Lever form with an empty OPTIONAL field.
      const resubmit = siteOpened(page);
      for (const f of scan(page)) {
        const opened = await f.evaluate((resubmit) => {
          const w = document.querySelector('.h-captcha[data-size="invisible"], [data-hcaptcha-widget-id], .h-captcha');
          if (!w || !window.hcaptcha || typeof window.hcaptcha.execute !== 'function') return false;
          // execute() submits the form through the site's callback: never on a form with an empty visible text/email box
          const form = w.closest('form') || document;
          const empty = [...form.querySelectorAll('input[type="email"], input[type="text"], input:not([type])')].filter((i) => i.offsetParent !== null && !i.value && !/captcha/i.test(i.name || ''));
          if (empty.length && !resubmit) return 'not-ready';
          try { const id = w.getAttribute('data-hcaptcha-widget-id'); id ? window.hcaptcha.execute(id) : window.hcaptcha.execute(); return true; } catch { return false; }
        }, resubmit).catch(() => false);
        if (opened === 'not-ready') { log('hcaptcha: invisible widget, but the form still has empty boxes — not opening it'); return false; }
        if (opened) { trace('invisible hCaptcha opened'); log('hcaptcha: invisible widget — execute() called'); await page.waitForTimeout(4000); break; }
      }
    }
  }
  let lastPrompt = '', samePrompt = 0, refreshes = 0;
  for (let round = 0; round < 8; round++) {
    if (await hcapToken(page)) return true;
    const ch = await hcapChallenge(page);
    if (!ch) {
      // closed: a token in the page, or hCaptcha's own "pass" (the site's callback may already have consumed the token)
      for (let i = 0; i < 6; i++) { if ((await hcapToken(page)) || hcapPassedSince(page, t0)) break; await page.waitForTimeout(500); }
      if (await hcapToken(page)) return true;
      if (hcapPassedSince(page, t0)) { trace('hCaptcha passed (token handed to the site callback)'); return true; }
      return false;
    }
    markOpened(page);   // a challenge is open on this page: a later attempt may re-open it after a rejection
    const { frame, box } = ch;
    const instruction = await textOf(frame, '.prompt-text, .challenge-prompt, h2');
    // the same challenge is back = the last answer was wrong. Drag puzzles and repeat failures get a FRESH challenge
    // (often an easier tile type) instead of another guess — real sites (iCIMS/AMD) served drag puzzles we failed twice
    samePrompt = instruction && instruction === lastPrompt ? samePrompt + 1 : 0; lastPrompt = instruction;
    if (refreshes < 4 && ((samePrompt >= 1 && /drag|move|scale|place the|put the/i.test(instruction)) || samePrompt >= 2)) {
      if (await hcapRefresh(page, frame, box)) { refreshes++; samePrompt = 0; lastPrompt = ''; continue; }
    }
    log('hcaptcha round', round, instruction.slice(0, 70));
    trace('hCaptcha image rounds (' + (geminiKey() ? 'Gemini' : 'Claude') + ' vision)');
    const fr = await domRects(frame, '.task-image, .task, .task-grid .image-wrapper', 40);
    log('hcaptcha tiles', fr.length, 'box', JSON.stringify(box));
    if (dbgDir()) { try { const d = dbgDir(); fs.mkdirSync(d, { recursive: true }); const s = await shotClip(page, box); if (s) fs.writeFileSync(`${d}/round-${Date.now()}-${round}.png`, s); } catch {} }
    if (/drag|move|scale|place the|put the/i.test(instruction)) {
      if (!(await solveHcaptchaDrag(page, frame, box, instruction))) return false;
    } else if (fr.length >= 4) {
      const tiles = []; for (const r of fr) tiles.push({ x: box.x + r.x, y: box.y + r.y, width: r.width, height: r.height });
      const pattern = /pattern|odd one|doesn.?t belong|does not belong/i.test(instruction);
      const nums = await pickTiles(page, box, tiles, pattern ? instruction + ' (pick the tiles that break the pattern)' : instruction, 'hCaptcha');
      if (nums === null) return false;
      await clickTiles(page, tiles, nums);
    } else {
      // canvas challenges ("click on the …", "click the two similar …"): points in the canvas
      const cv = (await domRects(frame, 'canvas', 150))[0];
      const area = cv ? { x: box.x + cv.x, y: box.y + cv.y, width: cv.width, height: cv.height } : box;
      const shot = await shotClip(page, area);
      const gridded = shot && await gridOverlay(shot);
      // DESCRIBE, THEN CHOOSE (2026-10-16, Veeva / Lever "Click on the TWO shortest towers" missed live 3×): comparison tasks
      // (shortest / tallest / most / fewest / same / different) need the property measured per object before picking — asked
      // for coordinates alone, the model miscounted stacked discs. It now lists every candidate with the measured property.
      const j = gridded && await visionJson(gridded, `hCaptcha instruction: "${instruction}". A red coordinate grid is drawn over the image (vertical lines labelled with ` +
        'their x pixel at the top, horizontal lines with their y pixel at the left, every 50 px). FIRST list EVERY candidate object left to right with its center ' +
        'and the property the instruction is about, measured carefully (e.g. for towers / stacks: count the discs or layers one by one; for sizes: compare heights ' +
        'in pixels using the grid; for "same / different": describe each shape). THEN choose exactly the object(s) the instruction asks for. Return ONLY JSON ' +
        '{"objects": [{"center": [x, y], "property": "..."}], "clicks": [[x, y], ...]} in pixels from the top-left of this image.');
      if (j) trace('hCaptcha point task (grid-guided vision, measure-then-choose)');
      if (dbgDir()) { try { fs.mkdirSync(dbgDir(), { recursive: true }); const t = Date.now(); fs.writeFileSync(`${dbgDir()}/point-${t}.png`, gridded); fs.writeFileSync(`${dbgDir()}/point-${t}.json`, JSON.stringify({ instruction, area, j })); } catch {} }
      if (!j || !Array.isArray(j.clicks) || !j.clicks.length) return false;
      for (const [x, y] of j.clicks) { await humanClick(page, area.x + x, area.y + y); await page.waitForTimeout(350 + Math.random() * 300); }
      if (dbgDir()) { try { const after = await shotClip(page, area); if (after) fs.writeFileSync(`${dbgDir()}/point-${Date.now()}-after.png`, await gridOverlay(after)); } catch {} }
    }
    await page.waitForTimeout(700);
    const btn = (await domRects(frame, '.button-submit, button[type="submit"], .challenge-submit', 10))[0];
    if (btn) await humanClick(page, box.x + btn.x + btn.width / 2, box.y + btn.y + btn.height / 2);
    await page.waitForTimeout(2500);
  }
  return hcapToken(page);
}

// a coordinate grid drawn over a screenshot (lines + labels every `step` px) so a vision model can name exact points
async function gridOverlay(buf, step = 50) {
  if (!sharp) return buf;
  const m = await sharp(buf).metadata(); const parts = [];
  for (let x = step; x < m.width; x += step) parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${m.height}" stroke="rgba(255,0,0,0.45)" stroke-width="1"/><text x="${x + 2}" y="11" font-size="10" fill="red" font-family="Arial">${x}</text>`);
  for (let y = step; y < m.height; y += step) parts.push(`<line x1="0" y1="${y}" x2="${m.width}" y2="${y}" stroke="rgba(255,0,0,0.45)" stroke-width="1"/><text x="2" y="${y - 2}" font-size="10" fill="red" font-family="Arial">${y}</text>`);
  return sharp(buf).composite([{ input: Buffer.from(`<svg width="${m.width}" height="${m.height}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`), top: 0, left: 0 }]).png().toBuffer();
}

async function solveHcaptchaDrag(page, frame, box, instruction) {
  const shot = await shotClip(page, box); if (!shot) return false;
  const gridded = await gridOverlay(shot);
  const j = await visionJson(gridded, `hCaptcha drag puzzle: "${instruction}". A red coordinate grid is drawn over the image: vertical lines are labelled ` +
    'with their x pixel at the top, horizontal lines with their y pixel at the left (every 50 px). Decide which piece(s) must be dragged and exactly where ' +
    '(e.g. the animal whose silhouette matches an outline; only the correct piece moves). Use the grid to give precise pixel coordinates. ' +
    'Return ONLY JSON {"drags": [{"from": [x1, y1], "to": [x2, y2]}]}: "from" = center of the piece to drag, "to" = center of the matching outline/target.');
  const drags = j && (j.drags || j.clicks);
  const dbg = dbgDir(), stamp = Date.now();
  if (dbg) { try { fs.mkdirSync(dbg, { recursive: true }); fs.writeFileSync(`${dbg}/drag-${stamp}-a.png`, gridded); fs.writeFileSync(`${dbg}/drag-${stamp}.json`, JSON.stringify({ instruction, box, j })); } catch {} }
  if (!Array.isArray(drags) || !drags.length || !drags[0].from) return false;
  for (const d of drags) {
    await humanDragTo(page, box.x + d.from[0], box.y + d.from[1], box.x + d.to[0], box.y + d.to[1]);
    await page.waitForTimeout(600 + Math.floor(Math.random() * 400));
  }
  if (dbg) { const after = await shotClip(page, box); if (after) try { fs.writeFileSync(`${dbg}/drag-${stamp}-b.png`, await gridOverlay(after)); } catch {} }
  trace('hCaptcha drag (grid-guided vision)');
  return true;
}

// a new challenge of (often) another type: hCaptcha's own Refresh button
async function hcapRefresh(page, frame, box) {
  const r = (await domRects(frame, '.refresh.button, [aria-label^="Refresh Challenge"]', 10))[0];
  if (!r) return false;
  await humanClick(page, box.x + r.x + r.width / 2, box.y + r.y + r.height / 2);
  await page.waitForTimeout(2500);
  trace('hCaptcha refreshed for a new challenge');
  return true;
}

// ── Cloudflare: Turnstile widget + the "Just a moment…" interstitial ─────────

// token length; an EXPIRED token (Turnstile tokens live 300 s — a long form outlives them) counts as none
const tsToken = async (page) => {
  let best = -1;
  for (const f of scan(page)) {
    const n = await f.evaluate(() => {
      let expired = false; try { expired = !!(window.turnstile && typeof window.turnstile.isExpired === 'function' && window.turnstile.isExpired()); } catch {}
      return expired ? 0 : Math.max(-1, ...[...document.querySelectorAll('[name="cf-turnstile-response"], input[name*="turnstile"]')].map((e) => (e.value || '').length));
    }).catch(() => -1);
    best = Math.max(best, n);
  }
  return best;
};
// ask Turnstile itself for a fresh token: interaction-only widgets are display:none (nothing to click — Odoo) and expired
// tokens are not renewed by a click. reset() re-runs the check; the real browser passes it on its own.
async function turnstileRefresh(page) {
  let did = false;
  for (const f of scan(page)) {
    did = (await f.evaluate(() => {
      if (!window.turnstile || typeof window.turnstile.reset !== 'function') return false;
      try { window.turnstile.reset(); } catch {}
      return true;
    }).catch(() => false)) || did;
  }
  if (!did) return false;
  trace('Turnstile refreshed via its API');
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(1000); if ((await tsToken(page)) > 10) return true; }
  // EXECUTE-MODE WIDGETS (2026-10-19, Rippling: "refreshed via its API" then 126 s and no token, 4×): a widget rendered with
  // execution:"execute" runs its check only when the site calls turnstile.execute() — usually on Submit — so reset() alone
  // never yields a token. Run it for every widget on the page (by its widget id, else its container).
  let ex = false;
  for (const f of scan(page)) {
    ex = (await f.evaluate(() => {
      if (!window.turnstile || typeof window.turnstile.execute !== 'function') return false;
      const ids = [...document.querySelectorAll('input[id^="cf-chl-widget-"][id$="_response"]')].filter((e) => !(e.value || '').length).map((e) => e.id.replace(/_response$/, ''));
      let n = 0;
      for (const id of ids) { try { window.turnstile.execute(id); n++; } catch {} }
      if (!n) for (const h of document.querySelectorAll('.cf-turnstile, [data-sitekey][class*="turnstile"]')) { try { window.turnstile.execute(h); n++; } catch {} }
      return n > 0;
    }).catch(() => false)) || ex;
  }
  if (!ex) return false;
  trace('Turnstile executed via its API');
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(1000); if ((await tsToken(page)) > 10) return true; }
  return false;
}

async function turnstileBox(page) {
  const f = await visibleFrame(page, /challenges\.cloudflare\.com/, 100, 30);
  if (f) return f.box;
  // the iframe lives in a closed shadow root: its host div is still in the DOM
  for (const fr of scan(page)) {
    const r = (await domRects(fr, '.cf-turnstile, [data-sitekey][class*="turnstile"], #cf-turnstile, #turnstile-wrapper, #turnstile-container, .main-content #challenge-stage', 30))[0];
    if (r) return pageRect(page, fr, r);
  }
  return null;
}

async function solveTurnstile(page) {
  for (let i = 0; i < 6; i++) { if (await tsToken(page) > 10) { trace('auto-pass'); return true; } await page.waitForTimeout(1000); }   // stealth auto-pass
  if (await turnstileRefresh(page)) return true;
  let clicks = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const b = await turnstileBox(page);
    if (!b) { if (!clicks) trace('no Turnstile box on screen to click'); return (await tsToken(page)) > 10; }
    await humanClick(page, b.x + Math.min(30, b.width / 2), b.y + b.height / 2); clicks++;
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(1000); if (await tsToken(page) > 10) { trace('checkbox click'); return true; } }
  }
  if (clicks) trace(`Turnstile box clicked ${clicks}× — no token`);
  return (await tsToken(page)) > 10;
}

// "Just a moment…" / "Verify you are human": with the real browser it usually clears by itself in 3–10 s; when it shows a
// Turnstile box, click it. Cleared = the page is no longer the interstitial.
async function solveCfInterstitial(page, maxMs = 25000) {
  trace('Cloudflare interstitial wait');
  const t0 = Date.now();
  const still = () => page.mainFrame().evaluate(() => /^just a moment/i.test(document.title) || !!document.querySelector('#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running')).catch(() => false);
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(1500);
    if (!(await still())) return true;
    const b = await turnstileBox(page);
    if (b && Date.now() - t0 > 4000) { await humanClick(page, b.x + Math.min(30, b.width / 2), b.y + b.height / 2); await page.waitForTimeout(4000); }
  }
  return !(await still());
}

// ── PerimeterX / HUMAN "Press & Hold" ─────────────────────────────────────────

async function solvePressHold(page) {
  let b = null;
  for (const fr of scan(page)) { const r = (await domRects(fr, '#px-captcha', 30))[0]; if (r) { b = await pageRect(page, fr, r); break; } }
  if (!b) return false;
  const x = b.x + b.width / 2 + (Math.random() - 0.5) * 20, y = b.y + b.height / 2 + (Math.random() - 0.5) * 6;
  await page.mouse.move(x - 60, y + 30, { steps: 5 }); await page.mouse.move(x, y, { steps: 8 });
  await page.waitForTimeout(150 + Math.random() * 200);
  await page.mouse.down(); trace('press and hold');
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    await page.waitForTimeout(500);
    await page.mouse.move(x + (Math.random() - 0.5) * 2, y + (Math.random() - 0.5) * 2);
    const gone = !(await page.locator('#px-captcha').first().isVisible().catch(() => false));
    const done = await page.evaluate(() => /verified|thank you|access granted/i.test((document.body || {}).innerText || '')).catch(() => false);
    if (gone || done || Date.now() - t0 > 11000) break;
  }
  await page.mouse.up();
  await page.waitForTimeout(3000);
  return !(await page.locator('#px-captcha').first().isVisible().catch(() => false));
}

// ── Proof-of-work widgets (Friendly Captcha, ALTCHA, mCaptcha) ───────────────

async function solveProofOfWork(page) {
  trace('proof of work');
  for (const fr of scan(page)) {
    const btn = (await domRects(fr, '.frc-captcha button.frc-button, altcha-widget input[type="checkbox"], .altcha input[type="checkbox"], #widget__verification-checkbox, .mcaptcha input[type="checkbox"]', 8))[0];
    if (btn) { const r = await pageRect(page, fr, btn); if (r) await humanClick(page, r.x + r.width / 2, r.y + r.height / 2); }
  }
  for (let i = 0; i < 40; i++) {   // the browser does the work; it takes a few seconds
    await page.waitForTimeout(1000);
    const ok = await page.evaluate(() => {
      const frc = document.querySelector('input[name="frc-captcha-solution"], input[name="frc-captcha-response"]');
      const alt = document.querySelector('altcha-widget, .altcha');
      return !!(document.querySelector('.frc-success') || (frc && frc.value && !frc.value.startsWith('.')) ||
        (alt && /verified/i.test(alt.getAttribute('data-state') || alt.getAttribute('state') || '')) ||
        [...document.querySelectorAll('input[name="altcha"], input[name="mcaptcha__token"]')].some((e) => (e.value || '').length > 10));
    }).catch(() => false);
    if (ok) return true;
  }
  return false;
}

// ── Text-image CAPTCHA (OCR) ─────────────────────────────────────────────────

async function solveTextImage(page) {
  for (const fr of scan(page)) {
    const found = await fr.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const capSig = (e) => { let p = ''; try { p = e.src && !/^data:/.test(e.src) ? new URL(e.src).pathname : ''; } catch {}
        return (p + ' ' + e.id + ' ' + (typeof e.className === 'string' ? e.className : '') + ' ' + (e.alt || '') + ' ' + (e.getAttribute('name') || '')).toLowerCase(); };
      const painted = (e) => /url\(/.test(getComputedStyle(e).backgroundImage || '');
      const imgs = [...document.querySelectorAll('img, canvas, div[id*="captcha" i], div[class*="captcha" i], div[id*="mtcap" i], span[class*="captcha" i]')]
        .filter((e) => (e.tagName === 'IMG' || e.tagName === 'CANVAS' || painted(e))).filter((e) => { const s = capSig(e), r = e.getBoundingClientRect();
          return /captcha|mtcap|securimage|kcaptcha|verif\w*[-_ ]?code|security[-_ ]?code/.test(s) && !/recaptcha|hcaptcha/.test(s) && !/\.svg(\?|$)/.test(e.src || '') && r.width >= 50 && r.height >= 18 && r.height <= 220; });
      // the answer box, then the CAPTCHA picture closest to it (an e-mail "verification code" field far from any picture is not it)
      const inp = [...document.querySelectorAll('input')].find((i) => vis(i) && !i.value && (i.type === 'text' || !i.type) && /captcha|mtcap|security.?code|verification.?code|characters|code.*(image|shown|above)|text (from|in|on) (the )?(image|picture)|type the (text|characters|code)|enter (the )?(code|text) shown/i
        .test((i.name || '') + ' ' + (i.id || '') + ' ' + (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '')));
      if (!inp || !imgs.length) return null;
      const c = (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
      const [ix, iy] = c(inp), dist = (e) => { const [x, y] = c(e); return Math.hypot(x - ix, y - iy); };
      const img = imgs.sort((a, b) => dist(a) - dist(b))[0];
      if (dist(img) > 420) return null;
      inp.setAttribute('data-relay-captcha', '1');
      const r = img.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }).catch(() => null);
    if (!found) continue;
    const r = await pageRect(page, fr, found); const shot = r && await shotClip(page, r);
    if (!shot) return false;
    // ENSEMBLE (measured 2026-10-16 on distorted CAPTCHAs: ddddocr 50%, vision 45%, 3× upscaled vision 55%, majority of
    // the four 65% per attempt): two vision reads (original + 3× upscaled) and both ddddocr models, majority wins
    const big = sharp ? await sharp(shot).resize({ width: Math.round((await sharp(shot).metadata()).width * 3), kernel: 'lanczos3' }).png().toBuffer().catch(() => shot) : shot;
    const P = 'This image is a distorted text CAPTCHA. Read it character by character, left to right (case-sensitive; letters and digits only, no spaces). ' +
      'If instead it shows an arithmetic question, reply {"math": true}. Reply ONLY with JSON {"text": "..."}.';
    const [o, v3, v1] = await Promise.all([svc('/ocr', { image_b64: shot.toString('base64') }, 30000), visionJson(big, P), visionJson(shot, P)]);
    if ((v3 && v3.math) || (v1 && v1.math)) { log('text-image: arithmetic CAPTCHA — not answered (policy)'); return false; }
    const norm = (x) => String(x || '').replace(/[^0-9A-Za-z]/g, '');
    const cands = [v3 && norm(v3.text), v1 && norm(v1.text), o.ok && norm(o.text), o.ok && norm(o.alt || o.text)].filter((x) => x && x.length >= 3);
    const tally = {}; for (const c of cands) tally[c.toLowerCase()] = (tally[c.toLowerCase()] || 0) + 1;
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    let j = null;
    if (top && top[1] >= 2) j = { text: cands.find((c) => c.toLowerCase() === top[0]), by: 'vote ' + top[1] + '/' + cands.length };
    else if (cands.length) j = { text: cands[0], by: 'best single (' + (v3 ? 'vision×3' : v1 ? 'vision' : 'ddddocr') + ')' };
    log('text-image ensemble', JSON.stringify({ cands, pick: j }));
    if (j) trace('OCR ' + j.by);
    if (!j || j.math || !j.text) return false;
    const inp = fr.locator('[data-relay-captcha="1"]').first();
    await inp.click().catch(() => {});
    await inp.pressSequentially(String(j.text).replace(/\s+/g, ''), { delay: 90 + Math.random() * 60 }).catch(() => {});
    await inp.press('Tab').catch(() => {});   // MTCaptcha and most widgets check the answer on blur
    await inp.evaluate((e) => e.removeAttribute('data-relay-captcha')).catch(() => {});
    log('text-image →', j.text);
    return true;
  }
  return false;
}

// ── AWS WAF CAPTCHA / generic image puzzles (vision + Confirm) ───────────────

async function solveVisionPuzzle(page, frame, sel, label) {
  const rr = (await domRects(frame, sel, 120))[0]; if (!rr) return false;
  const box = await pageRect(page, frame, rr); const shot = box && await shotClip(page, box);
  if (!shot) return false;
  const j = await visionJson(shot, `This is a ${label} CAPTCHA. Read its instruction in the image and solve it. Return ONLY JSON {"clicks": [[x, y], ...]} — ` +
    'pixel points to click from the top-left of this image (image tiles or objects to select; NOT the confirm/submit button).');
  if (!j || !Array.isArray(j.clicks) || !j.clicks.length) return false;
  for (const [x, y] of j.clicks) { await humanClick(page, box.x + x, box.y + y); await page.waitForTimeout(350 + Math.random() * 300); }
  const btn = frame.locator(`${sel} button, button`).filter({ hasText: /confirm|verify|submit|next|continue/i }).first();
  if (await btn.isVisible().catch(() => false)) { const b = await btn.boundingBox(); if (b) await humanClick(page, b.x + b.width / 2, b.y + b.height / 2); }
  await page.waitForTimeout(2500);
  return true;
}

// ── Arkose / FunCaptcha (vision, round by round) ─────────────────────────────

async function solveArkose(page) {
  trace('Arkose vision rounds');
  for (let round = 0; round < 10; round++) {
    let game = null;
    for (const f of framesMatching(page, /arkoselabs|funcaptcha/)) { const b = await frameBox(f); if (b && b.width > 250 && b.height > 250 && (!game || b.width * b.height <= game.box.width * game.box.height)) game = { frame: f, box: b }; }
    if (!game) return round > 0;
    const shot = await shotClip(page, game.box); if (!shot) return false;
    const j = await visionJson(shot, 'This is an Arkose Labs (FunCaptcha) challenge round. Read the instruction in the image. Return ONLY JSON: ' +
      '{"clicks": [[x, y], ...]} — every click needed to answer THIS round in order (e.g. the matching image, or an arrow button pressed N times, ' +
      'then the Submit/Verify button if there is one) — pixel points from the top-left of this image; or {"done": true} if the image shows the challenge is complete.');
    if (!j) return false;
    if (j.done) return true;
    if (!Array.isArray(j.clicks) || !j.clicks.length) return false;
    for (const [x, y] of j.clicks) { await humanClick(page, game.box.x + x, game.box.y + y); await page.waitForTimeout(450 + Math.random() * 350); }
    await page.waitForTimeout(2500);
  }
  return false;
}

// ── Generic vision fallback (a "verify you are human" puzzle nobody else recognised) ─

async function solveWithVLM(page, el) {
  const box = await el.boundingBox().catch(() => null); const shot = box && await shotClip(page, box);
  if (!shot) return false;
  const promptText = await el.evaluate((e) => { const p = e.querySelector('h2, h3, .prompt, .instruction, [class*="prompt"], [class*="instruction"]'); return p ? p.innerText : ''; }).catch(() => '');
  const j = await visionJson(shot, `Solve this CAPTCHA${promptText ? ' ("' + promptText + '")' : ''}. Return ONLY JSON {"clicks": [[x, y], ...]} (points from the top-left of this image) or {"x_offset": <pixels to drag the slider>}.`);
  if (!j) return false;
  if (Array.isArray(j.clicks) && j.clicks.length) { for (const [x, y] of j.clicks) { await humanClick(page, box.x + x, box.y + y); await page.waitForTimeout(400 + Math.random() * 300); } return true; }
  if (typeof j.x_offset === 'number') {
    const h = await el.locator('[class*="drag"], [class*="handle"], [class*="slider"], [role="slider"]').first().boundingBox().catch(() => null);
    if (h) { await humanDrag(page, h.x + h.width / 2, h.y + h.height / 2, j.x_offset); return true; }
  }
  return false;
}

// ── Extension wait (the background solver extension, a delayed auto-pass) ───

async function waitForExtensionSolver(page, maxWaitSec = 25) {
  for (let i = 0; i < maxWaitSec / 2; i++) {
    await page.waitForTimeout(2000);
    const tok = await anyFrame(page, () => [...document.querySelectorAll('[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]')].some((e) => (e.value || '').length > 10));
    if (tok) return { solved: true, by: 'token' };
    if (!(await hcapChallenge(page)) && !(await visibleFrame(page, /recaptcha.*\/bframe/, 250, 250)) && !(await page.locator('#captcha-verify-image, .secsdk-captcha-drag-icon').first().isVisible().catch(() => false))) {
      const ids = await identify(page);
      if (!ids.some((v) => v.solvable)) return { solved: true, by: 'dismissed' };
    }
  }
  return { solved: false, by: 'timeout' };
}

// ── Main entry point ─────────────────────────────────────────────────────────

const SOLVERS = {
  'cloudflare/interstitial': (p) => solveCfInterstitial(p),
  'perimeterx/press-and-hold': (p) => solvePressHold(p),
  'bytedance/slider': (p) => solveByteDance(p),
  'bytedance/select-objects': (p) => solveByteDance(p),
  'recaptcha/checkbox': (p) => solveRecaptcha(p),
  'recaptcha/challenge': (p) => solveRecaptcha(p),
  'turnstile/widget': (p) => solveTurnstile(p),
  'hcaptcha/checkbox': (p) => solveHcaptcha(p),
  'hcaptcha/challenge': (p) => solveHcaptcha(p),
  'hcaptcha/invisible': (p) => solveHcaptcha(p),
  'friendly-captcha/proof-of-work': (p) => solveProofOfWork(p),
  'altcha/proof-of-work': (p) => solveProofOfWork(p),
  'mcaptcha/proof-of-work': (p) => solveProofOfWork(p),
  'datadome/slider': async (p) => { for (const f of framesMatching(p, /captcha-delivery\.com/)) if (await solveSliderInFrame(p, f, null)) return true; return false; },
  'geetest/challenge': (p) => solveGeetest(p),
  'slider/slider': async (p) => { for (const f of scan(p)) if (await solveSliderInFrame(p, f)) return true; return false; },
  'aws-waf/challenge': async (p) => { for (const f of scan(p)) if (await solveVisionPuzzle(p, f, 'awswaf-captcha, #captcha-container', 'AWS WAF')) return true; return false; },
  'arkose/game': (p) => solveArkose(p),
  // MTCaptcha checks the typed text itself and issues its token a moment later — wait for it before judging
  'mtcaptcha/text-image': async (p) => { const ok = await solveTextImage(p); for (let i = 0; ok && i < 8 && !(await mtcapVerified(p)); i++) await p.waitForTimeout(750); return ok; },
  'text-image/ocr': (p) => solveTextImage(p),
};
// order: interstitials first (they hide everything else), then interactive widgets
const ORDER = ['cloudflare/interstitial', 'perimeterx/press-and-hold', 'bytedance/slider', 'bytedance/select-objects', 'recaptcha/checkbox', 'recaptcha/challenge',
  'turnstile/widget', 'hcaptcha/checkbox', 'hcaptcha/challenge', 'hcaptcha/invisible', 'friendly-captcha/proof-of-work', 'altcha/proof-of-work', 'mcaptcha/proof-of-work',
  'datadome/slider', 'geetest/challenge', 'slider/slider', 'aws-waf/challenge', 'arkose/game', 'mtcaptcha/text-image', 'text-image/ocr'];

// Is anything still unsolved? (a token present, or the widget gone, means solved)
async function stillThere(page, key) {
  if (/^recaptcha/.test(key)) return !(await recapChecked(page)) && (!!(await visibleFrame(page, /recaptcha.*\/anchor/, 60, 60)) || !!(await visibleFrame(page, /recaptcha.*\/bframe/, 250, 250)));
  // a pass the site's callback already consumed is not "still there" (re-opening it would submit the form again)
  if (/^hcaptcha/.test(key) && hcapPassedSince(page, Date.now() - 120000) && !(await hcapChallenge(page))) return false;
  if (/^hcaptcha/.test(key)) return !(await hcapToken(page)) && (!!(await hcapChallenge(page)) || framesMatching(page, /hcaptcha/).length > 0);
  if (/^turnstile/.test(key)) return (await tsToken(page)) <= 10 && (framesMatching(page, /challenges\.cloudflare\.com/).length > 0 || !!(await turnstileBox(page)));
  const ids = await identify(page);
  return ids.some((v) => v.vendor + '/' + v.kind === key);
}

async function _solveIfPresent(page, maxAttempts = 3) {
  try {
    let vendors = await identify(page);
    if (isWall(vendors)) return { solved: false, type: 'antibot-wall', wall: true, attempts: 0, vendors, vendorText: vendorText(vendors) };
    const policy = vendors.find((v) => v.vendor === 'math');
    const todo = ORDER.filter((k) => vendors.some((v) => v.vendor + '/' + v.kind === k));
    if (!todo.length) {
      // unrecognised: a "verify you are human" text over some puzzle → vision fallback
      const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 5000)).catch(() => '');
      if (/verify (that )?you are (a )?human|complete the (security|human) check|i'?m not a robot|prove you('re| are) human|security check/i.test(txt)) {
        for (let a = 1; a <= maxAttempts; a++) {
          const el = page.locator('[class*="captcha"], [id*="captcha"], [class*="challenge"], [class*="verify"]').first();
          if (!(await el.isVisible().catch(() => false))) break;
          await solveWithVLM(page, el); await page.waitForTimeout(1500);
          const t2 = await page.evaluate(() => (document.body.innerText || '').slice(0, 5000)).catch(() => '');
          if (!/verify (that )?you are|complete the.*check|i'?m not a robot|prove you('re| are) human/i.test(t2)) return { solved: true, type: 'vision-fallback', attempts: a, vendors, vendorText: vendorText(vendors) };
        }
        const ext = await waitForExtensionSolver(page, 10);
        return { solved: ext.solved, type: ext.solved ? 'text-hint-extension' : 'unidentified', attempts: maxAttempts, vendors, vendorText: vendorText(vendors) };
      }
      if (!policy && vendors.some((v) => v.kind === 'solved') && !vendors.some((v) => v.solvable)) return { solved: true, type: 'already-solved', attempts: 0, vendors, vendorText: vendorText(vendors) };
      const nothing = vendors.every((v) => !v.solvable);
      return { solved: false, type: policy ? 'math-policy' : nothing && vendors.length ? 'not-solvable' : 'none', attempts: 0, vendors, vendorText: vendorText(vendors), ...(policy ? { policy: policy.note } : {}) };
    }
    for (const key of todo) {
      for (let a = 1; a <= maxAttempts; a++) {
        log('solving', key, 'attempt', a);
        await SOLVERS[key](page).catch((e) => log(key, 'threw', e.message));
        await page.waitForTimeout(1200);
        if (!(await stillThere(page, key))) break;
        if (VISION_DECLINED) { vendors = await identify(page); return { solved: false, declined: true, type: key, attempts: a, vendors, vendorText: vendorText(vendors) }; }
        const ext = await waitForExtensionSolver(page, 6);
        if (ext.solved) break;
        if (a === maxAttempts) {
          vendors = await identify(page);
          return { solved: false, type: key, attempts: a, vendors, vendorText: vendorText(vendors) };
        }
      }
    }
    vendors = await identify(page);
    const left = vendors.filter((v) => v.solvable && v.vendor !== 'cloudflare');
    const open = [];
    for (const v of left) if (await stillThere(page, v.vendor + '/' + v.kind)) open.push(v);
    return { solved: !open.length && !policy, type: todo.join('+'), attempts: 1, vendors, vendorText: vendorText(vendors), ...(policy ? { policy: policy.note } : {}) };
  } finally {}
}

// ── Encounter log (2026-10-16): every CAPTCHA a driver meets → pipeline/captcha_log.jsonl (the panel's "CAPTCHA solver"
// section). The driver says which job it is on with setContext(); tests set AURA_CAPTCHA_LOG=0, the benchmark tags itself.
const LOG_FILE = path.join(__dirname, '..', 'pipeline', 'captcha_log.jsonl');
let CTX = {};
function setContext(c) { CTX = { ...CTX, ...(c || {}) }; }
let TRACE = [];
const trace = (x) => { TRACE.push(String(x)); };

// EVIDENCE FOR EVERY CAPTCHA (2026-10-16): a live miss left nothing to look at, so a repair session could only guess. Every
// hCaptcha round, tile grid + answer and drag before/after is kept per encounter under pipeline/captcha_debug/<day>/<id>/
// (3 days, pruned here); the encounter log row names the folder. CAPTCHA_DEBUG_DIR overrides; AURA_CAPTCHA_SHOTS=0 turns it off.
let DBG = null;
const dbgDir = () => process.env.CAPTCHA_DEBUG_DIR || (process.env.AURA_CAPTCHA_SHOTS === '0' ? null : DBG);
function newDbg() {
  if (process.env.CAPTCHA_DEBUG_DIR || process.env.AURA_CAPTCHA_SHOTS === '0') return;
  const root = path.join(__dirname, '..', 'pipeline', 'captcha_debug'), day = new Date().toISOString().slice(0, 10);
  DBG = path.join(root, day, Date.now().toString(36) + '-' + String(CTX.company || 'probe').replace(/[^a-z0-9]+/gi, '-').slice(0, 30));
  try { for (const d of fs.readdirSync(root)) if (d < new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)) fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch {}
}
// EVERY MISS LEAVES EVIDENCE (2026-10-22): a page screenshot, what each CAPTCHA frame shows (its text: "Try again later",
// "Verification failed", an error code …), the Turnstile widgets' own state, and the console lines heard during the solve.
async function missEvidence(page, heard) {
  const d = dbgDir(); if (!d) return;
  fs.mkdirSync(d, { recursive: true });
  await page.screenshot({ path: path.join(d, 'miss-page.png'), fullPage: false }).catch(() => {});
  const frames = [];
  for (const f of scan(page)) {
    const u = f.url();
    if (!/recaptcha|hcaptcha|challenges\.cloudflare\.com|captcha/i.test(u) && f !== page.mainFrame()) continue;
    const info = await f.evaluate(() => {
      const ts = [];
      try { for (const e of document.querySelectorAll('input[id^="cf-chl-widget-"], [name="cf-turnstile-response"], [name="g-recaptcha-response"], [name="h-captcha-response"]')) ts.push((e.id || e.name) + ':' + (e.value || '').length); } catch {}
      let tsState = null;
      try { if (window.turnstile) tsState = { expired: typeof window.turnstile.isExpired === 'function' ? window.turnstile.isExpired() : null, resp: (window.turnstile.getResponse() || '').length }; } catch (e) { tsState = { err: String(e.message || e).slice(0, 80) }; }
      return { text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 300), inputs: ts, turnstile: tsState };
    }).catch((e) => ({ err: String(e.message || e).slice(0, 80) }));
    frames.push({ url: u.slice(0, 160), box: await frameBox(f).catch(() => null), ...info });
  }
  fs.writeFileSync(path.join(d, 'miss.json'), JSON.stringify({ at: new Date().toISOString(), page: page.url(), trace: TRACE, heard, frames }, null, 1));
}
let SOLVE_T0 = Date.now();
async function solveIfPresent(page, maxAttempts = 3) {
  const t0 = Date.now(); SOLVE_T0 = t0; TRACE = []; VISION_DECLINED = false; newDbg();
  let r;
  // what the widgets and the site say while we solve (2026-10-22: 25 Turnstile / reCAPTCHA misses left no evidence at all —
  // Rippling logs "Turnstile failed with error code: N" to the console, and the code names the cause)
  const heard = [];
  const onConsole = (m) => { try { const t = m.text(); if (/turnstile|captcha|cloudflare|error code|challenge/i.test(t)) heard.push(t.slice(0, 200)); } catch {} };
  try { page.on('console', onConsole); } catch {}
  // a cookie-consent veil over the page swallows every tile click / drag (AMD iCIMS OneTrust, 2026-10-16)
  try { const c = await require('./consent').dismiss(page); if (c.length) { trace('cookie banner closed'); log('consent:', c.join('; ')); } } catch {}
  try { r = await _solveIfPresent(page, maxAttempts); }
  catch (e) { r = { solved: false, type: 'error', error: String(e.message || e).slice(0, 160), vendors: [], vendorText: 'error' }; }
  try { page.off('console', onConsole); } catch {}
  for (const h of heard) { const code = h.match(/error code:?\s*(\d{3,6})/i); if (code) trace('widget error ' + code[1]); }
  if (!r.solved && !r.wall && r.type !== 'none') await missEvidence(page, heard).catch(() => {});
  r.how = [...new Set(TRACE)].join(', ');
  if (process.env.AURA_CAPTCHA_LOG !== '0' && r.type !== 'none') {
    let host = ''; try { host = new URL(page.url()).host; } catch {}
    const rec = { ts: new Date().toISOString(), company: CTX.company || null, role: CTX.role || null, job: CTX.url || null, via: CTX.via || (CTX.url ? null : 'probe'),   // no setContext = a diagnosis script, never counted as an application
      // the vendors met = what was solved (r.type, e.g. "hcaptcha/invisible") — after a solve the widget only reports "solved"
      worker: process.env.AURA_WORKER || null, host,
      vendors: [...new Set([...String(r.type || '').split('+').filter((x) => /^[a-z-]+\/[a-z-]+$/.test(x)),
        ...(r.vendors || []).filter((v) => v.kind !== 'solved').map((v) => v.vendor + '/' + v.kind),
        ...(r.type === 'already-solved' ? (r.vendors || []).map((v) => v.vendor + '/' + v.kind) : [])])],
      solved: !!r.solved, type: r.type, how: r.how, attempts: r.attempts, secs: Math.round((Date.now() - t0) / 100) / 10,
      wall: !!r.wall, policy: r.policy || null, declined: !!r.declined, shots: (() => { try { const d = dbgDir(); return d && fs.existsSync(d) ? path.relative(path.join(__dirname, '..'), d) : null; } catch { return null; } })(), engine: (() => { try { return require('./stealth').ENGINE; } catch { return null; } })() };
    try { fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n'); } catch {}
  }
  return r;
}

// The page looks like a bot check (domain_guard.sniff hit). A wall → { wall: true } (cool the domain, never retry from
// here). A challenge (Cloudflare interstitial, press-and-hold, DataDome / any CAPTCHA) → wait for the auto-pass and
// solve it; cleared when the page no longer looks like a bot check.
async function clearChallenge(page, { maxMs = 45000 } = {}) {
  const guard = require('./domain_guard');
  const t0 = Date.now();
  const bodyText = () => page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 4000)).catch(() => '');
  let vendors = await identify(page);
  if (isWall(vendors)) return { cleared: false, wall: true, vendors, vendorText: vendorText(vendors) };
  let last = null;
  while (Date.now() - t0 < maxMs) {
    last = await solveIfPresent(page, 2);
    if (last.wall) return { cleared: false, wall: true, vendors: last.vendors, vendorText: last.vendorText };
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const hit = guard.sniff(await bodyText());
    vendors = await identify(page);
    if (!hit && !vendors.some((v) => v.solvable && v.kind !== 'invisible')) return { cleared: true, by: last.type, vendors, vendorText: vendorText(vendors), secs: Math.round((Date.now() - t0) / 1000) };
    if (isWall(vendors)) return { cleared: false, wall: true, vendors, vendorText: vendorText(vendors) };
    if (hit === 'spam') return { cleared: false, spam: true, vendors, vendorText: vendorText(vendors) };
  }
  return { cleared: false, wall: false, vendors, vendorText: vendorText(vendors), by: last && last.type };
}

module.exports = { solveIfPresent, setContext, clearChallenge, identify, humanDrag, humanDragTo, humanClick, waitForExtensionSolver, isWall, vendorText,
  _internals: { claudeVision, lastJson, pickTiles, overlayNumbers, domRects, pageRect, frameBox, solveSliderInFrame, solveTextImage, solvePressHold, solveProofOfWork, solveTurnstile, solveCfInterstitial, visionJson, gridOverlay } };
