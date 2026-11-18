"""Employer limits on how many applications one person may send, and his decision on each.

Some employers state a cap ("you may apply to up to 10 positions in a 30-day period", "make only
one application to the programme") and quietly discard the rest; SpaceX threw out 23 of his
applications in one batch that way. A stated limit is recorded here per company as pending, and
nothing is sent to that company until he allows it (then the limit itself is enforced) or declines.

Limits are found in posting descriptions at every scan and on application pages by the workers
(application-agent src/application-caps.mjs holds the same patterns).
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..config import get_settings

NUMBER_WORDS = {'a single': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8,
                'nine': 9, 'ten': 10, 'twelve': 12, 'fifteen': 15, 'twenty': 20, 'thirty': 30, 'sixty': 60, 'ninety': 90}
NUM = r'(?:\d{1,3}|a single|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)'
UNIT = r'(?:applications?|positions?|roles?|jobs?|requisitions?|openings?|opportunities)'
PERIOD = r'(?:(?:\d{1,3}|thirty|sixty|ninety|twelve|six|one)[\s-]*(?:days?|weeks?|months?|years?)|calendar year|year|month)'
# The sentence must be about applying ("apply to up to", "applications per"), not duties
# ("you will manage up to 5 requisitions").
ABOUT_APPLICANT = r'(?:\bapply\b|\bapplying\b|\bapplications?\b|\bsubmit\b|\bsubmissions?\b)'
LIMIT = re.compile(
    rf'(?i)(?:\b(?:up to|no more than|maximum of|max(?:imum)?\.? of|a maximum of|limit(?:ed)? (?:of|to)|only)\s+(?P<max>{NUM})\s+(?:\w+\s+){{0,2}}?{UNIT}\b'
    rf'|\b(?P<max2>{NUM})\s+{UNIT}\s+(?:per|every|within|in (?:a|any|each))\s+(?:[a-z]+\s+){{0,2}}?(?P<period2>{PERIOD}))')
PERIOD_RE = re.compile(rf'(?i)\b(?:per|every|within|in (?:a|any|each|the same)|during (?:a|any))\s+(?:[a-z]+\s+){{0,2}}?(?P<period>{PERIOD})')
NOT_A_CAP = re.compile(r'(?i)\b(?:we are hiring|we have|openings available|positions available|travel|%|hours|team of|years of experience)\b')


def _number(text) -> Optional[int]:
    text = (text or '').strip().lower()
    return int(text) if text.isdigit() else NUMBER_WORDS.get(text)


def _days(period) -> Optional[int]:
    if not period:
        return None
    period = period.lower()
    if 'calendar year' in period:
        return 365
    m = re.match(r'(\d+|thirty|sixty|ninety|twelve|six|one)?[\s-]*(day|week|month|year)', period)
    if not m:
        return None
    n = _number(m.group(1)) if m.group(1) else 1
    return n * {'day': 1, 'week': 7, 'month': 30, 'year': 365}[m.group(2)]


def detect(text: str):
    """The first sentence stating a per-applicant application limit: {quote, max, days}, or None."""
    for sentence in re.split(r'(?<=[.!?])\s+|\n+', text or ''):
        if len(sentence) > 400 or not re.search(ABOUT_APPLICANT, sentence, re.I):
            continue
        m = LIMIT.search(sentence)
        if not m or NOT_A_CAP.search(sentence):
            continue
        stated = PERIOD_RE.search(sentence)
        period = m.group('period2') or (stated.group('period') if stated else None)
        return {'quote': sentence.strip()[:400], 'max': _number(m.group('max') or m.group('max2')), 'days': _days(period)}
    return None


def _path() -> Path:
    return get_settings().data_dir / 'application-caps.json'


def load() -> dict:
    try:
        return json.loads(_path().read_text())
    except (OSError, ValueError):
        return {}


def _save(caps: dict):
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(caps, indent=2))
    tmp.replace(path)


def key(company: str) -> str:
    return (company or '').strip().casefold()


def record(company, found, source, job_id=None, url=None):
    """Note a stated limit. A new company waits for his decision; a decided one keeps it."""
    caps = load()
    k = key(company)
    if not k or not found:
        return None
    entry = caps.get(k)
    if entry is None:
        entry = caps[k] = {'company': company, 'status': 'pending', 'detected_at': datetime.now(timezone.utc).isoformat()}
    if entry['status'] == 'pending' or not entry.get('quote'):
        entry.update(quote=found['quote'], max=found.get('max'), days=found.get('days'), source=source, job_id=job_id, url=url)
    _save(caps)
    return entry


def decide(company, allow: bool, max_count=None, days=None):
    caps = load()
    k = key(company)
    entry = caps.setdefault(k, {'company': company, 'detected_at': datetime.now(timezone.utc).isoformat(), 'source': 'added by you'})
    entry['status'] = 'approved' if allow else 'declined'
    entry['decided_at'] = datetime.now(timezone.utc).isoformat()
    if max_count is not None:
        entry['max'] = int(max_count)
    if days is not None:
        entry['days'] = int(days)
    _save(caps)
    return entry


def status(company) -> Optional[str]:
    return (load().get(key(company)) or {}).get('status')


def approved_limits() -> dict:
    """{company: {max, days}} for limits he allowed, for the worker to enforce."""
    return {e['company']: {'max': e['max'], 'days': e.get('days') or 36500}
            for e in load().values() if e.get('status') == 'approved' and e.get('max')}


def seed_from_policy(agent_dir=None):
    """Limits he set by hand in application-agent's profile count as already allowed."""
    path = Path(agent_dir or _agent_dir()) / 'private' / 'profile.json'
    try:
        policy = json.loads(path.read_text()).get('policy', {}).get('applicationCaps', {})
    except (OSError, ValueError):
        return
    caps = load()
    for company, cap in policy.items():
        if key(company) not in caps:
            caps[key(company)] = {'company': company, 'status': 'approved', 'max': cap.get('max'), 'days': cap.get('days'),
                                  'quote': f"Set by you: {cap.get('max')} applications per {cap.get('days')} days.",
                                  'source': 'application-agent profile', 'detected_at': datetime.now(timezone.utc).isoformat()}
    _save(caps)


def _agent_dir():
    from jobagent.config import AGENT_DIR
    return AGENT_DIR
