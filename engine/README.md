# JobAgent engine

The local job-search engine and dashboard: discovery from job boards and employer career sites,
eligibility and fit ranking against the student's profile, the application queue, and the Setup page
that configures everything for a new student.

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
jobagent serve            # http://127.0.0.1:8000 — a fresh install opens /setup
python -m pytest -q
```

## Where things live

| Path | What |
|------|------|
| `config/defaults/` | Shipped defaults: ranking weights, a placeholder profile and search, employer packs by industry. |
| `$JOBAGENT_HOME/config/` | The student's own `profile.yaml`, `tracks.yaml`, `ranking.yaml`, `search.yaml`, written by Setup. |
| `$JOBAGENT_HOME/data/` | Database, settings, backups and logs. |
| OS credential store | Account token, employer-site password and Gmail refresh token (`src/jobagent/vault.py`, via `keyring`). |

`JOBAGENT_HOME` defaults to this folder; the desktop app sets it to a per-user folder.

## How Setup turns answers into a search

`src/jobagent/search_profile.py` builds, from the student's majors, target roles, industries, places and
dream companies: a search track (titles to fetch, degree fields, the fit reviewer's brief), one career
cluster per role for ranking, job-board queries per role, and the employer packs for their industries.
Graduation-year rules, file names and model prompts come from the profile (`src/jobagent/identity.py`).

## Environment

| Variable | Purpose |
|----------|---------|
| `JOBAGENT_HOME` / `JOBAGENT_CONFIG_DIR` / `JOBAGENT_DATA_DIR` | Where the student's files live. |
| `JOBAGENT_SERVER_PORT` | Port for `jobagent serve` (default 8000). |
| `JOBAGENT_BACKEND_URL` | The hosted JobAgent service (accounts, AI gateway). |
| `JOBAGENT_APPLICATION_AGENT_DIR` | The application agent (default `../agent`). |
| `JOBAGENT_GOOGLE_CLIENT_ID` / `_SECRET` | JobAgent's Google OAuth "Desktop app" client for the Gmail connection. |
| `JOBAGENT_VAULT=file` | Keep secrets in the data folder instead of the OS credential store (tests, headless machines). |
