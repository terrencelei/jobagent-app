// Live view of a headless page for the JobAgent dashboard. Chrome's screencast sends a frame
// whenever the page repaints; the newest one is written to FILE (atomically, at most ~10 per
// second), and the dashboard streams that file to the preview as it changes. A frame shows what
// the page shows, so password fields appear only as dots.
import {writeFile, rename} from 'node:fs/promises';

export async function startLiveView(context, page, file, {minInterval = 100} = {}) {
  let writing = false, pending = null, last = 0, cdp = null;
  const view = {lastFrameAt: 0, stop: async () => {}};
  const put = async buffer => {
    if (writing) { pending = buffer; return; }
    writing = true;
    try { await writeFile(file + '.live', buffer, {mode: 0o600}); await rename(file + '.live', file); view.lastFrameAt = Date.now(); }
    catch {}
    writing = false;
    if (pending) { const next = pending; pending = null; await put(next); }
  };
  view.put = put;
  try {
    cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', ({data, sessionId}) => {
      cdp.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
      const now = Date.now();
      if (now - last < minInterval) return;
      last = now;
      put(Buffer.from(data, 'base64'));
    });
    await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1000, everyNthFrame: 1});
    view.stop = async () => { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); };
  } catch {
    // No screencast (another browser, or the page closed): callers fall back to screenshots.
  }
  return view;
}
