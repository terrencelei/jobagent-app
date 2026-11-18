# JobAgent

**The job search that runs itself.** JobAgent is a desktop app for students of any major. It finds the
roles you want across job boards and employers' own career sites, ranks every posting against your
background, and fills in and submits applications in the background, with a resume and cover letter
tailored to each role. It asks you only when a question genuinely needs you, so you can keep studying,
working and living your life while it applies.

## How it fits together

| Directory  | What it is |
|------------|------------|
| [`engine/`](engine/)   | The local engine and dashboard (Python, FastAPI): discovery, eligibility and fit ranking, the application queue, and **Setup**, which turns a student's major, target roles, industries and places into their search. |
| [`agent/`](agent/)     | The application agent (Node, Playwright) that fills in employer application forms. |
| [`desktop/`](desktop/) | The desktop app (Electron, macOS and Windows): runs the engine quietly in the background with a tray icon, launch at login and notifications. |
| [`backend/`](backend/) | The hosted service: accounts, Stripe subscriptions, and the AI gateway the app's model calls go through, so students never need an AI key of their own. |

```
 desktop app ──starts──▶ engine (localhost) ──runs──▶ application agent (browser)
                              │                               │
                              └──── model calls (Claude) ─────┴──▶ backend /llm ──▶ Anthropic API
                                                                    (account token, subscription, usage)
```

Everything a student enters stays on their computer: profile and search in a per-user folder, and
secrets (account token, employer-site password, Gmail token) in the operating system's credential store.

## Run it locally

```bash
# engine + dashboard (a fresh install opens Setup)
cd engine && python3.12 -m venv .venv && .venv/bin/pip install -e ".[dev]"
JOBAGENT_HOME=~/JobAgentDev .venv/bin/jobagent serve

# application agent
cd agent && npm ci && npx playwright install chromium

# backend (accounts, billing, AI gateway) — see backend/README.md for the environment
cd backend && python3.12 -m venv .venv && .venv/bin/pip install -e ".[dev]" && .venv/bin/uvicorn app.main:app --port 8030

# desktop app
cd desktop && npm ci && npm start
```

Point the engine at a local backend with `JOBAGENT_BACKEND_URL=http://127.0.0.1:8030`.

## Tests

Each part has its own suite (`python -m pytest -q` in `engine/` and `backend/`, `npm test` in `agent/` and
`desktop/`); `.github/workflows/ci.yml` runs them all on every push.

## Status

Working: Setup for any major, the generated search, ranking with location and dream-company preferences,
the application agent, the backend's accounts, billing and AI gateway, and the desktop shell.
Next: bundling Python and the agent into signed installers, moving the agent's private folder into the
per-user data folder, employer packs for more industries, and a private beta.

Copyright © 2026 JobAgent. All rights reserved.
