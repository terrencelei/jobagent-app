# Free CAPTCHA handling

Alex asked (2026-10-15) for a free alternative to a paid solver, with the job posters'
permission to automate their CAPTCHAs. On 2026-10-24 he supplied a local solver (Playwright +
local models) that was ported into the tiers below. Later that day he asked for the package itself
to be committed and used in its entirety, as supplied and approved by its provider: it lives verbatim
in `vendor/captcha-solver/` (only a `package.json` marking it CommonJS was added beside it) and
`src/captcha-vendor.mjs` loads it. Its `captcha_solver.js` `solveIfPresent()` is now tier 0 (the
ESM port below runs only if the package fails to load or throws), its `captcha_detect.js` widens
`captchaPending`, and every application browser (`dashboard-worker.mjs`, `browser.mjs`,
`tools/workday-run.mjs`, the probe) launches through its `stealth.js` with `STEALTH_ARGS`.
`tools/setup-captcha-models.sh` links the package's `captcha_env`, `captcha_models` and
`../pipeline` (log `captcha_log.jsonl`, `captcha_debug/`, `domain_cooldown.json`) to
`private/captcha-env`, `private/models/captcha` and `state/captcha-vendor`. The pieces the package expected from its larger project were built
(2026-10-24, lesson 348):
- **Relay panel** (`src/captcha-relay.mjs`, `tools/captcha-relay.mjs`, 127.0.0.1:8787, started on
  demand, log `state/captcha-vendor/relay.log`): `POST /api/solve_captcha` for `audio` (whisper.cpp,
  local; never Google), `slider` (the model service's `/slide`) and `vlm_grid` (the signed-in CLI; a
  refusal returns the model's words so the package records a decline), and `POST /api/hidden_captcha`,
  which runs `hidden_captcha.js`. Browsers may call it only from CAPTCHA vendor frames (Google,
  recaptcha.net, hCaptcha, Cloudflare challenges) or extensions; `slider` is open to any page frame
  because solver_ext's ByteDance branch runs there. Private-network preflight is answered.
- **solver_ext everywhere**: Chrome runs extensions only in a persistent profile, so persistent
  launches load it as an extension and `launch()` contexts (the dashboard worker's) get its
  `solver.js` in every frame as an init script (it uses no `chrome.*` API). `CAPTCHA_EXTENSION=0`
  turns it off.
- **hCaptcha worker** (`extensions/relay-hidden/`): the background worker `hidden_captcha.js` was
  written for. `frame.js` reports each puzzle round from inside hCaptcha's frame; `background.js`
  attaches `chrome.debugger`, finds the frame's box, screenshots the viewport, asks
  `/api/hidden_captcha` and clicks or drags with `Input.dispatchMouseEvent`, then presses Verify. It
  stops for the tab on a decline, after 8 rounds, and pauses 5 s after his own click.
- **Hand-off Chrome** (`src/human-chrome.mjs`) starts with `--enable-unsafe-extension-debugging` and
  loads both extensions over DevTools (`Extensions.loadUnpacked`; branded Chrome ignores
  `--load-extension`). It opens only when he asks to finish a run himself.
- **Hidden relay Chrome** (his 2026-10-24 change to the headless rule; lesson 349): postings that
  challenge at Submit or showed a CAPTCHA before run in `launchRelayChrome` (`src/human-chrome.mjs`,
  profile `private/relay-chrome`), the package's "plain, non-automated Chrome", also under
  `headlessOnly`. It starts with `open -n -g -j` off-screen with occluded-window throttling off,
  opens each run's tab in the background (`Target.createTarget`), and is hidden through System Events
  by its browser PID; `keepHidden` re-hides it every 1.5 s while a run uses it (macOS shows an app
  again when it opens a tab). The worker fills over DevTools, then `resolveChallengeFree({relay:true})`
  runs the package solver, waits up to 90 s for the extensions (`waitForExtensionSolver`), and never
  offers a hand-off. The run's tab is closed afterwards. `CAPTCHA_RELAY_CHROME=0` turns it off.
- **stealth.js everywhere**: every launch in `src/` and `tools/` goes through `applicationChromium()`.
- **`llm.js`** (the one edit to the package): `claudeBin()` now tries `CLAUDE_BIN` and
  `~/.local/bin/claude` before its author's VS Code path, so `vlmJson` (OCR, sliders, Arkose) works.

Gemini still runs only if a `GEMINI_API_KEY` is set. Three free tiers run before any paid solver
(`docs/captcha-solver.md`, used only when a 2Captcha key is saved). All of them stay headless.

0. **Local solver** (`src/captcha-local.mjs`). `identify()` (`src/captcha-identify.mjs`) names
   every bot check on the page through `page.frames()` (nested iframes, closed shadow roots) and
   tells a solvable challenge from a wall (Akamai, Kasada, Incapsula, DataDome block, 403: never
   solved, reported as a wall) and from score-only reCAPTCHA v3 (nothing to click). Then, in order:
   - **reCAPTCHA v2 / Enterprise**: checkbox click, the accessibility audio clips transcribed by
     whisper.cpp (tier 1 below, up to three clips), then the image grid. Tiles are read from the
     challenge's own DOM (`td.rc-imageselect-tile`), the grid is classified locally by
     `tools/captcha-service.py` (a YOLO tile classifier for the 13 reCAPTCHA classes plus COCO
     segmentation on 4x4 "select all squares" tasks) and only the uncertain tiles go to the vision
     tier. This works headless, where Google refuses audio.
   - **hCaptcha**: visible checkbox, or the invisible widget opened through `hcaptcha.execute()`
     when the form has no empty text boxes (or the site's own Submit already opened it once). Tile
     grids are numbered on a screenshot (Set-of-Mark), point tasks and drag puzzles get a 50 px
     coordinate grid; the vision tier answers. hCaptcha's `/checkcaptcha` verdict counts as a pass
     when the token went straight into the site's callback (Lever).
   - **Turnstile** (auto-pass wait, `turnstile.reset()/execute()`, checkbox click; never any script
     inside Cloudflare's frame), the **Cloudflare interstitial**, PerimeterX **press-and-hold**,
     **proof-of-work** widgets (Friendly Captcha, ALTCHA, mCaptcha), **text-image** CAPTCHAs (ddddocr
     x2 + vision, majority wins; an arithmetic question is never answered), **sliders** in any frame
     (DataDome, GeeTest, generic; slot found by the service's outline/shadow/edge vote), AWS WAF
     and Arkose rounds (vision, best effort).
   - A cookie-consent veil is closed first (`src/consent-dismiss.mjs`, least consent first), since
     it swallows tile clicks.
   The **vision tier** (`src/captcha-vision.mjs`) is one turn of the signed-in Claude CLI with the
   image inline, no tools, no MCP servers, from an empty directory (same plan login as the workers,
   no API key; `CAPTCHA_VISION_MODEL`, default `sonnet`, falls to `haiku` on a usage limit). A reply
   that declines to solve is recorded as a decline and ends the solve; the prompt is never reworded
   to get past it. Measured 2026-10-24 on the vendor demos: it answered reCAPTCHA tile rounds and
   declined hCaptcha rounds and some reCAPTCHA rounds, so hCaptcha still mostly ends in the hand-off
   or "Finish in my Chrome".
   Every encounter is appended to `state/captcha-log.jsonl` (vendors, solved, how, seconds, no
   personal data) and every miss leaves `state/captcha-debug/<day>/<id>/` (page screenshot, each
   round's grid with the answer, the frames' text), pruned after three days. `CAPTCHA_SHOTS=0`
   turns the evidence off, `CAPTCHA_LOG=0` the log, `CAPTCHA_LOCAL_MODELS=0` the model service,
   `CAPTCHA_VISION=0` the vision tier.
1. **reCAPTCHA audio, solved locally** (`src/captcha-audio.mjs`). The worker opens the
   accessibility audio challenge, downloads the clip through the browser session, transcribes it
   with whisper.cpp on this Mac and submits the words. Tier 0 runs it for every reCAPTCHA it sees;
   this tier only runs on its own when tier 0 did not reach the widget.
2. **Hand-off to Alex** (`src/captcha-handoff.mjs`). Only in a visible window he asked for:
   the browser comes to the front, a macOS notification plays, and the worker waits up to 10
   minutes for him to solve it. Unattended runs stay headless (2026-10-17) and report the reason.

A posting that shows a CAPTCHA is recorded in `state/captcha-postings.json`. When Alex wants to
solve one himself first, add `"manualFirst": true` to that posting's entry: a visible run skips
both solvers and goes straight to the hand-off. A solved CAPTCHA is not a receipt: acceptance
still requires the employer's confirmation page or email.

## Setup

```sh
brew install whisper-cpp ffmpeg
mkdir -p private/models
curl -L -o private/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
tools/setup-captcha-models.sh
```

The second script creates `private/captcha-env` (a venv on the machine's Python 3.12 that shares
its torch/ultralytics/cv2, plus ddddocr and faster-whisper) and downloads two open weights into
`private/models/captcha/`: `recaptcha_cls.pt` (DannyLuna/recaptcha-classification-57k, MIT, 57 MB)
and `yolo11m-seg.pt` (Ultralytics YOLO11, 45 MB). Everything stays in the gitignored `private/`.
`src/captcha-service.mjs` starts `tools/captcha-service.py` on 127.0.0.1:8796 the first time a
solver needs it (log: `state/captcha-service.log`); models load lazily on first call. Nothing
leaves this Mac except the audio download from Google's own challenge frame.

## Diagnosing

```sh
node tools/captcha-probe.mjs https://www.google.com/recaptcha/api2/demo
node tools/captcha-probe.mjs https://accounts.hcaptcha.com/demo --click 'input[type=submit]'
node tools/captcha-probe.mjs <posting url> --identify-only
```

The probe opens the page headless with the application user agent, prints what `identify()` saw
before and after, the solve result and its trace, and leaves the round-by-round evidence under
`state/captcha-debug/`. Google's demo page serves a low-trust headless browser round after round,
so a miss there is not proof that an employer's single checkbox will miss.

## Not ported from the supplied solver

Its `stealth.js` (system Chrome with corrected client hints, patchright) was left out: the
application browsers present only the user agent change `browser-identity.mjs` documents and
disguise nothing else. Its hidden relay Chrome, background extension and Gemini key path depend on
infrastructure and API keys this agent does not use.
