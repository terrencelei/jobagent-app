import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startLiveView} from '../src/live-view.mjs';

test('live view streams repaints of a headless page into the frame file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-view-'));
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<p id="n">0</p><script>let i=0;setInterval(()=>{document.getElementById("n").textContent=++i},50)</script>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext({viewport: {width: 800, height: 600}});
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const file = join(dir, 'screenshot.jpg');
    const view = await startLiveView(context, page, file);
    // Poll for progress instead of fixed sleeps, so a slow CI runner does not flake.
    const until = async (check, ms = 10000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) return false; await new Promise(r => setTimeout(r, 50)); } return true; };
    assert.ok(await until(async () => view.lastFrameAt > 0 && (await stat(file).catch(() => null))), 'a first frame is written');
    const first = view.lastFrameAt;
    assert.ok(await until(async () => view.lastFrameAt > first), 'new frames keep arriving while the page changes');
    assert.ok((await stat(file)).size > 0);
    await view.stop();
  } finally { await browser.close(); server.close(); await rm(dir, {recursive: true, force: true}); }
});
