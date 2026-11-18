"""A posting he pastes as a link: read the page, store it in JobAgent, queue it.

The page is read in a headless browser. Its title, company and location come from the page's
JobPosting JSON-LD when it carries one, else from the page heading, the page title and the ATS
URL; he can state any of them himself. The posting then goes through the normal pipeline
(de-duplication, every track's verdict, caps) and is kept even when no track accepts it:
pasting the link is his Good-fit verdict, recorded as a label so autoplay, the reviewer and
pruning all see it. The U.S.-location rule still applies.

Page content is untrusted data; everything read from it is checked in code.
"""
import html
import json
import logging
import re
from typing import Optional
from urllib.parse import urlparse

from ..config import get_settings
from ..processing.normalize import (canonicalize_url, compute_description_hash, extract_salary, normalize_location,
                                    normalize_title)
from ..processing.us_locations import is_us_location
from .email_alerts import LOGIN_WALL, detect_ats, is_aggregator, matches

logger = logging.getLogger('jobagent.link_import')

LOCK_WAIT_SECONDS = 45
SETTLE_MS = 15000
MIN_TEXT = 200
ATS_WORDS = re.compile(r'(?i)^(?:careers?|jobs?|job (?:details?|description|opening|posting)|apply|greenhouse|lever|ashby|workday|'
                       r'icims|smartrecruiters|myworkdayjobs|job search|open positions|current openings|home)$')
# Company slugs in ATS URLs (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Breezy, BambooHR, Rippling).
ATS_SLUG = re.compile(r'(?i)^https?://(?:'
                      r'(?:job-boards|boards)\.greenhouse\.io/(?P<gh>[^/?#]+)'
                      r'|jobs\.lever\.co/(?P<lever>[^/?#]+)'
                      r'|jobs\.ashbyhq\.com/(?P<ashby>[^/?#]+)'
                      r'|(?P<wd>[^./]+)\.wd\d+\.myworkdayjobs\.com'
                      r'|jobs\.smartrecruiters\.com/(?P<sr>[^/?#]+)'
                      r'|(?P<breezy>[^./]+)\.breezy\.hr'
                      r'|(?P<bamboo>[^./]+)\.bamboohr\.com'
                      r'|ats\.rippling\.com/(?P<rippling>[^/?#]+)'
                      r'|(?P<icims>[^./]+)\.icims\.com'
                      r'|(?P<sf>[^./]+)\.(?:jobs2web|successfactors)'
                      r')')
TITLE_SPLIT = re.compile(r'\s+(?:[-|–—•·]|at|@)\s+')
# MyGreenhouse (my.greenhouse.io/jobs/<board>/<id>) shows a posting only to a signed-in candidate; anonymous visitors
# are redirected to its sign-in page. The same posting is public on the employer's job board.
MY_GREENHOUSE = re.compile(r'(?i)^https?://my\.greenhouse\.io/jobs/(?P<board>[a-z0-9_-]+)/(?P<job_id>\d+)(?:[/?#]|$)')
# A final URL that is a sign-in route (Greenhouse /users/sign_in, /login, /sessions/new) is never a posting.
SIGN_IN_PATH = re.compile(r'(?i)/(?:users/)?(?:sign_?in|log_?in|sessions/new)/?$')
EMPLOYMENT = {'FULL_TIME': 'Full-time', 'PART_TIME': 'Part-time', 'INTERN': 'Internship', 'CONTRACTOR': 'Contract', 'TEMPORARY': 'Temporary'}

PAGE_SCRIPT = """() => ({
  title: document.title || '',
  h1: [...document.querySelectorAll('h1')].map(h => h.innerText.trim()).filter(Boolean).slice(0, 3),
  og_title: document.querySelector('meta[property="og:title"]')?.content || '',
  og_site: document.querySelector('meta[property="og:site_name"]')?.content || '',
  ld_json: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent).slice(0, 10),
  text: document.body ? document.body.innerText : ''
})"""


class PageReader:
    """A headless browser, opened for one link, that returns the rendered page's text and metadata."""

    def __enter__(self):
        from playwright.sync_api import sync_playwright
        self._p = sync_playwright().start()
        self._browser = self._p.chromium.launch(headless=True)
        self._context = self._browser.new_context(user_agent=get_settings().user_agent)
        return self

    def __exit__(self, *exc):
        self._context.close(); self._browser.close(); self._p.stop()

    def read(self, url: str) -> dict:
        """{'url': final url, 'text', 'title', 'h1', 'og_title', 'og_site', 'ld_json'}; text is '' when unreadable."""
        page = self._context.new_page()
        try:
            page.goto(url, wait_until='domcontentloaded', timeout=45000)
            # Single-page career sites (Oracle Recruiting, Workday) render the posting seconds after load.
            try:
                page.wait_for_load_state('networkidle', timeout=SETTLE_MS)
            except Exception:
                pass  # some pages never go quiet; read what has rendered
            page.wait_for_timeout(1500)
            data = page.evaluate(PAGE_SCRIPT)
            return {'url': page.url, **{k: data.get(k) for k in ('text', 'title', 'h1', 'og_title', 'og_site', 'ld_json')}}
        except Exception as exc:
            logger.info('Could not read %s: %s', url, str(exc).splitlines()[0])
            return {'url': url, 'text': '', 'title': '', 'h1': [], 'og_title': '', 'og_site': '', 'ld_json': []}
        finally:
            page.close()


def job_posting_ld(ld_json) -> Optional[dict]:
    """The JobPosting object among a page's JSON-LD scripts, if any."""
    def walk(node):
        if isinstance(node, list):
            for item in node:
                found = walk(item)
                if found:
                    return found
        elif isinstance(node, dict):
            kind = node.get('@type')
            kinds = kind if isinstance(kind, list) else [kind]
            if 'JobPosting' in kinds:
                return node
            for key in ('@graph', 'mainEntity', 'itemListElement', 'item'):
                if key in node:
                    found = walk(node[key])
                    if found:
                        return found
        return None
    for raw in ld_json or []:
        try:
            found = walk(json.loads(raw))
        except (TypeError, ValueError):
            continue
        if found:
            return found
    return None


def _clean(value) -> str:
    if isinstance(value, dict):
        value = value.get('name') or value.get('@value') or ''
    text = html.unescape(re.sub(r'<[^>]+>', ' ', str(value or '')))
    return re.sub(r'\s+', ' ', text).strip()


def ld_location(posting: dict) -> str:
    """'City, Region, Country' per listed jobLocation, joined by '; ' (several offices stay separate)."""
    places = posting.get('jobLocation') or []
    places = places if isinstance(places, list) else [places]
    parts = []
    for place in places:
        address = (place or {}).get('address') if isinstance(place, dict) else None
        if isinstance(address, str):
            parts.append(_clean(address))
            continue
        if not isinstance(address, dict):
            if isinstance(place, dict) and place.get('name'):
                parts.append(_clean(place['name']))
            continue
        bits = [_clean(address.get(k)) for k in ('addressLocality', 'addressRegion', 'addressCountry')]
        bits = [b for b in bits if b]
        if bits:
            parts.append(', '.join(bits))
    if not parts and str(posting.get('jobLocationType') or '').upper() == 'TELECOMMUTE':
        req = posting.get('applicantLocationRequirements') or []
        req = req if isinstance(req, list) else [req]
        names = [_clean(r) for r in req if _clean(r)]
        if names:
            parts.append('Remote - ' + ', '.join(names))
    return '; '.join(dict.fromkeys(p for p in parts if p))


def public_posting_url(url: str) -> str:
    """The employer's public job-board URL behind a MyGreenhouse candidate link (Freeform 13281); other links unchanged."""
    match = MY_GREENHOUSE.match(url or '')
    if match:
        return f"https://job-boards.greenhouse.io/{match['board']}/jobs/{match['job_id']}"
    return url


def sign_in_redirect(url: str, page: dict) -> str:
    """'host/path' of the sign-in page the link landed on, or '' when the page is not a sign-in route."""
    final = urlparse(page.get('url') or url)
    if SIGN_IN_PATH.search(final.path or ''):
        return f"{final.hostname or ''}{final.path}"
    return ''


def company_from_url(url: str) -> str:
    match = ATS_SLUG.match(url or '')
    if not match:
        return ''
    slug = next((v for v in match.groupdict().values() if v), '')
    slug = re.sub(r'\d+$', '', slug)  # "archer56" -> "archer"
    words = [w for w in re.split(r'[-_]+', slug) if w and not ATS_WORDS.match(w)]  # "skildai-careers" -> "skildai"
    return ' '.join(words).strip().title()


# og:site_name on employer career sites: "Ford Global Career Site", "Acme Careers".
CAREER_SITE = re.compile(r'(?i)[\s,|-]+(?:global\s+)?(?:careers?|jobs?)(?:\s+(?:site|page|portal))?$|[\s,|-]+(?:global\s+)?career\s+site$')


def site_company(value) -> str:
    """A career site's name as the company: "Ford Global Career Site" -> "Ford"."""
    name = _clean(value)
    for _ in range(2):
        name = CAREER_SITE.sub('', name).strip()
    return name if not ATS_WORDS.match(name) else ''


LEGAL_SUFFIX = re.compile(r'(?i)[\s,]+(?:usa|u\.s\.a\.|us|inc\.?|llc|ltd\.?|corp\.?|corporation|co\.?|company|holdings|group)$')


def company_name(value) -> str:
    """A hiring organisation as he would write it: Workday's legal entities ("2100 NVIDIA USA") lose their code and suffixes."""
    name = site_company(re.sub(r'^\d+\s+', '', _clean(value)))
    for _ in range(3):
        name = LEGAL_SUFFIX.sub('', name).strip()
    return name


def title_from_page(page: dict, company: str) -> str:
    """The posting's title: the page heading when it reads as one, else the page title minus the company/ATS parts."""
    for heading in page.get('h1') or []:
        heading = _clean(heading)
        if 3 <= len(heading) <= 160 and not ATS_WORDS.match(heading) and heading.casefold() != (company or '').casefold():
            return heading
    for candidate in (page.get('og_title'), page.get('title')):
        parts = [p.strip() for p in TITLE_SPLIT.split(_clean(candidate)) if p.strip()]
        parts = [p for p in parts if not ATS_WORDS.match(p) and p.casefold() != (company or '').casefold()
                 and not (company and p.casefold().startswith(company.casefold() + ' careers'))]
        if parts:
            return max(parts, key=len) if len(parts) > 1 and all(len(p) < 12 for p in parts[:1]) else parts[0]
    return ''


def location_from_text(text: str) -> str:
    """The first short line near the top of the page that names a U.S. place."""
    for line in (text or '').splitlines()[:120]:
        line = line.strip(' \t•|·-')
        if 3 <= len(line) <= 90 and is_us_location(line) and not re.search(r'(?i)\b(apply|save|share|sign in|log in)\b', line):
            return line
    return ''


def guess(page: dict) -> dict:
    """Company, title and location read from the page; each may be '' when the page does not say."""
    posting = job_posting_ld(page.get('ld_json')) or {}
    company = company_name((posting.get('hiringOrganization') or {}) if isinstance(posting.get('hiringOrganization'), (dict, str)) else '')
    company = company or site_company(page.get('og_site')) or company_from_url(page.get('url') or '')
    title = _clean(posting.get('title')) or title_from_page(page, company)
    location = ld_location(posting) if posting else ''
    location = location or location_from_text(page.get('text') or '')
    employment = posting.get('employmentType')
    employment = employment[0] if isinstance(employment, list) and employment else employment
    return {'company': company, 'title': title, 'location': location,
            'employment_type': EMPLOYMENT.get(str(employment or '').upper(), _clean(employment) or None),
            'posted': _clean(posting.get('datePosted')) or None, 'from_ld': bool(posting)}


def build_record(url: str, page: dict, posting: dict) -> dict:
    """The pipeline record for a posting he added by link (same shape as the email-alert importer's)."""
    description = re.sub(r'\n{3,}', '\n\n', page.get('text') or '').strip()[:30000]
    final = page.get('url') or url
    canonical = canonicalize_url(final)
    location = posting.get('location') or ''
    sal_raw, sal_min, sal_max = extract_salary(description)
    return {'external_req_id': (re.search(r'(\d{5,})', canonical) or [None, canonical[-40:]])[1],
            'company_name': posting['company'], 'title': posting['title'], 'normalized_title': normalize_title(posting['title']),
            'location': location, 'normalized_location': normalize_location(location)[0] if location else '',
            'department': None, 'employment_type': posting.get('employment_type'), 'description': description,
            'description_hash': compute_description_hash(description), 'canonical_url': canonical, 'application_url': final,
            'source_ats': detect_ats(final) if detect_ats(final) != 'email_alert' else 'link',
            'salary_raw': sal_raw, 'salary_min': sal_min, 'salary_max': sal_max, 'posting_date': None,
            'raw_source_data': {'source': 'link', 'pasted_url': url, 'from_ld': posting.get('from_ld', False),
                                'stated': posting.get('stated', [])},
            'keep': True}  # his explicit add: stored even when no track accepts it


def _claim_pipeline(wait=LOCK_WAIT_SECONDS):
    """The pipeline's write lock; a scan holds it only while storing what it fetched, not while fetching."""
    from ..tracking.lifecycle import PIPELINE_LOCK
    if not PIPELINE_LOCK.acquire(timeout=wait):
        raise ValueError('A source scan is storing postings right now. Try again in a minute.')
    return PIPELINE_LOCK.release


APPLY_PATH = re.compile(r'/(?:apply|application)/?$')


def read_posting_page(url: str, reader) -> dict:
    """The pasted page, completed from the posting page behind an application form (Lever /apply, Ashby /application)."""
    page = reader.read(url)
    parsed = urlparse(url)
    if APPLY_PATH.search(parsed.path) and (len(page.get('text') or '') < 1500 or not job_posting_ld(page.get('ld_json'))):
        parent = reader.read(parsed._replace(path=APPLY_PATH.sub('', parsed.path)).geturl())
        if len(parent.get('text') or '') > len(page.get('text') or ''):
            page = {**parent, 'url': page.get('url') or url, 'application_url': parent.get('url')}
    return page


# Bot checks job boards show headless browsers instead of the posting (Indeed's Cloudflare wall).
BOT_WALL = re.compile(r'(?i)\b(just a moment|additional verification required|request blocked|security check|'
                      r'verify you are (?:a )?human|authenticating)\b')


def board_unreadable(page: dict) -> bool:
    """A job-board page that shows a login or bot wall, or too little text, instead of the posting."""
    text = page.get('text') or ''
    head = ' '.join([page.get('title') or '', *(page.get('h1') or []), text[:1500]])
    return len(text) < MIN_TEXT or bool(BOT_WALL.search(head)) or bool(LOGIN_WALL.search(text[:2000]))


def _search_official(posting: dict) -> list:
    """Candidate URLs of the employer's own posting, from the same web-search agent the job-alert importer uses."""
    from ..settings import model_id
    from .email_alerts import FIND_SCHEMA, FIND_SYSTEM, _run_claude, find_prompt
    try:
        answer = _run_claude(find_prompt({**posting}).replace('advertised by a job-alert email', 'posted on a job board'),
                             FIND_SCHEMA, ['WebSearch', 'WebFetch'], model_id('email.search_model'), system=FIND_SYSTEM)
    except Exception as exc:
        raise ValueError(f"The search for the employer's own posting did not finish ({str(exc)[:120]}). Paste the employer's posting link instead.")
    return [str(c.get('url', '')) for c in answer.get('candidates', [])]


def find_employer_posting(url: str, overrides: Optional[dict], reader, search=None):
    """For a job-board link that cannot be read (Indeed blocks automated browsers): the employer's own posting,
    found by searching for the company and title he states. Returns (url, page)."""
    stated = {k: ((overrides or {}).get(k) or '').strip() for k in ('company', 'title', 'location')}
    host = (urlparse(url).hostname or url).removeprefix('www.')
    if not (stated['company'] and stated['title']):
        raise ValueError(f"{host} shows a sign-in or bot check instead of the posting, so JobAgent can't read it. Enter the "
                         "company and title below (location helps) and add again; JobAgent then finds the employer's own posting.")
    for candidate in (search or _search_official)(stated):
        if not candidate.startswith('https://') or is_aggregator(candidate):
            continue
        page = read_posting_page(candidate, reader)
        if not board_unreadable(page) and matches(stated, page.get('text') or '', page.get('url') or candidate):
            return candidate, page
    raise ValueError(f"Couldn't find {stated['company']}'s own posting for \"{stated['title']}\". "
                     "Paste the employer's posting link instead.")


def resolve_posting(url: str, page: dict, overrides: Optional[dict]) -> dict:
    """What the page says, with his stated values on top; raises when company, title or a U.S. location is missing."""
    text = page.get('text') or ''
    landed = sign_in_redirect(url, page)
    if landed:  # the login page's own text is long enough to pass as a description (Freeform 13281, my.greenhouse.io)
        raise ValueError(f"That link opened a sign-in page ({landed}), not a posting. Paste the employer's own posting link "
                         "(for Greenhouse, the job-boards.greenhouse.io address) instead.")
    if len(text) < MIN_TEXT:
        raise ValueError("Couldn't read that page in a headless browser. Check the link, or paste the employer's own posting URL.")
    if LOGIN_WALL.search(text[:2000]) and is_aggregator(page.get('url') or url):
        raise ValueError("That link needs a sign-in to view the posting. Paste the employer's own posting link instead.")
    found = guess(page)
    stated = {k: (overrides or {}).get(k, '').strip() for k in ('company', 'title', 'location')}
    posting = {**found, **{k: v for k, v in stated.items() if v}, 'stated': [k for k, v in stated.items() if v]}
    missing = [k for k in ('company', 'title') if not posting.get(k)]
    if missing:
        read = ', '.join(f'{k}: {posting[k]}' for k in ('company', 'title') if posting.get(k)) or 'nothing'
        raise ValueError(f"Couldn't tell the {' and '.join(missing)} from the page (read {read}). Set it below and add again.")
    if not is_us_location(posting.get('location')):
        hint = f' (the page says "{posting["location"]}")' if posting.get('location') else ''
        raise ValueError(f'No confirmed U.S. work location{hint}. Postings need a U.S. location, like "Santa Clara, CA"; set it below if the page has one.')
    return posting


def import_posting(url: str, overrides: Optional[dict] = None, queue: bool = True, position: str = 'end',
                   reader_factory=PageReader, sessions=None, runner=None, claim=_claim_pipeline) -> dict:
    """Store the posting at this link and, unless told otherwise, queue it for application. Returns a summary."""
    from sqlalchemy import func
    from ..db.models import Job, JobStatus
    from ..db.repository import JobRepository, get_db_session
    from ..processing.tracks import active_track, per_track, with_track
    from ..tracking.lifecycle import JobLifecyclePipeline
    url = (url or '').strip()
    if not re.match(r'^https?://[^\s]+$', url):
        raise ValueError('Paste a full posting link starting with http:// or https://')
    if position not in ('end', 'next'):
        raise ValueError('Position must be end or next')
    board_url = None
    pasted, url = url, public_posting_url(url)
    with reader_factory() as reader:
        page = read_posting_page(url, reader)
        if is_aggregator(page.get('url') or url) and board_unreadable(page):
            board_url = url
            url, page = find_employer_posting(url, overrides, reader)
    posting = resolve_posting(url, page, overrides)
    record = build_record(url, page, posting)
    record['raw_source_data']['pasted_url'] = pasted
    if board_url:
        record['raw_source_data']['board_url'] = board_url
    sessions = sessions or get_db_session
    release = claim()
    try:
        with sessions() as session:
            repo = JobRepository(session)
            # A name read from a URL slug ("Spacex") takes the spelling already stored, so caps and history match.
            known = session.query(Job.company_name).filter(func.lower(Job.company_name) == record['company_name'].lower()).first()
            if known and 'company' not in posting.get('stated', []):
                record['company_name'] = known[0]
            before = repo.get_job_by_canonical_url(record['canonical_url'])
            was = before.status.value if before else None
            stats = JobLifecyclePipeline(session).process_discovered_jobs([record], sources_checked=0, record_run=False)
            job = repo.get_job_by_canonical_url(record['canonical_url'])
            if not job:
                error = (stats.get('error_log') or [{}])[0].get('error') or 'the pipeline did not store it'
                raise ValueError(f"Couldn't store the posting: {error}")
            # His explicit add reopens a posting he had set aside; applications already made stay as they are.
            if job.status in (JobStatus.IGNORED, JobStatus.CLOSED):
                job.status = JobStatus.NEW
            labeled = False
            track = active_track()
            # Manually pasting a posting is an explicit Good-fit decision that overrides the normal
            # eligibility and experience filters. The U.S.-location check remains in resolve_posting.
            if (per_track(job.user_fit_label, track) or {}).get('fit') is not True:
                job.user_fit_label = with_track(job.user_fit_label, track, {'fit': True, 'note': 'Manually added by user', 'labeled_at': _now()})
                labeled = True
            warning = None
            applied_on = job.application.applied_date.date().isoformat() if job.application and job.application.applied_date else None
            session.commit()
            result = {'job_id': job.id, 'company': job.company_name, 'title': job.title, 'location': job.location,
                      'eligibility': job.eligibility.value, 'role_type': job.role_type, 'status': job.status.value,
                      'url': job.application_url or job.canonical_url, 'new': before is None, 'previous_status': was,
                      'labeled': labeled, 'warning': warning, 'read': {k: posting.get(k) for k in ('company', 'title', 'location')}, 'stated': posting.get('stated', [])}
    finally:
        release()
    if labeled:
        try:
            from ..ui.server import tune_later
            tune_later(track)
        except Exception:  # the dashboard is not always running (CLI use)
            logger.debug('Rule tuning not scheduled', exc_info=True)
    result['queued'] = False
    result['applied_on'] = applied_on
    if queue and applied_on:
        # Say why in his terms; the runner's own refusal names a job number and "unresolved submission".
        result['queue_error'] = f'you already applied to this role on {applied_on}'
    elif queue:
        try:
            runner = runner or _runner()
            outcome = runner.queue([result['job_id']], position, allow_other_roles=True, mark_fit=True)
            result['queued'] = outcome['added'] > 0 or position == 'next'
            result['already_queued'] = outcome['added'] == 0
        except ValueError as exc:
            result['queue_error'] = str(exc)
    return result


def too_senior(job):
    """Why the posting's required years rule it out under profile.max_required_experience_years, or None."""
    from ..settings import setting
    limit, years = setting('profile.max_required_experience_years'), job.experience_required_years
    if limit is None or years is None or years < limit:
        return None
    return f'The posting requires {years:g}+ years of experience (your limit is {limit}), so it was stored but not labelled Good fit or queued.'


def _runner():
    from ..services.application_runner import get_runner
    return get_runner()


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
