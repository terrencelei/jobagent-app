// Relay CAPTCHA Solver extension — runs in every frame alongside the Relay Assist extension.
// Detects standard CAPTCHA widgets and solves them via the local /api/solve_captcha endpoint.
// This runs as a BACKGROUND layer: the main Relay extension handles forms, this handles CAPTCHAs
// that appear on any page. No paid APIs, no external services — everything goes through localhost.
(() => {
  const API = 'http://127.0.0.1:8787/api/solve_captcha';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  let solving = false;
  // 2026-10-16: each vendor's logic runs ONLY inside that vendor's own frame. The extension is in every frame of every
  // page, and the old bare selectors ("#checkbox, .check") matched consent / EEO checkboxes on application forms and
  // clicked them every 3 seconds.
  const H = location.hostname;
  const IN_RECAPTCHA = /(^|\.)(google\.com|recaptcha\.net)$/.test(H) && /\/recaptcha\//.test(location.pathname);
  const IN_HCAPTCHA = /(^|\.)hcaptcha\.com$/.test(H);
  const IN_TURNSTILE = /(^|\.)challenges\.cloudflare\.com$/.test(H);

  async function trySolve() {
    if (solving) return;
    // Layer 1/2 mutex: when captcha_solver.js (Playwright) is actively solving,
    // the extension must stand down to avoid duplicate state transitions
    if (window.__captchaSolverActive) return;
    solving = true;
    try {
      // 1. reCAPTCHA v2 checkbox — click it, the stealth browser often passes
      const recapCheckbox = IN_RECAPTCHA && document.querySelector('#recaptcha-anchor, .recaptcha-checkbox');
      if (recapCheckbox && vis(recapCheckbox)) {
        const checked = recapCheckbox.getAttribute('aria-checked') === 'true';
        if (!checked) {
          recapCheckbox.click();
          await sleep(3000);
          // if the checkbox passed (no challenge appeared), we're done
          const resp = document.querySelector('[name="g-recaptcha-response"]');
          if (resp && resp.value && resp.value.length > 10) { solving = false; return; }
        }
      }

      // 2. reCAPTCHA audio challenge — switch to audio and transcribe
      const audioBtn = IN_RECAPTCHA && document.querySelector('#recaptcha-audio-button');
      if (audioBtn && vis(audioBtn)) {
        audioBtn.click();
        await sleep(2000);
        const downloadLink = document.querySelector('.rc-audiochallenge-tdownload-link');
        if (downloadLink) {
          const audioUrl = downloadLink.getAttribute('href');
          if (audioUrl) {
            try {
              const audioResp = await fetch(audioUrl);
              const blob = await audioResp.blob();
              const reader = new FileReader();
              const b64 = await new Promise((resolve) => {
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(blob);
              });
              const r = await fetch(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'audio', audio_b64: b64 })
              }).then((r) => r.json());
              if (r.ok && r.text) {
                const input = document.querySelector('#audio-response');
                if (input) {
                  input.value = r.text;
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  await sleep(300);
                  const verifyBtn = document.querySelector('#recaptcha-verify-button');
                  if (verifyBtn) verifyBtn.click();
                }
              }
            } catch (e) { /* audio solve failed, will retry */ }
          }
        }
      }

      // 3. hCaptcha checkbox
      const hcapCheckbox = IN_HCAPTCHA && document.querySelector('#checkbox');
      if (hcapCheckbox && vis(hcapCheckbox)) {
        const checked = hcapCheckbox.getAttribute('aria-checked') === 'true';
        if (!checked) {
          hcapCheckbox.click();
          await sleep(3000);
          const resp = document.querySelector('[name="h-captcha-response"]');
          if (resp && resp.value && resp.value.length > 10) { solving = false; return; }
        }
      }

      // 4. Cloudflare Turnstile — usually auto-passes with stealth; click the checkbox if stuck
      const tsCheckbox = IN_TURNSTILE && document.querySelector('input[type="checkbox"], .ctp-checkbox-container');
      if (tsCheckbox && vis(tsCheckbox)) {
        tsCheckbox.click();
        await sleep(3000);
      }

      // 5. ByteDance slider — delegate to local API
      const bgImg = document.querySelector('#captcha-verify-image, .captcha_verify_img--wrapper img, .vc-captcha-image img');
      const pieceImg = document.querySelector('.captcha_verify_img_slide, img[class*="slide"], .vc-captcha-piece img');
      if (bgImg && pieceImg && vis(bgImg)) {
        const toB64 = (img) => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          return c.toDataURL('image/png').split(',')[1];
        };
        try {
          const r = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'slider', bg: toB64(bgImg), piece: toB64(pieceImg) })
          }).then((r) => r.json());
          if (r.ok && r.x_offset != null) {
            const handle = document.querySelector('.secsdk-captcha-drag-icon, .captcha-slider-btn, [class*="slider-button"], [class*="drag-icon"]');
            if (handle) {
              const scale = bgImg.clientWidth / bgImg.naturalWidth;
              const box = handle.getBoundingClientRect();
              const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
              const dist = Math.round(r.x_offset * scale);
              const overshoot = 3 + Math.floor(Math.random() * 4);
              handle.dispatchEvent(new MouseEvent('mousedown', { clientX: sx, clientY: sy, bubbles: true }));
              const steps = 28 + Math.floor(Math.random() * 12);
              for (let i = 1; i <= steps; i++) {
                const t = i / steps, ease = 1 - Math.pow(1 - t, 3);
                await sleep(8 + Math.floor(Math.random() * 10));
                document.dispatchEvent(new MouseEvent('mousemove', { clientX: sx + (dist + overshoot) * ease, clientY: sy + Math.sin(t * Math.PI * 2) * 2.5, bubbles: true }));
              }
              await sleep(90 + Math.floor(Math.random() * 60));
              document.dispatchEvent(new MouseEvent('mousemove', { clientX: sx + dist, clientY: sy + 1, bubbles: true }));
              await sleep(120 + Math.floor(Math.random() * 80));
              document.dispatchEvent(new MouseEvent('mouseup', { clientX: sx + dist, clientY: sy, bubbles: true }));
            }
          }
        } catch (e) { /* slider solve failed */ }
      }
    } catch (e) {
      console.log('[RelaySolver] error:', e.message);
    } finally {
      solving = false;
    }
  }

  // poll every 3 seconds for CAPTCHAs
  const hasCaptcha = () => {
    const sels = [
      ...(IN_RECAPTCHA ? ['#recaptcha-anchor[aria-checked="false"]', '#recaptcha-audio-button'] : []),
      ...(IN_HCAPTCHA ? ['#checkbox:not([aria-checked="true"])'] : []),
      ...(IN_TURNSTILE ? ['input[type="checkbox"]', '.ctp-checkbox-container'] : []),
      '#captcha-verify-image',
      '.secsdk-captcha-drag-icon'
    ];
    for (const s of sels) { if (document.querySelector(s)) return true; }
    return false;
  };

  setInterval(() => { if (hasCaptcha()) trySolve(); }, 3000);
  // also try once on load
  setTimeout(() => { if (hasCaptcha()) trySolve(); }, 2000);
})();
