// Minimal, CHEAP LLM call wrapper for the deterministic apply path (2026-09-26).
//
// The Claude Code CLI loads a big system prompt on every invocation — CLAUDE.md, every MCP server
// (Gmail/Notion/Google/…), skills, tool schemas — which made even a one-word Haiku call cost ~$0.044.
// We strip all of that (empty MCP config, no tools, a throwaway CWD with no CLAUDE.md) to get a
// bounded ~$0.01–0.02 single-shot text call. This is what the deterministic pipeline uses for the
// only three things that genuinely need a model — fit-gate, résumé tailoring, and essay drafting —
// instead of a 500-turn Sonnet session (~$20/app). Everything else is pure code.
//
// Returns { text, cost, usage } so callers can record exact per-call cost for metrics.
// Model defaults to Haiku (the cheap tier); pass model:'sonnet' only for a deliberate quality step.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function claudeBin() {
  // application-agent (2026-10-24): the only change to the supplied package. The original looks only in its author's
  // VS Code extension folder, which does not exist here, so require('./llm') threw on load and every vlmJson call
  // (OCR, sliders, Arkose) got nothing. This Mac's signed-in CLI comes first; the original lookup is kept after it.
  for (const p of [process.env.CLAUDE_BIN, path.join(os.homedir(), '.local', 'bin', 'claude')]) if (p && fs.existsSync(p)) return p;
  const dirs = fs.readdirSync('/Users/stanleyshen/.vscode/extensions')
    .filter((d) => /^anthropic\.claude-code-.*-darwin-arm64$/.test(d)).sort();
  if (!dirs.length) throw new Error('claude binary not found');
  return path.join('/Users/stanleyshen/.vscode/extensions', dirs[dirs.length - 1], 'resources/native-binary/claude');
}
const CLAUDE = claudeBin();

// EXTENDED THINKING OFF (2026-10-01). Measured on the tailoring prompt: with the CLI's default thinking
// budget one Haiku call took 187 s and 20,453 output tokens ($0.14) to return a 1.5 KB JSON answer — over
// tailor.js's own 180 s timeout, so the model path regularly fell back to code-only tailoring. With
// MAX_THINKING_TOKENS=0 the same prompt took 8 s, 565 output tokens ($0.04), and MORE of its rewrites
// passed vetting (5/5 vs 3/3). Every call here is a bounded single-shot whose output is validated in
// code, so thinking is off unless a caller asks for it with opts.thinkingTokens.
// With thinking off (above), a 1-turn cap made the essay prompt fail every time with error_max_turns —
// the model spends a first turn before answering — so from 17:44 to 18:50 on 2026-10-01 no essay was
// drafted and every form with a required essay escalated. Three turns is still a bounded single-shot
// (tailoring and the fact pass finish in one); measured on the essay prompt: 8s, same cost.
const DEFAULT_TURNS = 3;
// `--tools ''` is what actually gives a pure-text call. These calls used `--allowedTools ''`, which does
// not remove the tools — the model could still reach for one (and with thinking off it did, on the essay
// prompt: a tool turn, then "Done." instead of the JSON). No tools → it can only answer.
const childEnv = (opts = {}) => ({ ...process.env, MAX_THINKING_TOKENS: String(opts.thinkingTokens || 0) });

// USAGE-LIMIT FALLBACK (2026-10-15). assist_agent.js sends every page/expert call for non-Greenhouse/Lever/Ashby sites
// to the strongest model; when that model's usage limit was reached ("You've reached your Fable limit") every call
// failed in ~2 s — 300+ dead agent/expert rounds, and every iCIMS / Phenom / TikTok run ended ESCALATE with an empty
// diagnosis. A usage limit is not an answer about the page: retry the same prompt on the next model down instead.
const LIMIT_RE = /reached your .{0,40}limit|usage limit|rate[ _-]?limit|overloaded/i;
const FALLBACK = { 'claude-fable-5-1': 'opus', fable: 'opus', 'claude-opus-5-5': 'sonnet', opus: 'sonnet', 'claude-sonnet-5-5': 'haiku', sonnet: 'haiku' };
const nextModel = (model, msg) => (LIMIT_RE.test(String(msg || '')) ? FALLBACK[model] : null);

// One bounded single-shot call. opts.maxTurns raises the 1-turn cap (2026-09-30: company research on an
// UNFAMILIAR company reliably died with error_max_turns at 1 turn — the model wants a second pass).
// One bounded single-shot call. `prompt` is the full user message; everything the model needs must
// be in it (no file/tool access by design — keeps it cheap and deterministic). Retries ONCE on a
// transient spawn-level failure (timeout under load / crash) — never on a completed is_error result.
function call(prompt, opts = {}) {
  const model = opts.model || 'haiku';
  const timeout = opts.timeout || 240000; // resume generation can be slow; give real headroom
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-llm-')); // clean CWD => no project CLAUDE.md
    try {
      const r = spawnSync(CLAUDE, [
        '-p', '--model', model, '--max-turns', String(opts.maxTurns || DEFAULT_TURNS), '--output-format', 'json',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', // load ZERO MCP servers
        '--tools', '',                                        // no tools => pure text
        '--dangerously-skip-permissions',
      ], { input: prompt, cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env: childEnv(opts) });
      if (r.error) { lastErr = r.error; continue; }               // spawn-level (timeout/ENOBUFS) → retry
      let d;
      try { d = JSON.parse(r.stdout); } catch { lastErr = new Error('non-JSON CLI output: ' + (r.stdout || r.stderr || '').slice(0, 160)); continue; }
      if (d.is_error) {
        const next = nextModel(model, d.result);                 // usage limit → same prompt, next model down
        if (next) return call(prompt, { ...opts, model: next });
        throw new Error('LLM error: ' + (d.result || d.subtype || 'unknown')); // real error → don't retry
      }
      return { text: (d.result || '').trim(), cost: d.total_cost_usd || 0, usage: d.usage || {}, model };
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
    }
  }
  throw lastErr || new Error('llm call failed');
}

const haiku = (prompt, opts = {}) => call(prompt, { ...opts, model: opts.model || 'haiku' });

// ASYNC twin of call() (2026-09-30). Every CLI call costs ~20–35s of wall time (CLI start + model), and
// auto_apply.js made 3–5 of them strictly in sequence — the single largest share of a deterministic
// application's duration. callAsync lets independent calls (fit-gate ∥ page navigation; tailor ∥ essays
// ∥ attestation ∥ fact pass) run concurrently. Same flags, same retry policy, same return shape.
const { spawn } = require('child_process');
function callAsync(prompt, opts = {}) {
  const model = opts.model || 'haiku';
  const timeout = opts.timeout || 240000;
  const once = () => new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-llm-'));
    const p = spawn(CLAUDE, ['-p', '--model', model, '--max-turns', String(opts.maxTurns || DEFAULT_TURNS), '--output-format', 'json',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--dangerously-skip-permissions'], { cwd, env: childEnv(opts) });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { p.kill('SIGKILL'); } catch {} reject(Object.assign(new Error('timeout'), { transient: true })); } }, timeout);
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(Object.assign(e, { transient: true })); } });
    p.on('close', () => {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      if (done) return; done = true; clearTimeout(timer);
      let d; try { d = JSON.parse(out); } catch { return reject(Object.assign(new Error('non-JSON CLI output: ' + (out || err).slice(0, 160)), { transient: true })); }
      if (d.is_error) return reject(new Error('LLM error: ' + (d.result || d.subtype || 'unknown')));
      resolve({ text: (d.result || '').trim(), cost: d.total_cost_usd || 0, usage: d.usage || {}, model });
    });
    p.stdin.end(prompt);
  });
  return once().catch(e => (e.transient ? once() : Promise.reject(e))).catch(e => {
    const next = nextModel(model, e.message);
    return next ? callAsync(prompt, { ...opts, model: next }) : Promise.reject(e);
  });
}
const haikuAsync = (prompt, opts = {}) => callAsync(prompt, { ...opts, model: opts.model || 'haiku' });

// THE IMAGE GOES INLINE (2026-10-19): the old route asked the model to Read the file with a tool under a 2-turn cap and often
// ended `error_max_turns` with no answer — every vision caller (CAPTCHA grids, server _solve_vlm_grid) silently got nothing
// for two days. Now: one turn, no tools, the image as a base64 content block (stream-json). The tool route is only a fallback.
function inlineImage(prompt, opts) {
  const model = opts.model || 'sonnet';
  const ext = path.extname(opts.imagePath || '').toLowerCase();
  const media = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
  const msg = { type: 'user', message: { role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: media, data: fs.readFileSync(opts.imagePath).toString('base64') } },
    { type: 'text', text: prompt }] } };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-llm-'));
  try {
    const r = spawnSync(CLAUDE, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model,
      '--max-turns', '1', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', ''],
      { input: JSON.stringify(msg) + '\n', cwd, encoding: 'utf8', timeout: opts.timeout || 120000, maxBuffer: 16 * 1024 * 1024, env: childEnv(opts) });
    if (r.error) throw r.error;
    let d = null;
    for (const line of String(r.stdout || '').split('\n').reverse()) { if (!line.trim()) continue; try { const j = JSON.parse(line); if (j.type === 'result') { d = j; break; } } catch {} }
    if (!d) throw new Error('no result line: ' + String(r.stderr || '').slice(0, 160));
    if (d.is_error || d.subtype !== 'success') {
      const next = nextModel(model, d.result);
      if (next) return inlineImage(prompt, { ...opts, model: next });
      throw new Error('LLM error: ' + (d.result || d.subtype || 'unknown'));
    }
    return { text: (d.result || '').trim(), cost: d.total_cost_usd || 0, usage: d.usage || {}, model };
  } finally { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

function callWithImage(prompt, opts = {}) {
  if (opts.imagePath && fs.existsSync(opts.imagePath)) {
    try { return inlineImage(String(prompt).replace(/^Read the image at \S+\. Then answer the following:\n\n/, ''), opts); }
    catch (e) { if (!/LLM error/.test(e.message)) { /* fall through to the tool route below */ } else throw e; }
  }
  const model = opts.model || 'sonnet';
  const timeout = opts.timeout || 120000;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-llm-'));
  try {
    const r = spawnSync(CLAUDE, [
      '-p', '--model', model, '--max-turns', '2', '--output-format', 'json',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--dangerously-skip-permissions',
    ], { input: prompt, cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env: childEnv(opts) });
    if (r.error) throw r.error;
    let d;
    try { d = JSON.parse(r.stdout); } catch { throw new Error('non-JSON: ' + (r.stdout || r.stderr || '').slice(0, 160)); }
    if (d.is_error) {
      const next = nextModel(model, d.result);
      if (next) return callWithImage(prompt, { ...opts, model: next });
      throw new Error('LLM error: ' + (d.result || d.subtype || 'unknown'));
    }
    return { text: (d.result || '').trim(), cost: d.total_cost_usd || 0, usage: d.usage || {}, model };
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { call, haiku, callAsync, haikuAsync, callWithImage, claudeBin };

// CLI: echo "prompt" | node llm.js [model] [--image /path/to/image.png]
if (require.main === module) {
  const args = process.argv.slice(2);
  const imgIdx = args.indexOf('--image');
  const imagePath = imgIdx >= 0 ? args.splice(imgIdx, 2)[1] : null;
  const model = args[0] || 'haiku';
  let prompt = fs.readFileSync(0, 'utf8');
  if (imagePath) {
    prompt = `Read the image at ${imagePath}. Then answer the following:\n\n${prompt}`;
    const r = callWithImage(prompt, { model, imagePath });
    console.error(`[llm ${model} +image] cost=$${r.cost.toFixed(4)}`);
    process.stdout.write(r.text + '\n');
  } else {
    const r = call(prompt, { model });
    console.error(`[llm ${model}] cost=$${r.cost.toFixed(4)}`);
    process.stdout.write(r.text + '\n');
  }
}
