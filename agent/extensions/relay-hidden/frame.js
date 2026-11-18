// Runs inside hCaptcha's frames. When a visible puzzle is open, it reports what the background worker
// needs (instruction, tile / canvas / submit boxes relative to this frame, the frame's size) once per
// round. It never clicks: the worker clicks with real input through chrome.debugger.
(() => {
  if (/frame=(checkbox|enclave)/.test(location.href)) return;
  let lastKey = '', userAt = 0, dispatching = false;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // his own clicks pause the worker for a few seconds (the window is his hand-off window)
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { if (!dispatching) userAt = Date.now(); }, true);
  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'dispatching') dispatching = !!m.on; });

  function snapshot() {
    const promptEl = document.querySelector('.prompt-text, .challenge-prompt, h2');
    const instruction = promptEl ? promptEl.innerText.trim() : '';
    if (!instruction || innerWidth < 250 || innerHeight < 250) return null;
    const tiles = [...document.querySelectorAll('.task-image, .task, .task-grid .image-wrapper')].filter(shown).map(rect).filter((r) => r.width >= 30);
    const cv = [...document.querySelectorAll('canvas')].filter(shown).map(rect).find((r) => r.width >= 100) || null;
    if (tiles.length < 4 && !cv) return null;
    const submitEl = [...document.querySelectorAll('.button-submit, button[type="submit"], .challenge-submit')].find(shown);
    const img = document.querySelector('.task-image .image, .task-image img, canvas');
    const sig = img ? (getComputedStyle(img).backgroundImage || img.src || '').slice(-60) : '';
    return { key: instruction + '|' + tiles.length + '|' + sig, instruction, tiles, canvas: cv, submit: submitEl ? rect(submitEl) : null, frame: { width: innerWidth, height: innerHeight } };
  }

  setInterval(() => {
    if (dispatching || Date.now() - userAt < 5000) return;
    const s = snapshot();
    if (!s || s.key === lastKey) return;
    lastKey = s.key;
    chrome.runtime.sendMessage({ type: 'hcaptcha-round', ...s }).catch(() => {});
  }, 2000);
})();
