# CAPTCHA solver (free, local)

Node (Playwright) + a local Python model service. No paid solving services.

| File | What it does |
|---|---|
| captcha_solver.js | Main solver: identify() names each challenge in every frame; solveIfPresent() solves reCAPTCHA v2 (checkbox, audio, image grid), hCaptcha, Turnstile, Cloudflare interstitial, PerimeterX hold, sliders, text/OCR, proof-of-work widgets |
| captcha_service.py | Local model server (port 8796): YOLO classifier/segmentation for reCAPTCHA grids, faster-whisper for audio, OpenCV slider matching, ddddocr text reading |
| captcha_detect.js | Lightweight detection / token checks used by the form drivers |
| stealth.js | Launches real Chrome with corrected UA / client hints (prevention layer) |
| hidden_captcha.js | Vision answers for hCaptcha puzzles in a non-automated Chrome |
| solver_ext/ | Chrome extension that solves standard CAPTCHAs in the background |
| consent.js, domain_guard.js, llm.js | Helpers captcha_solver.js requires (cookie banners, bot-wall detection, vision model calls) |
| tests/ | Offline replica coverage test, live vendor-demo benchmark, stealth probe |
| requirements.txt | Python packages for captcha_service.py |

Model weights are not included (recaptcha_cls.pt is the DannyLuna reCAPTCHA classifier, yolo11m-seg.pt is Ultralytics YOLO11, plus a faster-whisper model).
Some requires point at modules from the larger project (e.g. the control-panel endpoint the extension posts to) and llm.js uses a local Claude CLI path, so this is for reading rather than drop-in running.
