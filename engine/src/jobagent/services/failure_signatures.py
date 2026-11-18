"""Failure classes, signatures and the repeated-failure breaker for application runs.

One broken behaviour (a hung relay tab, a changed Workday page) used to fail posting after
posting until the Needs help backlog stopped the workers, and each of those postings earned its
own repair agents. Here every technical failure gets a class and a normalized signature; when the
same signature fails several distinct postings within a short window, new launches on that site
are held and one repair covers the signature (idea after AutoApply's diagnose/anomaly harness).
"""
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

# (class, pattern) in priority order: the first match names the failure.
CLASSES = (
    ('model_limit', re.compile(r'usage limit|limit reached|quota|at their limits', re.I)),
    ('captcha', re.compile(r'captcha|verify you are human|are you a robot', re.I)),
    ('verification', re.compile(r'verification code|two-factor|\b2fa\b|one-time code|email verification', re.I)),
    ('site_blocked', re.compile(r'^Site unavailable:|Rate-limited|access denied|you have been blocked|too many requests|\b429\b', re.I)),
    ('login', re.compile(r'sign[- ]?in|log[- ]?in|saved password|credentials', re.I)),
    ('browser', re.compile(r'connectOverCDP|browserType\.launch|Target page, context or browser has been closed|DevTools', re.I)),
    ('worker_crash', re.compile(r'Worker exited|exited with code|Protocol error|ECONNRESET|socket hang up', re.I)),
    ('model_error', re.compile(r'CLI failed|could not answer this step|OpenCode failed|returned no action|did not answer within|Unexpected end of JSON', re.I)),
    ('timeout', re.compile(r'Timeout \d+ ?ms exceeded|timed out', re.I)),
    ('page_changed', re.compile(r'locator|not attached to the DOM|detached|could not be identified|Cannot identify|did not open|no .*controls|not on the page', re.I)),
    ('field_unanswered', re.compile(r'Required fields? still|did not retain|could not be verified|needs an approved', re.I)),
    ('step_limit', re.compile(r'step limit', re.I)),
)
# Classes that already have their own handling (plan-limit pause, CAPTCHA hand-off, employer
# cooldown, his sign-in) never open a breaker.
EXEMPT = {'model_limit', 'captcha', 'verification', 'site_blocked', 'login'}
# Infrastructure failures are not about one site: across two sites they hold every launch.
SYSTEM = {'browser', 'worker_crash', 'model_error'}


def failure_class(message):
    for name, pattern in CLASSES:
        if pattern.search(message or ''):
            return name
    return 'other'


def signature(message):
    """The failure with its per-posting details (URLs, quoted labels, numbers, ids) taken out."""
    text = str(message or '').strip().splitlines()[0] if message else ''
    text = re.sub(r'https?://\S+', '<url>', text)
    text = re.sub(r'["“”\'‘’`][^"“”\'‘’`]{0,120}["“”\'‘’`]', '<q>', text)
    text = re.sub(r'\b[0-9a-f]{8,}\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b', '<id>', text, flags=re.I)
    text = re.sub(r'\d+', '<n>', text)
    return re.sub(r'\s+', ' ', text).strip().lower()[:160]


def platform(url):
    """The site a run failed on: a hiring platform's own domain (myworkdayjobs.com, icims.com) or the employer's."""
    host = (urlsplit(url or '').hostname or '').lower()
    return '.'.join(host.split('.')[-2:]) if host else ''


def _when(stamp):
    try:
        at = datetime.fromisoformat(str(stamp).replace('Z', '+00:00'))
        return at if at.tzinfo else at.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def note_failure(ledger, *, job_id, message, url, at, window_minutes):
    """Record one failed run; returns (signature, class). Entries older than the window are dropped."""
    kind = failure_class(message)
    sig = signature(message)
    if kind in EXEMPT or not sig:
        return sig, kind
    entry = ledger.setdefault(sig, {'class': kind, 'failures': [], 'example': str(message)[:300]})
    entry['class'], entry['example'] = kind, str(message)[:300]
    horizon = _when(at) - timedelta(minutes=window_minutes)
    entry['failures'] = [f for f in entry['failures'] if (_when(f.get('at')) or horizon) > horizon and f.get('job_id') != job_id]
    entry['failures'].append({'job_id': job_id, 'platform': platform(url), 'at': at})
    return sig, kind


def tripped(entry, threshold):
    """The breaker scope when `threshold` distinct postings share this signature, else None."""
    failures = entry.get('failures', [])
    if len({f['job_id'] for f in failures}) < threshold:
        return None
    sites = {f['platform'] for f in failures if f.get('platform')}
    if entry.get('class') in SYSTEM and len(sites) > 1:
        return '*'
    # A site-specific failure trips only when it repeats on one site.
    counts = {}
    for f in failures:
        counts.setdefault(f.get('platform') or '', set()).add(f['job_id'])
    site, jobs = max(counts.items(), key=lambda kv: len(kv[1]))
    return (site or '*') if len(jobs) >= threshold else None


def holds(breakers, url):
    """The open breaker that holds a launch to this URL, if any."""
    site = platform(url)
    return next((b for b in breakers if b.get('scope') == '*' or (site and b.get('scope') == site)), None)


def expired(breaker, now, hold_hours):
    opened = _when(breaker.get('opened_at'))
    return opened is not None and now - opened >= timedelta(hours=hold_hours)
