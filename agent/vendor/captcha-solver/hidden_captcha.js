// HIDDEN RELAY CHROME — hCaptcha PUZZLE ANSWERS (2026-10-19, Stanley: Indeed iCIMS "There is a human check on it").
// The hidden Relay Chrome (hidden_relay.js) is a plain, non-automated Chrome: when iCIMS's invisible hCaptcha opens a visible
// puzzle there, its background worker (extension/background.js, hidden copy only) reads the challenge frame through
// chrome.debugger (instruction text, tile / canvas / button boxes), takes a viewport screenshot and asks the control panel
// (/api/hidden_captcha, hidden-only) — which runs THIS script — where to click. The worker then clicks with real input
// (Input.dispatchMouseEvent). Vision is captcha_solver.js's own (Gemini when a key exists, else Claude), reused by require.
//
// stdin  {img: base64 viewport screenshot, box: {x,y,width,height} of the challenge frame, instruction, tiles: [{x,y,width,height}]
//         (viewport coords), canvas: {x,y,width,height} | null}
// stdout {ok, kind: 'tiles'|'points'|'drag', clicks: [[x,y]…], drags: [{from:[x,y], to:[x,y]}…]}  (viewport coords)
//     or {ok:false, refused:'math-policy' | error}
// Never answers an arithmetic / trap challenge (CLAUDE.md: trap questions are never answered automatically).
const sharp = require('sharp');
const { _internals: S } = require('./captcha_solver');

const TRAP = /\d+\s*[-+×x*÷\/]\s*\d+|\b(sum|add|subtract|multiply|divide|equals?|calculate|arithmetic|how many letters|type the word|paying attention)\b/i;

async function main(inp) {
  const instruction = String(inp.instruction || '').trim();
  if (TRAP.test(instruction)) return { ok: false, refused: 'math-policy', instruction };
  const img = Buffer.from(String(inp.img || '').split(',').pop(), 'base64');
  const meta = await sharp(img).metadata();
  const clamp = (r) => { const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y)); return { left: x, top: y, width: Math.max(1, Math.min(meta.width - x, Math.round(r.width))), height: Math.max(1, Math.min(meta.height - y, Math.round(r.height))) }; };
  const crop = async (r) => { const c = clamp(r); return { c, buf: await sharp(img).extract(c).png().toBuffer() }; };
  const box = inp.box;
  if (!box || box.width < 50 || box.height < 50) return { ok: false, error: 'no challenge box' };

  // drag puzzles: from / to inside the challenge box
  if (/drag|move|scale|place the|put the/i.test(instruction)) {
    const { c, buf } = await crop(box); const gridded = await S.gridOverlay(buf);
    const j = await S.visionJson(gridded, `hCaptcha drag puzzle: "${instruction}". A red coordinate grid is drawn over the image: vertical lines are labelled ` +
      'with their x pixel at the top, horizontal lines with their y pixel at the left (every 50 px). Decide which piece(s) must be dragged and exactly where. ' +
      'Return ONLY JSON {"drags": [{"from": [x1, y1], "to": [x2, y2]}]}: "from" = center of the piece to drag, "to" = center of the matching target.');
    const d = j && (j.drags || []);
    if (!Array.isArray(d) || !d.length || !d[0].from) return { ok: false, error: 'vision gave no drag' };
    return { ok: true, kind: 'drag', instruction, drags: d.map((x) => ({ from: [c.left + x.from[0], c.top + x.from[1]], to: [c.left + x.to[0], c.top + x.to[1]] })) };
  }
  // tile grids: numbered at their real centres (Set-of-Mark), the model names the numbers
  const tiles = (inp.tiles || []).filter((t) => t && t.width >= 30 && t.height >= 30);
  if (tiles.length >= 4) {
    const { c, buf } = await crop(box);
    const centers = tiles.map((t) => ({ x: t.x - c.left + t.width / 2, y: t.y - c.top + t.height / 2 }));
    const labeled = await S.overlayNumbers(buf, centers, Math.min(...tiles.map((t) => t.width)) / 5);
    const pattern = /pattern|odd one|doesn.?t belong|does not belong/i.test(instruction);
    const j = await S.visionJson(labeled, (instruction ? `Challenge instruction: "${instruction}${pattern ? ' (pick the tiles that break the pattern)' : ''}"\n\n` : '') +
      `This is an hCaptcha image challenge with ${tiles.length} tiles, each marked with a red number 1-${tiles.length}. Look at each tile carefully. ` +
      'Return ONLY JSON {"tiles": [numbers]} with the tile NUMBERS that match the instruction, e.g. {"tiles": [2, 5, 9]}; {"tiles": []} if none match.');
    const arr = Array.isArray(j) ? j : (j && (j.tiles || j.numbers)) || null;
    if (!arr) return { ok: false, error: 'vision gave no tiles' };
    const nums = [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= tiles.length))];
    return { ok: true, kind: 'tiles', instruction, nums, clicks: nums.map((n) => { const t = tiles[n - 1]; return [t.x + t.width / 2, t.y + t.height / 2]; }) };
  }
  // canvas point tasks: measure every candidate, then choose (the solver's own prompt)
  const area = inp.canvas && inp.canvas.width >= 100 ? inp.canvas : box;
  const { c, buf } = await crop(area); const gridded = await S.gridOverlay(buf);
  const j = await S.visionJson(gridded, `hCaptcha instruction: "${instruction}". A red coordinate grid is drawn over the image (vertical lines labelled with ` +
    'their x pixel at the top, horizontal lines with their y pixel at the left, every 50 px). FIRST list EVERY candidate object left to right with its center ' +
    'and the property the instruction is about, measured carefully. THEN choose exactly the object(s) the instruction asks for. Return ONLY JSON ' +
    '{"objects": [{"center": [x, y], "property": "..."}], "clicks": [[x, y], ...]} in pixels from the top-left of this image.');
  if (!j || !Array.isArray(j.clicks) || !j.clicks.length) return { ok: false, error: 'vision gave no points' };
  return { ok: true, kind: 'points', instruction, clicks: j.clicks.filter((p) => Array.isArray(p) && p.length >= 2).map(([x, y]) => [c.left + x, c.top + y]) };
}

let raw = ''; process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  let out; try { out = await main(JSON.parse(raw)); } catch (e) { out = { ok: false, error: String(e.message || e).slice(0, 200) }; }
  process.stdout.write(JSON.stringify(out) + '\n'); process.exit(0);
});
