"""Handshake postings, read with his own signed-in browser session.

Handshake has no public search: every page sits behind the school's single sign-on (often with a
phone second factor). So JobAgent keeps one browser profile (`data/handshake/profile`) that he signs
into once in a visible window (`jobagent handshake-login`); Handshake sessions last weeks, and
when one lapses the Sources panel says "Handshake needs a sign-in" instead of failing quietly.

With that session the channel reads Handshake's job search in a headless browser, a few requests
every `handshake.scan_interval_minutes`, keeping the postings that apply on the employer's own
site. Postings that apply only inside Handshake are leads, resolved through Indeed's app API or the
web-search agent (discovery/leads.py); JobAgent never applies on Handshake itself. A refusal or a
lapsed session pauses the channel rather than retrying around it. Nothing of his is stored except
the browser profile; logging out of it from the dashboard removes the profile.
"""
import json
import logging
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from ..config import HandshakeSearch, get_settings, load_search_config
from ..scrapers.base import BaseScraper
from ..settings import setting

logger = logging.getLogger('jobagent.discovery.handshake')

SOURCE_NAME = 'Handshake'
LOGIN_URL = 'https://app.joinhandshake.com/login'


def login_url() -> str:
    """The school's Handshake sign-in (handshake.school in config/search.yaml, e.g. "myschool"; set by Setup)."""
    try:
        school = (load_search_config().handshake.school or '').strip().lower()
    except Exception:  # an unreadable config must not stop a scan from reporting its sign-in state
        school = ''
    return f'https://{school}.joinhandshake.com/login' if school else LOGIN_URL
HOME_URL = 'https://app.joinhandshake.com/'
SEARCH_URL = 'https://app.joinhandshake.com/job-search/'
AUTH_PATHS = ('/login', '/auth/', '/sso', '/users/sign_in', '/saml')
USER_AGENT = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
              'Chrome/131.0.0.0 Safari/537.36')
GRAPHQL_URL = '/hs/graphql'
BOT_CHECK = ('security verification', 'verifies you are not a bot', 'Just a moment')
PAGE = 25
SEARCH_QUERY = '''query JobSearchQuery($first: Int, $after: String, $input: JobSearchInput) {
  jobSearch(first: $first, after: $after, input: $input) { totalCount
    pageInfo { hasNextPage endCursor }
    edges { node { id job { id title createdAt expirationDate applyStart remote onSite hybrid description
      jobType { behaviorIdentifier name } employmentType { behaviorIdentifier name }
      locations { name city state country } employer { id name }
      salaryRange { min max currency paySchedule { behaviorIdentifier } }
      jobApplySetting { applyType externalApplyType externalUrl alternativeExternalUrl } atsIntegrated atsProvider } } } } }'''
FETCH_JS = '''async ([body, token]) => { const r = await fetch('/hs/graphql', {method: 'POST', credentials: 'include',
  headers: {'content-type': 'application/json', 'accept': '*/*', 'apollographql-client-name': 'consumer', 'x-csrf-token': token},
  body}); return [r.status, await r.text()]; }'''


def _data_dir() -> Path:
    path = get_settings().data_dir / 'handshake'
    path.mkdir(parents=True, exist_ok=True)
    return path


def _state_path() -> Path:
    return _data_dir() / 'state.json'


def profile_dir() -> Path:
    return _data_dir() / 'profile'


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
    return {'name': SOURCE_NAME, 'ats_type': 'handshake', 'career_url': 'https://app.joinhandshake.com/job-search/',
            'board_token': None, 'company_slug': None}


def signed_in_url(url: str) -> bool:
    """A Handshake app page, not a sign-in, SSO or Duo page."""
    parsed = urlparse(url or '')
    host = (parsed.hostname or '').lower()
    if not (host == 'joinhandshake.com' or host.endswith('.joinhandshake.com')):
        return False
    return not any(marker in parsed.path for marker in AUTH_PATHS)


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


def pause(reason: str) -> str:
    until = datetime.now(timezone.utc) + timedelta(hours=float(setting('handshake.cooldown_hours')))
    state = load_state()
    state['cooldown_until'] = until.isoformat()
    save_state(state)
    return f'Handshake {reason}; Handshake search paused until {until:%Y-%m-%d %H:%M} UTC'


def session_status() -> Tuple[bool, str]:
    """Whether the saved browser profile is signed in, as recorded by the last login or scan."""
    state = load_state()
    if not profile_dir().exists():
        return False, 'Handshake needs a sign-in: run `jobagent handshake-login` and sign in with your school account.'
    if state.get('signed_out_at'):
        return False, ('Handshake session lapsed; sign in again with `jobagent handshake-login`.')
    return True, f"signed in since {state.get('signed_in_at', 'an earlier login')}"


def due(now: Optional[datetime] = None, force: bool = False) -> Tuple[bool, str]:
    now = now or datetime.now(timezone.utc)
    if not setting('handshake.enabled'):
        return False, 'Handshake search is off in Settings'
    ok, detail = session_status()
    if not ok:
        return False, detail
    state = load_state()
    paused = cooldown_until(state, now)
    if paused:
        return False, f'Handshake paused until {paused:%Y-%m-%d %H:%M} UTC'
    if force:
        return True, ''
    last = state.get('last_scan_at')
    if last:
        try:
            if datetime.fromisoformat(last) + timedelta(minutes=float(setting('handshake.scan_interval_minutes'))) > now:
                return False, 'not due yet'
        except ValueError:
            pass
    return True, ''


def status() -> dict:
    state = load_state()
    ok, detail = session_status()
    return {'signed_in': ok, 'session': detail, 'last_scan_at': state.get('last_scan_at'),
            'cooldown_until': state.get('cooldown_until'), 'last_report': state.get('last_report'),
            'unresolved': state.get('unresolved', [])[:20]}


def mark_signed_in():
    state = load_state()
    state['signed_in_at'] = datetime.now(timezone.utc).isoformat()
    state.pop('signed_out_at', None)
    state.pop('cooldown_until', None)
    save_state(state)


def mark_signed_out(reason: str = 'session lapsed'):
    state = load_state()
    state['signed_out_at'] = datetime.now(timezone.utc).isoformat()
    state['signed_out_reason'] = reason
    save_state(state)


def logout():
    """Forget the browser profile (his session) entirely."""
    shutil.rmtree(profile_dir(), ignore_errors=True)
    state = load_state()
    for key in ('signed_in_at', 'signed_out_at', 'signed_out_reason'):
        state.pop(key, None)
    save_state(state)


class Browser:
    """His Handshake browser profile, headless for scans and visible for the sign-in."""

    def __init__(self, headless: bool = True):
        self.headless = headless

    def __enter__(self):
        from playwright.sync_api import sync_playwright
        self._p = sync_playwright().start()
        # Headless Chromium announces itself as "HeadlessChrome" and Handshake's bot check refuses it;
        # the full browser in new-headless mode with a normal user agent passes, as the visible one does.
        options = dict(headless=True, channel='chromium', user_agent=USER_AGENT) if self.headless else dict(headless=False)
        self.context = self._p.chromium.launch_persistent_context(
            str(profile_dir()), viewport={'width': 1280, 'height': 900},
            args=['--disable-blink-features=AutomationControlled'], **options)
        return self

    def __exit__(self, *exc):
        try:
            self.context.close()
        finally:
            self._p.stop()


def login(timeout_minutes: Optional[float] = None, browser_factory=Browser, log=print) -> Tuple[bool, str]:
    """Open a visible window on Handshake's sign-in; return once he has signed in (or time runs out)."""
    timeout = float(timeout_minutes or setting('handshake.login_timeout_minutes'))
    deadline = time.time() + timeout * 60
    with browser_factory(headless=False) as browser:
        page = browser.context.pages[0] if browser.context.pages else browser.context.new_page()
        start = login_url()
        page.goto(start, wait_until='domcontentloaded', timeout=60000)
        log(f'Sign in to Handshake in the window that opened (your school account). Waiting up to {timeout:g} minutes.')
        landed = None
        while time.time() < deadline:
            page.wait_for_timeout(2000)
            url = page.url
            if signed_in_url(url) and url.rstrip('/') != start.rstrip('/'):
                try:
                    if page.locator('a[href*="/auth/saml"], form[action*="login"]').count() == 0:
                        landed = url
                        break
                except Exception:
                    pass
        if landed:
            page.wait_for_timeout(3000)
            mark_signed_in()
            return True, f'Signed in to Handshake ({landed}). The session is kept in {profile_dir()}.'
    return False, f'No Handshake sign-in within {timeout:g} minutes; nothing was saved. Run `jobagent handshake-login` to try again.'


def check_session(browser_factory=Browser) -> Tuple[bool, str]:
    """Open Handshake headless with the saved profile; record whether the session still holds."""
    if not profile_dir().exists():
        return False, session_status()[1]
    with browser_factory(headless=True) as browser:
        page = browser.context.new_page()
        try:
            page.goto(HOME_URL, wait_until='domcontentloaded', timeout=60000)
            page.wait_for_timeout(3000)
            url = page.url
        finally:
            page.close()
    if signed_in_url(url):
        mark_signed_in()
        return True, f'Handshake session holds ({url})'
    mark_signed_out()
    return False, 'Handshake session lapsed; sign in again with `jobagent handshake-login`.'


def probe():
    """The Sources panel check: the saved session's state, without a browser."""
    from .source_health import HealthResult
    ok, detail = session_status()
    if not ok:
        return HealthResult('blocked', detail)
    paused = cooldown_until()
    if paused:
        return HealthResult('blocked', f'Handshake paused until {paused:%Y-%m-%d %H:%M} UTC')
    state = load_state()
    report = state.get('last_report') or {}
    return HealthResult('working', f'Handshake {detail}', int(report.get('kept', 0) or 0))


class Refused(Exception):
    """Handshake's bot check or a rate limit answered instead of the API."""
    def __init__(self, status: int):
        super().__init__(f'HTTP {status}')
        self.status = status


class SignedOut(Exception):
    """The saved session no longer signs him in."""


def parse_time(value) -> Optional[datetime]:
    try:
        when = datetime.fromisoformat(str(value))
        return when if when.tzinfo else when.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


class Session:
    """One signed-in headless page. The GraphQL calls run inside it, so Handshake's bot check sees
    its own browser; the page's CSRF token goes with each call."""

    def __init__(self, browser_factory=Browser):
        self.browser_factory = browser_factory
        self.url, self.token = '', ''

    def __enter__(self):
        self.browser = self.browser_factory(headless=True).__enter__()
        self.page = self.browser.context.new_page()
        self.page.goto(HOME_URL, wait_until='domcontentloaded', timeout=60000)
        self.page.wait_for_timeout(3000)
        self.url = self.page.url
        if signed_in_url(self.url):
            self.token = self.page.evaluate("() => (document.querySelector('meta[name=csrf-token]')||{}).content || ''") or ''
        return self

    def __exit__(self, *exc):
        try:
            self.page.close()
        finally:
            self.browser.__exit__(None, None, None)

    @property
    def signed_in(self) -> bool:
        return signed_in_url(self.url) and bool(self.token)

    def search(self, query: str, after: Optional[str], first: int) -> dict:
        """One page of Handshake's job search, newest first."""
        body = json.dumps({'operationName': 'JobSearchQuery', 'query': SEARCH_QUERY,
                           'variables': {'first': int(first), 'after': after,
                                         'input': {'filter': {'query': query}, 'sort': {'direction': 'DESC', 'field': 'POST_DATE'},
                                                   'channel': 'NL_SEARCH_CHANNEL'}}})
        status, text = self.page.evaluate(FETCH_JS, [body, self.token])
        if status == 401:
            raise SignedOut()
        if status in (403, 429) or any(marker in (text or '')[:3000] for marker in BOT_CHECK):
            raise Refused(int(status))
        if status != 200:
            raise ValueError(f'Handshake answered HTTP {status}')
        data = json.loads(text)
        if data.get('errors'):
            raise ValueError(f"Handshake search error: {str(data['errors'])[:200]}")
        search = (data.get('data') or {}).get('jobSearch')
        if not isinstance(search, dict):
            raise ValueError('Handshake answered without a job search')
        return search


class HandshakeScraper(BaseScraper):
    def __init__(self, config: Optional[HandshakeSearch] = None, resolver=None, session_factory=Session, **kwargs):
        if 'request_delay' not in kwargs:
            kwargs['request_delay'] = float(setting('handshake.request_pause_seconds'))
        super().__init__(**kwargs)
        self.config = config
        self.resolver = resolver
        self.session_factory = session_factory
        self.known: set = set()
        self.truncated = False
        self.warnings: List[str] = []
        self.report: Dict[str, Any] = {}

    def prepare(self, session):
        from .email_alerts import known_postings
        self.known = known_postings(session)

    def discover_jobs(self, target: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """Postings with an employer apply link as records; Handshake-only postings as leads, resolved
        through Indeed or the agent; what stays unresolved waits for the next run."""
        from .leads import unknown
        self.last_error, self.truncated, self.warnings = None, False, []
        self.config = self.config or load_search_config().handshake
        wanted = int(setting('handshake.results_per_query'))
        cutoff = datetime.now(timezone.utc) - timedelta(hours=int(setting('handshake.hours_old')))
        report: Dict[str, Any] = {'queries': 0, 'results': 0, 'off_track': 0, 'outside_us': 0, 'known': 0,
                                  'employer_link': 0, 'handshake_only': 0, 'leads': 0, 'by_indeed': 0, 'by_agent': 0, 'unresolved': 0}
        records, leads, seen = [], [], set()
        try:
            with self.session_factory() as session:
                if not session.signed_in:
                    raise SignedOut()
                for query in self.config.queries:
                    report['queries'] += 1
                    after, collected, more = None, 0, True
                    while more and collected < wanted:
                        self._wait_for_rate_limit(urlparse(login_url()).hostname)
                        page = session.search(query, after, min(PAGE, wanted - collected))
                        edges = page.get('edges') or []
                        for edge in edges:
                            job = (edge.get('node') or {}).get('job') or {}
                            collected += 1
                            posted = parse_time(job.get('createdAt'))
                            if posted and posted < cutoff:
                                more = False
                                break
                            if not job.get('id') or job['id'] in seen:
                                continue
                            seen.add(job['id'])
                            report['results'] += 1
                            record, lead, reason = self.parse(job, query)
                            report[reason] = report.get(reason, 0) + 1
                            if record:
                                records.append(record)
                            elif lead:
                                leads.append(lead)
                        info = page.get('pageInfo') or {}
                        if not edges or not info.get('hasNextPage'):
                            more = False
                        after = info.get('endCursor')
                        if more and collected >= wanted:
                            self.truncated = True
        except SignedOut:
            mark_signed_out()
            self.last_error = 'Handshake session lapsed; sign in again with `jobagent handshake-login`.'
        except Refused as exc:
            self.last_error = pause(f'refused a request (HTTP {exc.status})')
        except Exception as exc:
            self.last_error = f'Handshake search failed: {str(exc)[:200]}'
        state = load_state()
        carried = [lead for lead in state.get('unresolved', []) if lead.get('company') and lead.get('title')]
        fresh = unknown(leads + carried, self.known)
        report['leads'] = len(fresh)
        resolved, unresolved = self.resolve(fresh, report)
        records.extend(resolved)
        state['last_scan_at'] = datetime.now(timezone.utc).isoformat()
        state['unresolved'] = [{k: lead.get(k) for k in ('company', 'title', 'location', 'url', 'posted', 'query')} for lead in unresolved][:200]
        report['unresolved'] = len(state['unresolved'])
        state['last_report'] = {**report, 'error': self.last_error, 'warnings': self.warnings[:20]}
        save_state(state)
        self.report = report
        return records

    def parse(self, job: Dict[str, Any], query: str):
        """(record, lead, reason): a record when the posting applies on the employer's site, a lead when
        it applies only on Handshake, neither when it is off track, outside the U.S. or already stored."""
        from ..processing.eligibility import clean_html_text
        from ..processing.normalize import canonicalize_url, compute_description_hash, normalize_location, normalize_title
        from ..processing.us_locations import is_us_location
        from .email_alerts import INTERN, is_aggregator
        from .github import detect_ats, relevant_title
        from .leads import known_key
        title = (job.get('title') or '').strip()
        company = ((job.get('employer') or {}).get('name') or '').strip()
        job_type = ((job.get('jobType') or {}).get('behaviorIdentifier') or '').upper()
        employment = ((job.get('employmentType') or {}).get('behaviorIdentifier') or '').upper()
        if not title or not company or job_type != 'JOB' or employment != 'FULL_TIME' or INTERN.search(title) or not relevant_title(title):
            return None, None, 'off_track'
        first = (job.get('locations') or [{}])[0] or {}
        place = ', '.join(p for p in (first.get('city'), first.get('state')) if p) or (first.get('name') or '')
        country = (first.get('country') or '').strip()
        if country and country not in ('United States', 'United States of America', 'USA', 'US'):
            return None, None, 'outside_us'
        if not place and job.get('remote'):
            place = 'United States (Remote)'
        elif job.get('remote') and place:
            place += ' (Remote)'
        if not is_us_location(place):
            return None, None, 'outside_us'
        if known_key(company, title) in self.known:
            return None, None, 'known'
        handshake_url = f"{login_url().rsplit('/login', 1)[0]}/jobs/{job.get('id')}"
        apply = job.get('jobApplySetting') or {}
        url = (apply.get('externalUrl') or apply.get('alternativeExternalUrl') or '').strip()
        external = (apply.get('applyType') or '').upper() in ('EXTERNAL', 'HANDSHAKE_AND_EXTERNAL')
        if not (external and url.startswith(('https://', 'http://')) and not is_aggregator(url)):
            return None, {'company': company, 'title': title, 'location': place, 'url': handshake_url,
                          'posted': job.get('createdAt'), 'query': query}, 'handshake_only'
        description = clean_html_text(job.get('description') or '').strip()
        if not description:
            description = (f'Position: {title}\nCompany: {company}\nLocation: {place}\nSource: Handshake\n'
                           f'Employer requirements not fetched.\nOfficial application link: {url}')
        salary_raw, salary_min, salary_max = self.salary(job.get('salaryRange') or {}, description)
        return {
            'company_name': company, 'title': title, 'normalized_title': normalize_title(title),
            'location': place, 'normalized_location': normalize_location(place)[0],
            'department': None, 'employment_type': 'Full-time',
            'description': description, 'description_hash': compute_description_hash(description),
            'canonical_url': canonicalize_url(url), 'application_url': url, 'source_ats': detect_ats(url),
            'salary_raw': salary_raw, 'salary_min': salary_min, 'salary_max': salary_max,
            'posting_date': parse_time(job.get('createdAt')), 'external_req_id': None,
            'raw_source_data': {'source': 'handshake', 'handshake_id': job.get('id'), 'handshake_url': handshake_url,
                                'apply_type': apply.get('applyType'), 'ats_provider': job.get('atsProvider'),
                                'expires': job.get('expirationDate'), 'query': query, 'discovery_only': False},
        }, None, 'employer_link'

    @staticmethod
    def salary(salary_range: Dict[str, Any], description: str):
        """Handshake gives amounts in cents; only a yearly range is taken as the salary."""
        from ..processing.normalize import extract_salary
        schedule = ((salary_range.get('paySchedule') or {}).get('behaviorIdentifier') or '').upper()
        low, high = salary_range.get('min'), salary_range.get('max')
        amounts = [v / 100 for v in (low, high) if isinstance(v, (int, float)) and v > 0]
        if amounts and 'HOUR' not in schedule and max(amounts) >= 10000 and (salary_range.get('currency') or 'USD') == 'USD':
            low = low / 100 if low else None
            high = high / 100 if high else None
            return ' - '.join(f'${v:,.0f}' for v in (low, high) if v) + ' a year', low, high
        return extract_salary(description)

    def resolve(self, leads: List[Dict[str, Any]], report: Dict[str, Any]):
        from .leads import Resolver, agent_find, close_reader, open_reader
        records, unresolved, searches = [], [], 0
        resolver = self.resolver or Resolver('handshake')
        own = self.resolver is None
        reader = None
        try:
            for lead in leads:
                found = resolver.lookup(lead)
                if found:
                    report['by_indeed'] += 1
                elif searches < int(setting('handshake.max_agent_searches_per_run')):
                    searches += 1
                    if reader is None:
                        reader = open_reader(self.warnings)
                    found = agent_find(lead, reader, self.warnings, 'Handshake') if reader else None
                    if found:
                        report['by_agent'] += 1
                if found:
                    found['raw_source_data'] = {**found['raw_source_data'], 'source': 'handshake', 'handshake_url': lead.get('url')}
                    records.append(found)
                else:
                    unresolved.append(lead)
            if resolver.error:
                self.warnings.append(resolver.error)
        finally:
            if own:
                resolver.close()
            close_reader(reader)
        return records, unresolved

    def fetch_job(self, target, job_id):
        return None

    def check_status(self, job_url):
        return True, None
