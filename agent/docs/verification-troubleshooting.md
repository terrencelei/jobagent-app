# Application verification: evidence and supported recovery

## What has actually been observed

- GrayMatter's Ashby form displayed “Your application submission was flagged as possible spam.”
  The approved fields and original resume passed local verification. No employer receipt was
  found. The error does not identify the risk signal, and no successful workaround is established.
- Shield AI's Lever form required selecting an actual location suggestion, the correct uploaded
  filename element, and conditional signature/date fields. Those issues were fixed and verified.
  The submission still ended at employer verification without a receipt. A later visible-browser
  attempt showed “There was an error verifying your application. Please try again.” Retrying
  Submit once after several minutes left the same error and hCaptcha challenge frames saying
  “Please try again.” The delay did not resolve this attempt; no verification was solved by
  the agent and no successful submission was established.
- Rocket Lab accepted its emailed security code, reached its confirmation page, and sent a receipt
  for the exact role. This is a verified success for that employer, not proof about other ATSs.

## Recovery order

1. Reconcile the existing attempt and mailbox before retrying. A missing receipt alone does not
   prove failure; preserve explicit errors, state and the exact reviewed package.
2. Fix ordinary form issues against the real page: incomplete required fields, an unselected
   autocomplete value, or a missing resume. Verify displayed values after uploads and rerenders.
3. For a verification-blocked attempt with the same approved fingerprint, use
   `tools/handoff-approved.mjs`. It preserves the prior state and opens installed Chrome with a
   separate persistent automation profile. The applicant submits and completes the human check.
   This session is not their everyday signed-in Chrome, and acceptance is not guaranteed.
4. If that manual check fails, the applicant can use the employer form directly in their normal
   current browser. The agent must not claim it can automatically control that default Chrome
   profile using the obsolete remote-debugging command. Do not change identity, rotate proxies,
   disguise automation, replay verification tokens, or automate solving a human challenge.
5. If the supported browser flow is still blocked, escalate through the published technical
   support route. Do not keep sending the same application. Contacting support requires the
   applicant's authorization; a draft can be prepared without sending it.

## Verified vendor guidance

- [Chrome's remote-debugging change](https://developer.chrome.com/blog/remote-debugging-port):
  starting with Chrome 136, remote-debugging flags are ignored for the default data directory.
  A non-default directory is required. The installed Chrome version in this session was 154.
- [hCaptcha FAQ](https://docs.hcaptcha.com/faq): major browsers are supported, with the latest
  two major versions officially supported. CAPTCHA completion remains a human step; a blocked
  automated attempt does not establish that the browser version is unsupported.
- [Ashby technical support guidance](https://www.ashbyhq.com/resources/report-abuse): technical
  problems submitting an application go to support@ashbyhq.com. Application status and hiring
  decisions belong with the employer. Do not use the abuse-reporting address for this problem.

## Recording results

Record the single changed variable, browser mode, exact error, form status, timestamps and receipt
outcome. A normal browser, a visible window, and a profile change are hypotheses, not documented
solutions until the application succeeds and the employer receipt is verified. Keep personal
information, screenshots, approval data and logs under ignored private/artifact directories.
