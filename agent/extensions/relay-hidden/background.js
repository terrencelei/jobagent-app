// The background worker hidden_captcha.js was written for (its header: "reads the challenge frame
// through chrome.debugger, takes a viewport screenshot and asks the control panel (/api/hidden_captcha)
// where to click. The worker then clicks with real input (Input.dispatchMouseEvent)"). Loaded only into
// the hand-off Chrome (src/human-chrome.mjs), never into the Playwright browsers, whose in-process
// solver handles hCaptcha itself. A refusal or decline stops it for that tab.
const API = 'http://127.0.0.1:8787/api/hidden_captcha';
const MAX_ROUNDS = 8;
const tabs = new Map();   // tabId -> {rounds, stopped, busy}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (n) => n + (Math.random() - 0.5) * 3;

const send = (target, method, params = {}) => new Promise((resolve, reject) =>
  chrome.debugger.sendCommand(target, method, params, (r) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r))));
const attach = (target) => new Promise((resolve, reject) =>
  chrome.debugger.attach(target, '1.3', () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve())));
const detach = (target) => new Promise((resolve) => chrome.debugger.detach(target, () => { void chrome.runtime.lastError; resolve(); }));

// The challenge iframe's box in the top viewport: walk the top document and every same-origin child
// document, adding frame offsets, for a visible hcaptcha.com challenge iframe of the reported size.
async function frameBox(target, size) {
  const expr = `(() => {
    const want = ${JSON.stringify(size)}, hits = [];
    const walk = (doc, ox, oy) => {
      for (const f of doc.querySelectorAll('iframe')) {
        const r = f.getBoundingClientRect(), s = getComputedStyle(f);
        const visible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0;
        if (visible && /hcaptcha\\.com/.test(f.src || '') && !/frame=(checkbox|enclave)/.test(f.src || '')) hits.push({ x: ox + r.x, y: oy + r.y, width: r.width, height: r.height });
        let inner = null; try { inner = f.contentDocument; } catch {}
        if (inner) walk(inner, ox + r.x + f.clientLeft, oy + r.y + f.clientTop);
      }
    };
    walk(document, 0, 0);
    hits.sort((a, b) => (Math.abs(a.width - want.width) + Math.abs(a.height - want.height)) - (Math.abs(b.width - want.width) + Math.abs(b.height - want.height)));
    return JSON.stringify({ box: hits[0] || null, vw: innerWidth, vh: innerHeight });
  })()`;
  const r = await send(target, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  return JSON.parse(r.result.value);
}

async function click(target, x, y) {
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: jitter(x), y: jitter(y) });
  await sleep(60 + Math.random() * 80);
  await send(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(50 + Math.random() * 60);
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function drag(target, [fx, fy], [tx, ty]) {
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx, y: fy });
  await send(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1 });
  const steps = 25 + Math.floor(Math.random() * 10);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await send(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: jitter(fx + (tx - fx) * e), y: jitter(fy + (ty - fy) * e), button: 'left', buttons: 1 });
    await sleep(8 + Math.random() * 12);
  }
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1 });
}

async function round(tabId, frameId, m) {
  const st = tabs.get(tabId) || { rounds: 0, stopped: false, busy: false };
  tabs.set(tabId, st);
  if (st.stopped || st.busy || st.rounds >= MAX_ROUNDS) return;
  st.busy = true; st.rounds++;
  const target = { tabId };
  const tell = (on) => chrome.tabs.sendMessage(tabId, { type: 'dispatching', on }, { frameId }).catch(() => {});
  try {
    await attach(target);
    const { box, vw, vh } = await frameBox(target, m.frame);
    if (!box) return;
    const shot = await send(target, 'Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: vw, height: vh, scale: 1 } });
    const off = (r) => r && { x: box.x + r.x, y: box.y + r.y, width: r.width, height: r.height };
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ img: shot.data, box, instruction: m.instruction, tiles: m.tiles.map(off), canvas: off(m.canvas) }) }).then((r) => r.json());
    if (!res.ok) { if (res.refused || res.declined || /declin|can.?t help|won.?t/i.test(String(res.error || ''))) st.stopped = true; return; }
    await tell(true);
    for (const [x, y] of res.clicks || []) { await click(target, x, y); await sleep(300 + Math.random() * 300); }
    for (const d of res.drags || []) { await drag(target, d.from, d.to); await sleep(400); }
    const sub = off(m.submit);
    if (sub) { await sleep(500); await click(target, sub.x + sub.width / 2, sub.y + sub.height / 2); }
  } catch (e) {
    console.log('[RelayHidden]', e.message);
  } finally {
    await tell(false);
    await detach(target);
    st.busy = false;
  }
}

chrome.runtime.onMessage.addListener((m, sender) => {
  if (m && m.type === 'hcaptcha-round' && sender.tab) round(sender.tab.id, sender.frameId, m);
});
chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
