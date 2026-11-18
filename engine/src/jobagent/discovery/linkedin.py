"""LinkedIn postings, through LinkedIn's public (signed-out) job search.

LinkedIn serves the job-search result cards to visitors without an account from
`/jobs-guest/jobs/api/seeMoreJobPostings/search`, the same route the open-source JobSpy library
reads. A card names the company, title, location and posting date, but the posting itself sits
behind a login wall and LinkedIn no longer exposes the employer's apply link to visitors. So each
card is a lead: JobAgent looks the posting up on Indeed's app API (discovery/leads.py), which
carries the employer's own apply link, and failing that lets the web-search agent find the
employer's posting for a capped number per run. JobAgent never applies on LinkedIn.

LinkedIn throttles this route quickly: one query page at a time with a pause between requests, and
HTTP 403/429 pauses the channel for `linkedin.cooldown_hours`. Queries live in config/search.yaml
(`linkedin.queries`); limits and timing are dashboard settings.
"""
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from bs4 import BeautifulSoup

from ..config import LinkedInSearch, get_settings, load_search_config
from ..scrapers.base import BaseScraper
from ..settings import setting
from .email_alerts import INTERN
from .github import relevant_title
from .leads import Resolver, agent_find, close_reader, known_key, open_reader, unknown

logger = logging.getLogger('jobagent.discovery.linkedin')

SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search'
SOURCE_NAME = 'LinkedIn'
HEADERS = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
}
PAGE = 10                 # cards per `start` step
EMPTY_PAGE = '<!DOCTYPE html>\n\n<!---->'


class Refused(Exception):
    def __init__(self, status: int):
        super().__init__(f'HTTP {status}')
        self.status = status


def _state_path() -> Path:
    path = get_settings().data_dir / 'linkedin'
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
    return {'name': SOURCE_NAME, 'ats_type': 'linkedin', 'career_url': 'https://www.linkedin.com/jobs/',
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
    until = datetime.now(timezone.utc) + timedelta(hours=float(setting('linkedin.cooldown_hours')))
    state = load_state()
    state['cooldown_until'] = until.isoformat()
    save_state(state)
    return f'LinkedIn refused the public job search (HTTP {status}); LinkedIn search paused until {until:%Y-%m-%d %H:%M} UTC'


def due(now: Optional[datetime] = None, force: bool = False) -> Tuple[bool, str]:
    now = now or datetime.now(timezone.utc)
    if not setting('linkedin.enabled'):
        return False, 'LinkedIn search is off in Settings'
    state = load_state()
    paused = cooldown_until(state, now)
    if paused:
        return False, f'LinkedIn refused the public job search; paused until {paused:%Y-%m-%d %H:%M} UTC'
    if force:
        return True, ''
    last = state.get('last_scan_at')
    if last:
        try:
            if datetime.fromisoformat(last) + timedelta(minutes=float(setting('linkedin.scan_interval_minutes'))) > now:
                return False, 'not due yet'
        except ValueError:
            pass
    return True, ''


def status() -> dict:
    state = load_state()
    return {'last_scan_at': state.get('last_scan_at'), 'cooldown_until': state.get('cooldown_until'),
            'last_report': state.get('last_report'), 'unresolved': state.get('unresolved', [])[:20]}


def parse_cards(html: str) -> List[Dict[str, Any]]:
    """The leads on one result page. Raises ValueError when the page is not a result page."""
    soup = BeautifulSoup(html or '', 'html.parser')
    cards = soup.find_all(class_='base-search-card')
    if not cards:
        if (html or '').strip() and (html or '').strip() != EMPTY_PAGE:
            raise ValueError('LinkedIn answered with a page without job cards (blocked?)')
        return []
    leads = []
    for card in cards:
        job_id = str(card.get('data-entity-urn') or '').split(':')[-1]
        title = card.find('h3', class_='base-search-card__title')
        company = card.find('h4', class_='base-search-card__subtitle')
        location = card.find('span', class_='job-search-card__location')
        posted = card.find('time')
        if not (job_id.isdigit() and title and company):
            continue
        leads.append({'id': job_id, 'title': title.get_text(' ', strip=True), 'company': company.get_text(' ', strip=True),
                      'location': location.get_text(' ', strip=True) if location else '',
                      'posted': (posted.get('datetime') if posted else None) or None,
                      'url': f'https://www.linkedin.com/jobs/view/{job_id}'})
    return leads


class LinkedInScraper(BaseScraper):
    def __init__(self, config: Optional[LinkedInSearch] = None, resolver: Optional[Resolver] = None, **kwargs):
        if 'request_delay' not in kwargs:
            kwargs['request_delay'] = float(setting('linkedin.request_pause_seconds'))
        super().__init__(**kwargs)
        self.config = config
        self.resolver = resolver
        self.known: set = set()
        self.truncated = False
        self.warnings: List[str] = []
        self.report: Dict[str, Any] = {}
        self.client.headers.update(HEADERS)

    def prepare(self, session):
        from .email_alerts import known_postings
        self.known = known_postings(session)

    def search(self, keywords: str, start: int) -> List[Dict[str, Any]]:
        """One page of public search results as leads. Raises Refused on HTTP 403/429."""
        config = self.config or load_search_config().linkedin
        params = {'keywords': keywords, 'location': config.location, 'start': start,
                  'f_TPR': f"r{int(setting('linkedin.hours_old')) * 3600}"}
        self._wait_for_rate_limit('www.linkedin.com')
        response = self.client.get(SEARCH_URL, params=params)
        if response.status_code in (403, 429):
            raise Refused(response.status_code)
        if response.status_code == 400:
            return []
        response.raise_for_status()
        return parse_cards(response.text)

    def discover_jobs(self, target: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """Leads from every query, resolved to employer postings; unresolved ones are kept for the next run."""
        self.last_error, self.truncated, self.warnings = None, False, []
        self.config = self.config or load_search_config().linkedin
        wanted = int(setting('linkedin.results_per_query'))
        report: Dict[str, Any] = {'queries': 0, 'cards': 0, 'off_track': 0, 'known': 0, 'leads': 0,
                                  'by_indeed': 0, 'by_agent': 0, 'unresolved': 0}
        leads, seen = [], set()
        try:
            for keywords in self.config.queries:
                report['queries'] += 1
                start = 0
                while start < wanted:
                    cards = self.search(keywords, start)
                    for card in cards:
                        if card['id'] in seen:
                            continue
                        seen.add(card['id'])
                        report['cards'] += 1
                        if INTERN.search(card['title']) or not relevant_title(card['title']):
                            report['off_track'] += 1
                            continue
                        leads.append({**card, 'query': keywords})
                    if len(cards) < PAGE:
                        break
                    start += PAGE
                else:
                    self.truncated = True
        except Refused as exc:
            self.last_error = pause(exc.status)
        except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            self.last_error = f'LinkedIn search failed: {str(exc)[:200]}'
        state = load_state()
        # Leads from earlier runs that nobody could resolve get another try, oldest last.
        carried = [lead for lead in state.get('unresolved', []) if lead.get('company') and lead.get('title')]
        fresh = unknown(leads + carried, self.known)
        report['known'] = len(leads) - sum(1 for lead in leads if known_key(lead['company'], lead['title']) not in self.known)
        report['leads'] = len(fresh)
        records, unresolved = self.resolve(fresh, report)
        state['last_scan_at'] = datetime.now(timezone.utc).isoformat()
        state['unresolved'] = [{k: lead.get(k) for k in ('company', 'title', 'location', 'url', 'posted', 'query')} for lead in unresolved][:200]
        report['unresolved'] = len(state['unresolved'])
        state['last_report'] = {**report, 'error': self.last_error, 'warnings': self.warnings[:20]}
        save_state(state)
        self.report = report
        return records

    def resolve(self, leads: List[Dict[str, Any]], report: Dict[str, Any]):
        records, unresolved, searches = [], [], 0
        resolver = self.resolver or Resolver('linkedin')
        own = self.resolver is None
        reader = None
        try:
            for lead in leads:
                found = resolver.lookup(lead)
                if found:
                    report['by_indeed'] += 1
                elif searches < int(setting('linkedin.max_agent_searches_per_run')):
                    searches += 1
                    if reader is None:
                        reader = open_reader(self.warnings)
                    found = agent_find(lead, reader, self.warnings, 'LinkedIn') if reader else None
                    if found:
                        report['by_agent'] += 1
                if found:
                    found['raw_source_data'] = {**found['raw_source_data'], 'source': 'linkedin', 'linkedin_url': lead.get('url')}
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


def probe():
    """One public search page for the Sources panel; no request during a cooldown."""
    from .source_health import HealthResult
    paused = cooldown_until()
    if paused:
        return HealthResult('blocked', f'LinkedIn refused the public job search; paused until {paused:%Y-%m-%d %H:%M} UTC')
    config = load_search_config().linkedin
    scraper = LinkedInScraper(config, request_delay=0)
    try:
        cards = scraper.search(config.queries[0] if config.queries else 'mechanical engineer', 0)
    except Refused as exc:
        return HealthResult('blocked', f'LinkedIn refused the public job search (HTTP {exc.status})')
    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        return HealthResult('temporary_error', type(exc).__name__)
    except Exception as exc:
        return HealthResult('unreadable', str(exc)[:250])
    finally:
        scraper.close()
    if not cards:
        return HealthResult('empty', 'LinkedIn public search answered with no job cards')
    return HealthResult('working', 'LinkedIn public search answered with job cards', len(cards))
