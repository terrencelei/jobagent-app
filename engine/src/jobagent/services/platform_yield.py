"""How often each hiring platform ends in an automatic submission, from the runner's own run history.

Autoplay spends model time on every run; some platforms (Oracle Cloud, Lever, iCIMS) rarely end in a
submission and take many runs per posting. Each run folder holds request.json (the posting and how it
was launched) and state.json (how it ended); a posting counts once per platform, as submitted when any
of its runs in the window submitted without his hand-finish.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

# (platform, host markers) in match order; the label is what the dashboard shows.
HOSTS = (
    ('workday', ('myworkdayjobs.com', 'myworkdaysite.com', 'workday.com')),
    ('greenhouse', ('greenhouse.io',)),
    ('ashby', ('ashbyhq.com',)),
    ('lever', ('lever.co',)),
    ('oraclecloud', ('oraclecloud.com',)),
    ('icims', ('icims.com',)),
    ('smartrecruiters', ('smartrecruiters.com',)),
    ('amazon', ('amazon.jobs',)),
    ('successfactors', ('successfactors.com', 'successfactors.eu', 'sapsf.com', 'jobs2web.com')),
    ('phenom', ('phenompeople.com',)),
)
LABELS = {'workday': 'Workday', 'greenhouse': 'Greenhouse', 'ashby': 'Ashby', 'lever': 'Lever', 'oraclecloud': 'Oracle Cloud',
          'icims': 'iCIMS', 'smartrecruiters': 'SmartRecruiters', 'amazon': 'Amazon', 'successfactors': 'SuccessFactors',
          'phenom': 'Phenom', 'other': 'Other sites'}
# Phenom career sites live on the employer's domain with /<lang>/<region>/job/<id> paths (careers.gene.com/us/en/job/...).
PHENOM_PATH = re.compile(r'^/[a-z]{2}(?:-[a-z]{2})?/[a-z]{2}(?:-[a-z]{2})?/job/', re.I)
NEUTRAL = 0.5


def platform_of(url):
    parts = urlsplit(url or '')
    host = (parts.hostname or '').lower()
    for name, markers in HOSTS:
        if any(host == m or host.endswith('.' + m) for m in markers):
            return name
    if PHENOM_PATH.match(parts.path or ''):
        return 'phenom'
    return 'other'


def _read(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def history(directory, days, now=None):
    """{platform: {'jobs': n, 'submitted': k, 'runs': r}} for postings with a run in the last `days` days."""
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    since_ts, since_iso = since.timestamp(), since.isoformat()
    jobs = {}
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return {}
    for entry in entries:
        if not entry.is_dir():
            continue
        state_path = os.path.join(entry.path, 'state.json')
        try:
            if os.stat(state_path).st_mtime < since_ts:
                continue  # a run last written before the window
        except OSError:
            continue
        state, request = _read(state_path), _read(os.path.join(entry.path, 'request.json'))
        if not isinstance(state, dict) or not isinstance(request, dict):
            continue
        job = request.get('job') or {}
        stamp = str(state.get('updated_at') or request.get('startedAt') or '')
        if not job.get('id') or (stamp and stamp.replace('Z', '+00:00') < since_iso):
            continue
        row = jobs.setdefault(job['id'], {'platform': platform_of(job.get('url')), 'runs': 0, 'submitted': False})
        row['runs'] += 1
        if state.get('submitted') and not request.get('humanFinish'):
            row['submitted'] = True
    out = {}
    for row in jobs.values():
        bucket = out.setdefault(row['platform'], {'jobs': 0, 'submitted': 0, 'runs': 0})
        bucket['jobs'] += 1
        bucket['submitted'] += row['submitted']
        bucket['runs'] += row['runs']
    return out


def summarize(counts, min_jobs, min_success, weight):
    """Per-platform rate, whether it is held out of autoplay, and its priority adjustment.

    Below `min_jobs` postings a platform is neutral: no adjustment and never held."""
    platforms = {}
    for name in [*LABELS]:
        row = counts.get(name, {'jobs': 0, 'submitted': 0, 'runs': 0})
        jobs = row['jobs']
        rate = row['submitted'] / jobs if jobs else None
        neutral = jobs < min_jobs or rate is None
        platforms[name] = {'platform': name, 'label': LABELS[name], 'jobs': jobs, 'submitted': row['submitted'],
                           'runs': row['runs'], 'runs_per_job': round(row['runs'] / jobs, 1) if jobs else None,
                           'rate': round(rate, 3) if rate is not None else None, 'neutral': neutral,
                           'held': (not neutral) and rate < min_success,
                           'adjustment': 0.0 if neutral else round(weight * (rate - NEUTRAL), 2)}
    return platforms
