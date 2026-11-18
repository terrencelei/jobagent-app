# JobAgent desktop

The Electron shell that keeps the JobAgent engine (`../engine`, FastAPI) running quietly in the
background, shows its dashboard in a window, and lives in the menu bar (macOS) or system tray
(Windows).

## Run in development

```sh
cd engine && python -m venv .venv && .venv/bin/pip install -e .   # once; Windows: .venv\Scripts\pip
cd ../desktop
npm install
npm start        # first run downloads the Electron binary
npm test         # node --test: status.js, python.js, logfile.js
```

Environment overrides:

| Variable | Effect |
|----------|--------|
| `JOBAGENT_PYTHON` | Python used to run the engine (else `../engine/.venv`, else `python3`/`python` on PATH) |
| `JOBAGENT_ENGINE_DIR` | Engine directory (working directory of the engine process) |

## How it behaves

- **Single instance.** Opening it again focuses the existing window.
- **Engine.** If something on `127.0.0.1:8000` answers `GET /api/setup` with JSON containing
  `needed`, that engine is reused (and left running on quit). Otherwise the app picks the first free
  port from 8000, runs `python -m jobagent.cli serve` with `JOBAGENT_SERVER_PORT`, and waits for
  `/api/setup` with backoff (up to 90 s). A fresh install redirects `/` to `/setup` by itself.
- **Background.** Closing the window only hides it; the macOS dock icon hides with it. When opened
  at login (`--hidden` on Windows, `wasOpenedAtLogin` on macOS) it starts with no window.
- **Tray menu.** Status line (`Applying · 2 active · 14 submitted`), Open JobAgent, Start/Pause
  applying (`POST /api/applications/control`), Launch at login (on by default after first run;
  only registered in packaged builds), Show logs, Quit.
- **Quit.** Sends `{"action":"stop"}`, then ends the engine's process tree (process group
  SIGTERM, SIGKILL after 5 s; `taskkill /T /F` on Windows).
- **Notifications.** `GET /api/applications` every 60 s. A rise in `counts.completed` shows
  "Application submitted"; a rise in `counts.approvals` or `counts.help` shows "JobAgent needs
  you", which opens `/approvals` on click. The first poll is only a baseline. Logic: `status.js`.
- **Crashes.** Engine stdout/stderr go to `<userData>/logs/engine.log` (rotated at 5 MB, two old
  files kept). An unexpected exit restarts the engine with backoff (1, 2, 4, 8, 16 s; at most 5,
  budget resets after 5 minutes of uptime) and shows a notification.

`<userData>` is `~/Library/Application Support/JobAgent` on macOS and `%APPDATA%\JobAgent` on Windows.

## Files

| File | Role |
|------|------|
| `main.js` | Electron main process: lifecycle, window, tray, polling, restarts |
| `engine.js` | Health probe, free port, spawn, readiness wait, tree kill, API calls |
| `status.js` | Pure status-line and notification decisions |
| `python.js` | Pure Python interpreter resolver |
| `logfile.js` | Rotating log file |
| `scripts/make-icons.js` | Writes the placeholder icons in `assets/` (`npm run icons`) using only Node built-ins |

## Packaging (planned)

`npm run dist` runs electron-builder (macOS universal dmg, Windows nsis). The shell already
looks for the engine at `process.resourcesPath/engine` when packaged. What packaging will add:

1. **Python runtime.** A relocatable CPython from
   [python-build-standalone](https://github.com/astral-sh/python-build-standalone) per target
   (macOS arm64 + x86_64, so the universal build carries both or picks at runtime; Windows x64),
   shipped through electron-builder `extraResources` to `resources/engine`.
2. **Prebuilt venv.** `pip install` of the engine and its locked dependencies into that runtime at
   build time (per platform, in CI), so first launch needs no compiler or network for Python.
   `python.js` then resolves `resources/engine/.venv/...` (or point `JOBAGENT_PYTHON` at the
   bundled interpreter directly).
3. **Playwright browsers on first run.** Chromium is too large to ship in the installer; the
   engine/agent runs `python -m playwright install chromium` on first run with
   `PLAYWRIGHT_BROWSERS_PATH` under `<userData>`, with progress shown on the setup page.

Still missing:

- Bundling steps above (download scripts, `extraResources`, per-arch handling for the universal dmg).
- Code signing and notarization (Apple Developer ID, Windows Authenticode); unsigned builds trip
  Gatekeeper/SmartScreen.
- Auto-update (electron-updater + a release feed) and the subscription/account sign-in from `backend/`.
- Real icons (the current ones are placeholders) and a `.ico`/`.icns` check at multiple sizes.
- Engine data location: packaged builds should point the engine's data/config dirs at `<userData>`
  rather than inside the read-only app bundle.
- Windows has not been run yet; the tray, `taskkill` path and login item need a test on a real machine.
