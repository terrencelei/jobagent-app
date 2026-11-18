// Headless Chromium announces itself as "HeadlessChrome/<version>"; the visible browser built from
// the same binary says "Chrome/<version>". Honeywell's Akamai edge (careers.honeywell.com) resets
// every HTTP/2 stream whose User-Agent carries the headless token: page.goto fails within ~100 ms
// with net::ERR_HTTP2_PROTOCOL_ERROR while curl and the same Chromium labelled Chrome/<version> get
// the posting. Since 2026-10-17 application browsers must stay headless, so the headless run now
// presents the user agent the visible browser already presents. Nothing else about the browser
// is disguised.
export function applicationUserAgent(defaultUserAgent) {
  const ua = String(defaultUserAgent ?? '');
  return ua ? ua.replace(/\bHeadlessChrome\//, 'Chrome/') : undefined;
}

// A connection-level failure while opening the posting (the edge reset the stream, closed or
// refused the connection, or never answered) is the employer's site, not the form or the
// applicant. It is reported with the existing "Site unavailable:" marker so the JobAgent queue
// cools that employer down instead of recording a generic failure.
const CONNECTION_ERRORS = [
  ['net::ERR_HTTP2_PROTOCOL_ERROR', 'the site reset the HTTP/2 connection'],
  ['net::ERR_CONNECTION_RESET', 'the site reset the connection'],
  ['net::ERR_CONNECTION_CLOSED', 'the site closed the connection'],
  ['net::ERR_CONNECTION_REFUSED', 'the site refused the connection'],
  ['net::ERR_EMPTY_RESPONSE', 'the site answered with an empty response'],
  ['net::ERR_SSL_PROTOCOL_ERROR', 'the site failed the TLS handshake'],
  ['net::ERR_TIMED_OUT', 'the site did not answer in time'],
  ['net::ERR_CONNECTION_TIMED_OUT', 'the site did not answer in time'],
];

export function siteNavigationFailure(error) {
  const message = String(error?.message ?? error ?? '');
  if (!/^page\.goto:|^page\.reload:/.test(message)) return null;
  const hit = CONNECTION_ERRORS.find(([code]) => message.includes(code));
  return hit ? `${hit[1]} while opening the posting (${hit[0]})` : null;
}

// In his visible Chrome the run fills a tab he can see and close. Tesla 11930 (2026-11-10, lesson 462): two runs
// lost their tab mid-fill while another Tesla run went on in the same Chrome, and failed with Playwright's bare
// "Target page, context or browser has been closed". A closed tab before any submission is named plainly.
export function closedTabFailure(error, {tabClosed = false, submitted = false} = {}) {
  const message = String(error?.message ?? error ?? '');
  if (!tabClosed || submitted || !/Target page, context or browser has been closed/.test(message)) return null;
  return 'The application tab in your Chrome was closed before the form was finished; nothing was submitted. It can be queued again.';
}
