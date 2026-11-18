// Employer sites answer an automated browser that moves too fast with a generic error page
// instead of the form: Workday's "Something went wrong. Please refresh the page and then try
// again." (Error Code: VPS|...), a 429, or an "unusual traffic" wall. Clicking on through it only
// adds to the traffic. A run refreshes once after a pause; if the page is still there it stops
// with a reason that starts with "Rate-limited", and the JobAgent queue sends the role to the back of
// the line and lets that employer's site cool down before trying again.
export const THROTTLED = 'Rate-limited';
import {setting} from './settings.mjs';
// The pause is his throttle.refresh_pause_seconds setting.
export const throttlePauseMs = () => setting('throttle.refresh_pause_seconds', 20) * 1000;

const PAGES = [
  [/something went wrong[\s\S]{0,200}refresh the page/i, 'Workday error page'],
  [/error code:\s*VPS\|/i, 'Workday error page'],
  [/^\s*(?:\d+\.\s*)?Error\s*-\s*Page Error\s*$/im, 'Workday page error banner'],
  // Workday's edge error page (Boeing 15934 sign-in): "An error occurred. Please contact Workday
  // Support if the problem persists. Support ID: ... Client IP: ...". Not a missing account.
  [/^\s*An error occurred\.\s*Please contact Workday Support if the problem persists\.[\s\S]{0,80}Support ID:/i, 'Workday error page'],
  [/too many requests|\b429\b[\s\S]{0,40}(error|too many)/i, 'too many requests'],
  [/unusual (traffic|activity) from (your|this)/i, 'unusual traffic warning'],
  // Cloudflare's WAF answers a navigation with "Sorry, you have been blocked / You are unable to access
  // <host>" (safran-group.com, Safran 13178): the employer's edge refusing this browser, not a form.
  [/sorry, you have been blocked|attention required!\s*\|\s*cloudflare|cloudflare ray id/i, 'Cloudflare block page'],
  // Vercel's bot checkpoint answered Blue Origin's Workday sign-in (12799) with "Failed to verify your
  // browser / Code 21 / Vercel Security Checkpoint": an edge refusal, not a missing account.
  [/vercel security checkpoint|failed to verify your browser/i, 'Vercel security checkpoint'],
  [/you have been (temporarily )?(rate[- ]limited|blocked)|request (was|has been) (throttled|rate[- ]limited)/i, 'rate limit page'],
];

// Returns a short description of the throttling page, or null for a normal page.
export function siteThrottled(text) {
  const hit = PAGES.find(([pattern]) => pattern.test(String(text ?? '')));
  if (!hit) return null;
  const code = String(text).match(/error code:\s*(\S+)/i)?.[1];
  return code ? `${hit[1]} (${code})` : hit[1];
}

export const throttledReason = what => `${THROTTLED}: the employer's site showed a ${what} after a refresh. Cooling down before another try.`;

// A 403 is an access refusal, not proof of a provider/model rate limit.
export function siteAccessFailure(text, status) {
  const body = String(text ?? '').trim();
  if (status === 403 || /^(?:403\s*(?:Forbidden)?|Forbidden|Access Denied)(?:\s|$)/i.test(body)) return 'access denied (HTTP 403)';
  if (status >= 500) return `server error (HTTP ${status})`;
  return null;
}
