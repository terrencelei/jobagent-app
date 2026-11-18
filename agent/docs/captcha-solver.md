# Saved CAPTCHA method

The dashboard worker supports 2Captcha's token-based reCAPTCHA v2 API, including
invisible v2. Alex requested this method for Apex Space job 11041 and explicitly
authorized submission in its Help chat. It runs only after validation and submission
authorization, when the first Submit click reveals a visible challenge. It resumes
the pending submission through the widget's success callback and does not click
Submit again. A solver token is not an employer receipt.

Official resources:

- [reCAPTCHA v2 task format, invisible widgets, site keys and callback delivery](https://2captcha.com/api-docs/recaptcha-v2)
- [Creating a task](https://2captcha.com/api-docs/create-task)
- [Polling for a result](https://2captcha.com/api-docs/get-task-result)

Save configuration in the gitignored `private/captcha.json`:

```json
{
  "enabled": true,
  "provider": "2captcha",
  "allowedUrls": [
    "https://jobs.ashbyhq.com/apex-technology-inc/1f217a8b-1137-4d72-ae2d-27cd522ef964/application"
  ],
  "apiKey": ""
}
```

Set `apiKey` locally to a funded 2Captcha account's API key, or supply
`TWOCAPTCHA_API_KEY` in the worker's environment. Do not paste it into chat.
This is a solver service key, not an employer account password. The runner reads it
directly; it never enters model prompts or logs. Configuration is loaded on each
challenge, so a saved key is used automatically on subsequent queued runs.

Only listed posting paths are enabled. No applicant fields, resume, passwords or
cookies are sent to the provider; requests contain the service key, public posting
URL and widget metadata. One task is created, with a three-minute total deadline.
Missing keys, provider errors, unsupported widgets, changed widgets and remaining
visible challenges keep the role parked with its submission evidence intact.
Enterprise reCAPTCHA, hCaptcha and multiple or ambiguous widgets are unsupported.

A CAPTCHA parked after Submit must be reconciled by the queue before a new run.
Do not delete durable state or equate a fresh blank form with failed submission.
Follow the existing receipt and reviewed-verification reconciliation workflow.
