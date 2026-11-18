"""Company logos for the dashboard's role cards.

A logo is looked up once per company and kept under data/company-logos, so the dashboard serves it from
disk afterwards. The posting's own page is read first for its logo; failing that, the lookup sends only the
employer's name (to a public company-name search) and the resulting domain (to a public site-icon service).
Nothing about him or his applications leaves the machine.
A company with no confident match is remembered as having none, and the card shows its initial instead.
"""
import json
import re
import threading
import urllib.parse
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from ..config import get_settings

router = APIRouter()
_lock = threading.Lock()
SUGGEST = 'https://autocomplete.clearbit.com/v1/companies/suggest?query='
ICON = 'https://www.google.com/s2/favicons?sz=128&domain='
_SUFFIX = re.compile(r',?\s+\b(inc|llc|ltd|corp|corporation|co|company|incorporated|plc|gmbh|group|holdings|technologies|technology)\b\.?', re.I)


def _directory() -> Path:
    path = Path(get_settings().data_dir) / 'company-logos'
    path.mkdir(parents=True, exist_ok=True)
    return path


def key(name: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', (name or '').casefold()).strip('-')[:80]


def plain(name: str) -> str:
    """The name as a person would say it: "Amazon.jobs" and "Ford Motor Company" search as "Amazon" and "Ford Motor"."""
    name = re.sub(r'\.(jobs|careers)\b', '', name or '', flags=re.I)
    name = re.sub(r'\s*\([^)]*\)', '', name)
    return _SUFFIX.sub('', name).strip(' ,.') or name


def _words(text: str) -> set:
    return set(re.findall(r'[a-z0-9]+', text.casefold()))


def pick_domain(name: str, suggestions: list) -> str | None:
    """The suggestion that is this company, not merely one sharing a word with it."""
    wanted = _words(plain(name))
    if not wanted:
        return None
    for item in suggestions or []:
        domain, found = str(item.get('domain') or ''), _words(plain(str(item.get('name') or '')))
        if re.fullmatch(r'[a-z0-9.-]+\.[a-z]{2,}', domain) and found and (found == wanted or wanted <= found and len(found) - len(wanted) <= 1):
            return domain
    return None


def _get(url: str, timeout: float = 6.0) -> tuple[bytes, str]:
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (dashboard logo cache)'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(600_000), response.headers.get_content_type()


def _public(url: str) -> bool:
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or '').casefold()
    return parts.scheme in ('http', 'https') and bool(host) and host != 'localhost' and not re.fullmatch(r'[\d.]+|\[?[0-9a-f:]+\]?', host) and not host.endswith('.local')


def logo_candidates(html: str, base: str) -> list:
    """Logo image addresses a job posting page names, best first: an image marked as the logo, then the page's
    share image, then its touch icon and favicon (his suggestion 2026-11-13: postings usually carry the logo)."""
    found = []
    for tag in re.findall(r'<img\b[^>]*>', html, flags=re.I):
        if re.search(r'(?:class|id|alt|src)\s*=\s*["\'][^"\']*logo', tag, flags=re.I):
            match = re.search(r'\bsrc\s*=\s*["\']([^"\']+)', tag, flags=re.I)
            if match:
                found.append(match.group(1))
    for pattern in (r'<meta\b[^>]*(?:property|name)\s*=\s*["\']og:image(?::secure_url)?["\'][^>]*>',
                    r'<link\b[^>]*rel\s*=\s*["\'][^"\']*apple-touch-icon[^"\']*["\'][^>]*>',
                    r'<link\b[^>]*rel\s*=\s*["\'](?:shortcut )?icon["\'][^>]*>'):
        for tag in re.findall(pattern, html, flags=re.I):
            match = re.search(r'\b(?:content|href)\s*=\s*["\']([^"\']+)', tag, flags=re.I)
            if match:
                found.append(match.group(1))
    out = []
    for address in found:
        address = urllib.parse.urljoin(base, address.replace('&amp;', '&').strip())
        if _public(address) and address not in out:
            out.append(address)
    return out[:6]


def from_posting(url: str, fetch) -> tuple[bytes, str, str] | None:
    """The logo shown on a posting page: (bytes, media type, address), or None."""
    if not url or not _public(url):
        return None
    body, media = fetch(url)
    if 'html' not in media:
        return None
    for address in logo_candidates(body.decode('utf-8', 'replace'), url):
        try:
            image, kind = fetch(address)
        except Exception:
            continue
        if kind.startswith('image/') and len(image) > 200:
            return image, kind, address
    return None


def lookup(name: str, fetch=_get, posting_url: str | None = None) -> tuple[bytes, str] | None:
    """Logo bytes and media type for a company, from the cache or fetched once; None when it has no logo."""
    slug, directory = key(name), _directory()
    if not slug:
        return None
    index_path = directory / 'index.json'
    with _lock:
        try:
            index = json.loads(index_path.read_text())
        except (OSError, ValueError):
            index = {}
        entry = index.get(slug)
    if entry is not None and not (posting_url and not entry.get('file') and not entry.get('posting_tried')):
        if not entry.get('file'):
            return None
        try:
            return (directory / entry['file']).read_bytes(), entry.get('type', 'image/png')
        except OSError:
            pass
    record = {'name': name, 'file': None, 'posting_tried': bool(posting_url)}
    try:
        posted = None
        try:
            posted = from_posting(posting_url, fetch) if posting_url else None
        except Exception:
            posted = None  # a posting that will not load falls back to the name search below
        if posted:
            (directory / f'{slug}.img').write_bytes(posted[0])
            record = {'name': name, 'source': posted[2], 'file': f'{slug}.img', 'type': posted[1], 'posting_tried': True}
            with _lock:
                try:
                    index = json.loads(index_path.read_text())
                except (OSError, ValueError):
                    index = {}
                index[slug] = record
                index_path.write_text(json.dumps(index, indent=1))
            return posted[0], posted[1]
        suggestions = json.loads(fetch(SUGGEST + urllib.parse.quote(plain(name)))[0].decode('utf-8', 'replace'))
        domain = pick_domain(name, suggestions)
        if domain:
            body, media = fetch(ICON + urllib.parse.quote(domain))
            if media.startswith('image/') and len(body) > 200:
                (directory / f'{slug}.img').write_bytes(body)
                record = {'name': name, 'domain': domain, 'file': f'{slug}.img', 'type': media, 'posting_tried': bool(posting_url)}
    except Exception:
        return None  # offline or the service failed: not remembered, so it is tried again later
    with _lock:
        try:
            index = json.loads(index_path.read_text())
        except (OSError, ValueError):
            index = {}
        index[slug] = record
        index_path.write_text(json.dumps(index, indent=1))
    return ((directory / record['file']).read_bytes(), record['type']) if record['file'] else None


@router.get('/api/company-logo')
def company_logo(name: str = Query(..., min_length=1, max_length=255), job: int | None = Query(None, ge=1)):
    posting = None
    if job:
        from ..db.models import Job
        from ..db.repository import get_db_session
        with get_db_session() as session:
            row = session.get(Job, job)
            if row and (row.company_name or '').casefold() == name.casefold():
                posting = row.application_url or row.canonical_url
    found = lookup(name, posting_url=posting)
    if not found:
        raise HTTPException(status_code=404, detail='No logo for this company', headers={'Cache-Control': 'max-age=3600'})
    return Response(found[0], media_type=found[1], headers={'Cache-Control': 'max-age=604800'})
