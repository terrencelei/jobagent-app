# JobAgent application agent

Fills in employer application forms in a real browser (Playwright), from the student's profile
(`private/profile.json`, written by the engine's Setup) and their approved answers. The engine starts and
supervises the workers; questions only the student can answer wait on the dashboard's Approvals page.

```bash
npm ci && npx playwright install chromium
npm test
```

`private/` (profile, resumes, tokens) is created per user and never committed.
