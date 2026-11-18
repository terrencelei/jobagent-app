"""Indeed postings, read through the job-search API of Indeed's own iPhone app.

Indeed's web pages sit behind a Cloudflare check that no browser JobAgent drives gets past
(application-agent lesson 276), and Indeed's job-alert emails only link to those pages. The app's
GraphQL endpoint (apis.indeed.com) answers plain JSON without that check. Each request presents
the app's identity and API key, as the open-source JobSpy library does. Indeed does not offer this
endpoint to outside developers, so it may stop working at any time: a refusal (HTTP 403 or 429)
pauses the channel for `indeed.cooldown_hours` instead of retrying around it.

Only postings whose apply link is the employer's own page are kept; JobAgent never applies on
indeed.com. The channel runs inside the normal discovery scan, at most every
`indeed.scan_interval_minutes`, one query at a time with a pause between requests. Queries live
in config/search.yaml (`indeed.queries`); limits and timing are dashboard settings.
"""
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx

from ..config import IndeedSearch, get_settings, load_search_config
from ..processing.eligibility import clean_html_text
from ..processing.normalize import (canonicalize_url, compute_description_hash, extract_salary,
                                    normalize_location, normalize_title)
from ..scrapers.base import BaseScraper
from ..settings import setting
from .email_alerts import is_aggregator
from .github import detect_ats, relevant_title

logger = logging.getLogger('jobagent.discovery.indeed')

API_URL = 'https://apis.indeed.com/graphql'
SOURCE_NAME = 'Indeed'
# The app's identity, as published by JobSpy (github.com/speedyapply/JobSpy, jobspy/indeed/constant.py).
APP_HEADERS = {
    'content-type': 'application/json',
    'indeed-api-key': '161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8',
    'accept': 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': ('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 '
                   '(KHTML, like Gecko) Mobile/15E148 Indeed App 193.1'),
    'indeed-app-info': 'appv=193.1; appid=com.indeed.jobsearch; osv=16.6.1; os=ios; dtype=phone',
    'indeed-co': 'US',
    'indeed-locale': 'en-US',
}
PAGE_SIZE = 100
QUERY = '''query GetJobData {{
  jobSearch(what: {what}, location: {{where: {where}, radius: 50, radiusUnit: MILES}}, limit: {limit}, {cursor}sort: RELEVANCE,
            {filters}) {{
    pageInfo {{ nextCursor }}
    results {{ job {{ key title sourceEmployerName dateOnIndeed description {{ html }}
      location {{ countryCode admin1Code city }}
      compensation {{ currencyCode baseSalary {{ unitOfWork range {{ ... on Range {{ min max }} ... on AtLeast {{ min }} ... on AtMost {{ max }} ... on Exactly {{ value }} }} }} }}
      attributes {{ key label }} employer {{ name dossier {{ links {{ corporateWebsite }} }} }} recruit {{ viewJobUrl }} }} }} }} }}'''
# Indeed's job-type attribute keys (JobSpy's table).
EMPLOYMENT_TYPES = {'CF3CP': 'Full-time', '75GKK': 'Part-time', 'VDTG7': 'Internship', 'NJXCK': 'Contract',
                    'T9BXE': 'Contract', 'T65DZ': 'Contract', '4HKF7': 'Temporary', 'CJWTS': 'Temporary',
                    'TQKYQ': 'Per diem', 'UXQZ8': 'Volunteer'}
REMOTE_KEY = 'DSQF7'


class Refused(Exception):
    """Indeed answered HTTP 403 or 429: the channel pauses rather than retrying."""
    def __init__(self, status: int):
        super().__init__(f'HTTP {status}')
        self.status = status


def _state_path() -> Path:
    path = get_settings().data_dir / 'indeed'
    path.mkdir(parents=True, exist_ok=True)
    return path / 'state.json'


def load_state() -> dict:
    try:
        return json.loads(_state_path().read_text())
    except (OSError, ValueError):
        return {}


def save_state(state: dict):
    tmp = _state_path().with_suffix('.tmp')
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(_state_path())


def source_target() -> dict:
    """The catalog entry for the channel; the queries are read from config at scan time."""
    return {'name': SOURCE_NAME, 'ats_type': 'indeed', 'career_url': 'https://www.indeed.com/',
            'board_token': None, 'company_slug': None}


def cooldown_until(state: Optional[dict] = None, now: Optional[datetime] = None) -> Optional[datetime]:
    now = now or datetime.now(timezone.utc)
    until = (state if state is not None else load_state()).get('cooldown_until')
    if until:
        try:
            when = datetime.fromisoformat(until)
            if when > now:
                return when
        except ValueError:
            pass
    return None


def pause(status: int) -> str:
    """Record a refusal: no Indeed request for `indeed.cooldown_hours`. Returns the message."""
    until = datetime.now(timezone.utc) + timedelta(hours=float(setting('indeed.cooldown_hours')))
    state = load_state()
    state['cooldown_until'] = until.isoformat()
    save_state(state)
    return f'Indeed refused the app API (HTTP {status}); Indeed search paused until {until:%Y-%m-%d %H:%M} UTC'


def due(now: Optional[datetime] = None, force: bool = False) -> Tuple[bool, str]:
    """Whether the channel runs in this scan, and if not, why."""
    now = now or datetime.now(timezone.utc)
    if not setting('indeed.enabled'):
        return False, 'Indeed search is off in Settings'
    state = load_state()
    paused = cooldown_until(state, now)
    if paused:
        return False, f'Indeed refused the app API; paused until {paused:%Y-%m-%d %H:%M} UTC'
    if force:
        return True, ''
    last = state.get('last_scan_at')
    if last:
        try:
            if datetime.fromisoformat(last) + timedelta(minutes=float(setting('indeed.scan_interval_minutes'))) > now:
                return False, 'not due yet'
        except ValueError:
            pass
    return True, ''


def status() -> dict:
    state = load_state()
    return {'last_scan_at': state.get('last_scan_at'), 'cooldown_until': state.get('cooldown_until'),
            'last_report': state.get('last_report')}


class IndeedScraper(BaseScraper):
    def __init__(self, config: Optional[IndeedSearch] = None, **kwargs):
        if 'request_delay' not in kwargs:
            kwargs['request_delay'] = float(setting('indeed.request_pause_seconds'))
        super().__init__(**kwargs)
        self.config = config
        self.client.headers.update(APP_HEADERS)
        self.truncated = False
        self.warnings: List[str] = []
        self.report: Dict[str, Any] = {}

    def prepare(self, session):
        """Nothing to look up before a run (the LinkedIn channel reads the stored postings here)."""

    def search(self, what: str, cursor: Optional[str], limit: int, hours: Optional[int] = None) -> dict:
        """One page of the app's job search, limited to postings dated within `hours` when given.
        Raises Refused on HTTP 403/429."""
        config = self.config or load_search_config().indeed
        query = QUERY.format(what=json.dumps(what), where=json.dumps(config.location), limit=int(limit),
                             cursor=f'cursor: {json.dumps(cursor)}, ' if cursor else '',
                             filters=f'filters: [{{ date: {{ field: "dateOnIndeed", start: "{int(hours)}h" }} }}]' if hours else '')
        self._wait_for_rate_limit('apis.indeed.com')
        response = self.client.post(API_URL, json={'query': query})
        if response.status_code in (403, 429):
            raise Refused(response.status_code)
        response.raise_for_status()
        data = response.json()
        search = (data.get('data') or {}).get('jobSearch') if isinstance(data, dict) else None
        if not isinstance(search, dict):
            errors = data.get('errors') if isinstance(data, dict) else None
            raise ValueError(f'Indeed app API answered without a job search: {str(errors)[:200]}')
        return search

    def discover_jobs(self, target: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """Every configured query, kept to postings with an employer apply link that either track could want."""
        self.last_error, self.truncated, self.warnings = None, False, []
        self.config = self.config or load_search_config().indeed
        wanted = int(setting('indeed.results_per_query'))
        report: Dict[str, Any] = {'queries': 0, 'results': 0, 'kept': 0, 'indeed_only': 0, 'off_track': 0,
                                  'outside_us': 0, 'unnamed': 0, 'duplicates': 0}
        seen, jobs = set(), []
        try:
            for what in self.config.queries:
                report['queries'] += 1
                cursor, collected = None, 0
                while collected < wanted:
                    page = self.search(what, cursor, min(PAGE_SIZE, wanted - collected), int(setting('indeed.hours_old')))
                    results = [r.get('job') for r in page.get('results') or [] if isinstance(r, dict) and r.get('job')]
                    for raw in results:
                        collected += 1
                        report['results'] += 1
                        key = raw.get('key')
                        if not key or key in seen:
                            report['duplicates'] += 1
                            continue
                        seen.add(key)
                        record, reason = self.parse(raw, what)
                        if record:
                            jobs.append(record)
                        report[reason] = report.get(reason, 0) + 1
                    cursor = (page.get('pageInfo') or {}).get('nextCursor')
                    if not results or not cursor:
                        break
                else:
                    self.truncated = True
        except Refused as exc:
            self.last_error = pause(exc.status)
        except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            self.last_error = f'Indeed search failed: {str(exc)[:200]}'
        state = load_state()
        state['last_scan_at'] = datetime.now(timezone.utc).isoformat()
        state['last_report'] = {**report, 'error': self.last_error, 'warnings': self.warnings[:20]}
        save_state(state)
        self.report = report
        return jobs

    def parse(self, raw: Dict[str, Any], query: str) -> Tuple[Optional[Dict[str, Any]], str]:
        """A pipeline record for one Indeed result, or None and the reason it was left out."""
        key = raw.get('key')
        title = (raw.get('title') or '').strip()
        employer = raw.get('employer') or {}
        company = (employer.get('name') or raw.get('sourceEmployerName') or '').strip()
        apply_url = ((raw.get('recruit') or {}).get('viewJobUrl') or '').strip()
        host = (urlparse(apply_url).hostname or '').lower()
        if (not apply_url.startswith(('https://', 'http://')) or host == 'indeed.com' or host.endswith('.indeed.com')
                or is_aggregator(apply_url)):
            return None, 'indeed_only'
        if not title or not company:
            return None, 'unnamed'
        attributes = [a for a in raw.get('attributes') or [] if isinstance(a, dict)]
        keys = [a.get('key') for a in attributes if a.get('key')]
        employment = next((EMPLOYMENT_TYPES[k] for k in keys if k in EMPLOYMENT_TYPES), None)
        if employment == 'Internship' or not relevant_title(title):
            return None, 'off_track'
        location = raw.get('location') or {}
        if (location.get('countryCode') or '').upper() != 'US':
            return None, 'outside_us'
        place = ', '.join(p for p in (location.get('city'), location.get('admin1Code')) if p)
        if not location.get('city'):
            place = f'{place}, United States' if place else 'United States'
        if REMOTE_KEY in keys:
            place += ' (Remote)'
        apply_url = self.resolve(apply_url)
        description = clean_html_text((raw.get('description') or {}).get('html') or '').strip()
        if not description:
            description = (f'Position: {title}\nCompany: {company}\nLocation: {place}\nSource: Indeed\n'
                           f'Employer requirements not fetched.\nOfficial application link: {apply_url}')
        salary_raw, salary_min, salary_max = self.salary(raw.get('compensation') or {}, description)
        posted = raw.get('dateOnIndeed')
        posting_date = None
        if isinstance(posted, (int, float)) and posted > 0:
            try:
                posting_date = datetime.fromtimestamp(posted / 1000, tz=timezone.utc)
            except (ValueError, OverflowError, OSError):
                pass
        website = ((employer.get('dossier') or {}).get('links') or {}).get('corporateWebsite')
        return {
            'company_name': company, 'title': title, 'normalized_title': normalize_title(title),
            'location': place, 'normalized_location': normalize_location(place)[0],
            'department': None, 'employment_type': employment,
            'description': description, 'description_hash': compute_description_hash(description),
            'canonical_url': canonicalize_url(apply_url), 'application_url': apply_url,
            'source_ats': detect_ats(apply_url),
            'salary_raw': salary_raw, 'salary_min': salary_min, 'salary_max': salary_max,
            'posting_date': posting_date,
            # Indeed's key is not an employer requisition ID; the employer link drives deduplication.
            'external_req_id': None,
            'raw_source_data': {'source': 'indeed', 'indeed_key': key,
                                'indeed_url': f'https://www.indeed.com/viewjob?jk={key}', 'query': query,
                                'attributes': [a.get('label') for a in attributes if a.get('label')],
                                'employer_website': website, 'discovery_only': False},
        }, 'kept'

    def resolve(self, url: str) -> str:
        """Follow a known link shortener (grnh.se) to the employer page; keep the link on failure."""
        host = (urlparse(url).hostname or '').lower()
        hosts = [h.lower() for h in (self.config.resolve_redirect_hosts if self.config else [])]
        if host not in hosts:
            return url
        # A refused employer page is a per-link warning, never the channel's error.
        channel_error = self.last_error
        try:
            response = self.get_with_retry(url, max_retries=1)
            final = str(response.url)
            if (final.startswith('https://') and (urlparse(final).hostname or '').lower() not in hosts
                    and not is_aggregator(final)):
                return final
        except Exception:
            pass
        finally:
            self.last_error = channel_error
        self.warnings.append(f'Could not resolve {host} link {url}')
        return url

    @staticmethod
    def salary(compensation: Dict[str, Any], description: str):
        base = compensation.get('baseSalary') or {}
        bounds = base.get('range') or {}
        if base.get('unitOfWork') == 'YEAR' and (compensation.get('currencyCode') or 'USD') == 'USD':
            low = bounds.get('min', bounds.get('value'))
            high = bounds.get('max', bounds.get('value'))
            if low or high:
                text = ' - '.join(f'${v:,.0f}' for v in (low, high) if v) + ' a year'
                return text, low, high
        return extract_salary(description)

    def fetch_job(self, target, job_id):
        return None

    def check_status(self, job_url):
        # Leaving Indeed's results is never employer closure evidence.
        return True, None


def probe():
    """One small query for the Sources panel; no request while a refusal cooldown is running."""
    from .source_health import HealthResult
    paused = cooldown_until()
    if paused:
        return HealthResult('blocked', f'Indeed refused the app API; paused until {paused:%Y-%m-%d %H:%M} UTC')
    config = load_search_config().indeed
    scraper = IndeedScraper(config, request_delay=0)
    try:
        page = scraper.search(config.queries[0] if config.queries else 'mechanical engineer', None, 5, int(setting('indeed.hours_old')))
    except Refused as exc:
        return HealthResult('blocked', f'Indeed refused the app API (HTTP {exc.status})')
    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        return HealthResult('temporary_error', type(exc).__name__)
    except Exception as exc:
        return HealthResult('unreadable', str(exc)[:250])
    finally:
        scraper.close()
    results = page.get('results') or []
    if not results:
        return HealthResult('empty', 'Indeed app API answered with no results')
    return HealthResult('working', 'Indeed app API answered with job results', len(results))
