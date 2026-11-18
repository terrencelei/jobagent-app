"""Employer postings for leads that only name a company and a title.

LinkedIn's public search, Glassdoor and the job-alert emails (LinkedIn, Handshake, ZipRecruiter)
give a company, a title and a location but no link JobAgent can use: their pages sit behind a
login or a bot wall, and JobAgent never applies on a job board. Indeed's app API (discovery/indeed.py)
carries the employer's own apply link for most postings, so a lead is looked up there by its title
and company, cheaply and without a model. What Indeed cannot resolve stays a lead for the slower
web-search agent (email_alerts) or is reported as unresolved.
"""
import logging
import re
from typing import Dict, Iterable, List, Optional, Tuple

import httpx

from ..processing.normalize import normalize_title
from ..settings import setting
from .indeed import IndeedScraper, Refused, cooldown_until, pause

logger = logging.getLogger('jobagent.discovery.leads')

GENERIC = {'inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'the', 'group', 'technologies', 'technology',
           'industries', 'international', 'careers', 'us', 'usa', 'in', 'of', 'and', 'holdings', 'limited', 'plc'}
STOP = {'the', 'and', 'for', 'with', 'of', 'to', 'in', 'at', 'or'}


def words(text: str) -> List[str]:
    return [w for w in re.findall(r'[a-z0-9]+', (text or '').lower()) if len(w) > 1 and w not in STOP]


def core_title(title: str) -> str:
    """The role words of a title, without parentheses, requisition codes and trailing qualifiers."""
    text = re.sub(r'\(.*?\)|\[.*?\]', ' ', title or '')
    text = re.split(r'\s+[-–—|]\s+', text)[0]
    text = re.sub(r'\b[A-Z]{1,3}-?\d{4,}\b|\b\d{5,}\b', ' ', text)
    return ' '.join(text.split()).strip(' ,:;')


def company_key(company: str) -> Optional[str]:
    """The company's first distinctive word ("archer" of "Archer Aviation Inc")."""
    names = [w for w in re.findall(r'[a-z0-9]+', (company or '').lower()) if w not in GENERIC and len(w) > 1]
    return names[0] if names else None


def same_company(company: str, employer: str) -> bool:
    key = company_key(company)
    return bool(key) and key in (employer or '').lower().replace('-', ' ')


def title_matches(core: str, candidate: str) -> bool:
    wanted, got = set(words(core)), set(words(candidate))
    return bool(wanted) and len(wanted & got) >= max(1, (len(wanted) + 1) // 2)


def lookup(lead: Dict, scraper: IndeedScraper, source: str) -> Optional[Dict]:
    """The lead's posting on Indeed with an employer apply link, as a pipeline record, or None.
    Raises Refused when Indeed blocks the app API."""
    core = core_title(lead.get('title') or '')
    company = (lead.get('company') or '').strip()
    if not core or not company:
        return None
    # The exact title first; when Indeed has no such phrase, the title's words. No date window: the
    # posting may have reached Indeed long before the lead. The company and title checks below decide.
    candidates, what = [], ''
    for what in (f'"{core}" {company}', f'{core} {company}'):
        page = scraper.search(what, None, 10)
        for result in page.get('results') or []:
            raw = result.get('job') if isinstance(result, dict) else None
            if not raw:
                continue
            employer = (raw.get('employer') or {}).get('name') or raw.get('sourceEmployerName') or ''
            if not same_company(company, employer) or not title_matches(core, raw.get('title') or ''):
                continue
            candidates.append(raw)
        if candidates:
            break
    # The same title is often open at several sites; prefer the lead's own city.
    place = (lead.get('location') or '').lower()
    candidates.sort(key=lambda raw: ((raw.get('location') or {}).get('city') or '').lower() not in place)
    for raw in candidates:
        record, reason = scraper.parse(raw, what)
        if record:
            record['raw_source_data'] = {**record['raw_source_data'], 'source': source, 'resolved_by': 'indeed',
                                         'lead': {k: lead.get(k) for k in ('company', 'title', 'location', 'url') if lead.get(k)}}
            return record
    return None


class Resolver:
    """Indeed lookups for one run: off when disabled or paused, capped per run, closed when done."""

    def __init__(self, source: str, scraper: Optional[IndeedScraper] = None):
        self.source = source
        self.scraper = scraper
        self.lookups = 0
        self.found = 0
        self.error: Optional[str] = None

    @property
    def available(self) -> bool:
        if self.error or not setting('indeed.resolve_leads') or cooldown_until():
            return False
        return self.lookups < int(setting('indeed.lead_lookups_per_run'))

    def lookup(self, lead: Dict) -> Optional[Dict]:
        if not self.available:
            return None
        if self.scraper is None:
            self.scraper = IndeedScraper()
        self.lookups += 1
        try:
            record = lookup(lead, self.scraper, self.source)
        except Refused as exc:
            self.error = pause(exc.status)
            logger.warning(self.error)
            return None
        except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            self.error = f'Indeed lookup failed: {str(exc)[:200]}'
            logger.warning(self.error)
            return None
        self.found += bool(record)
        return record

    def close(self):
        if self.scraper is not None:
            self.scraper.close()
            self.scraper = None


def open_reader(warnings: List[str]):
    """A headless browser for verifying the agent's candidate pages, or None (with a warning)."""
    from .email_alerts import BrowserReader
    try:
        return BrowserReader().__enter__()
    except Exception as exc:
        warnings.append(f'No headless browser for the posting search: {type(exc).__name__}')
        return None


def close_reader(reader):
    if reader is not None:
        try:
            reader.__exit__(None, None, None)
        except Exception:
            pass


def agent_find(lead: Dict, reader, warnings: List[str], listed_on: str) -> Optional[Dict]:
    """The employer's posting for a lead Indeed does not carry, through the alert-email search agent."""
    from ..settings import model_id
    from .email_alerts import FIND_SCHEMA, FIND_SYSTEM, _run_claude, find_prompt, is_aggregator, readable_posting
    posting = {'company': lead['company'], 'title': lead['title'], 'location': lead.get('location') or '', 'url': lead.get('url') or ''}
    try:
        answer = _run_claude(find_prompt(posting).replace('advertised by a job-alert email', f'listed on {listed_on}'),
                             FIND_SCHEMA, ['WebSearch', 'WebFetch'], model_id('email.search_model'), system=FIND_SYSTEM)
    except Exception as exc:
        warnings.append(f'Posting search failed for {lead["title"]}: {str(exc)[:120]}')
        return None
    for candidate in answer.get('candidates', []):
        url = str(candidate.get('url', ''))
        if url.startswith('https://') and not is_aggregator(url):
            found = readable_posting({**posting, 'found_by': 'agent'}, url, reader)
            if found:
                return found
    return None


def known_key(company: str, title: str) -> Tuple[str, str]:
    return ((company or '').casefold(), normalize_title(title or '').casefold())


def unknown(leads: Iterable[Dict], known: set) -> List[Dict]:
    """Leads whose company and title are not stored yet, each once."""
    out, seen = [], set(known)
    for lead in leads:
        key = known_key(lead.get('company'), lead.get('title'))
        if key in seen:
            continue
        seen.add(key)
        out.append(lead)
    return out
