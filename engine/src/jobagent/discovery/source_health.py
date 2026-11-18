"""Probe the actual listing schema; a reachable home page alone is not a working source."""
from dataclasses import dataclass
import ipaddress
import re
import socket
from urllib.parse import quote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from ..scrapers.workday import WorkdayScraper
from ..scrapers.company_sites import CompanyCareerScraper
from .github import markdown_rows


@dataclass
class HealthResult:
    health: str
    detail: str
    jobs_found: int = 0

    @property
    def working(self):
        return self.health in ('working', 'empty')


def public_url(url):
    p = urlparse(url)
    if p.scheme not in ('https','http') or not p.hostname or p.username or p.password or p.port not in (None,80,443):
        raise ValueError('Use a public HTTPS company careers URL.')
    try:
        addresses = socket.getaddrinfo(p.hostname, p.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError('The careers website cannot be resolved.') from exc
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('The careers URL must point to a public website.')
    return url


def get_public(client, url, **kwargs):
    # Inspect every redirect so adding a public URL cannot reach local services.
    for _ in range(6):
        public_url(url)
        response = client.get(url, follow_redirects=False, **kwargs)
        if response.is_redirect:
            url = urljoin(url,response.headers.get('location',''))
            continue
        return response
    raise ValueError('Too many careers-site redirects.')


def probe_source(ats, target):
    token = target.get('board_token') or target.get('company_slug')
    url = target.get('career_url') or ''
    try:
        if ats in ('bmw', 'mercedes', 'ibm', 'rivian'):
            from ..scrapers import get_scraper_for_ats
            public_url(url)
            scraper = get_scraper_for_ats(ats)
            try:
                rows, total = scraper.probe(target)
                if not isinstance(rows, list) or not isinstance(total, int) or total < 0 or (total and not rows):
                    return HealthResult('unreadable', 'Employer job-list schema is missing or inconsistent')
                if rows and not all(row.get('title') and row.get('canonical_url') and row.get('description') for row in rows):
                    return HealthResult('unreadable', 'Employer listing details could not be verified')
                return HealthResult('working' if total else 'empty', 'Employer listing schema and posting details verified' if total else 'Valid employer job board with no current results', total)
            finally:
                scraper.close()
        if ats == 'oracle':
            from ..scrapers.oracle import OracleScraper
            public_url(url)
            scraper = OracleScraper(request_delay=0, timeout=12)
            try:
                rows, total = scraper.search_page(target, limit=1)
                return HealthResult('working' if total else 'empty', 'Oracle requisition-list schema verified', total)
            finally:
                scraper.close()
        with httpx.Client(timeout=12, headers={'User-Agent':'JobAgent/1.0'}, follow_redirects=False) as client:
            if ats == 'greenhouse':
                if not token: return HealthResult('invalid','Missing Greenhouse board token')
                response = get_public(client,f'https://boards-api.greenhouse.io/v1/boards/{quote(token,safe="")}/jobs')
            elif ats == 'lever':
                if not token: return HealthResult('invalid','Missing Lever company slug')
                response = get_public(client,f'https://api.lever.co/v0/postings/{quote(token,safe="")}?mode=json')
            elif ats == 'ashby':
                if not token: return HealthResult('invalid','Missing Ashby company slug')
                response = get_public(client,f'https://api.ashbyhq.com/posting-api/job-board/{quote(token,safe="")}')
            elif ats == 'breezy':
                if not token: return HealthResult('invalid','Missing Breezy company slug')
                response = get_public(client,f'https://{quote(token,safe="")}.breezy.hr/json')
            elif ats == 'smartrecruiters':
                from ..scrapers.smartrecruiters import SmartRecruitersScraper
                response = get_public(client,SmartRecruitersScraper.board(target),params={'limit':1})
            elif ats == 'workday':
                _, _, base = WorkdayScraper.board(url)
                public_url(base)
                response = client.post(base+'/jobs',json={'appliedFacets':{},'limit':20,'offset':0,'searchText':'engineer'})
            elif ats == 'amazon':
                response = get_public(client,'https://www.amazon.jobs/en/search.json',params={'base_query':'mechanical engineer','result_limit':10,'offset':0})
            elif ats == 'github':
                response = get_public(client,f'https://raw.githubusercontent.com/{target["repository"]}/{target.get("ref","main")}/{target.get("path","README.md")}')
            elif ats in ('direct','company','apple','tesla','siemens'):
                if not url: return HealthResult('invalid','No company careers URL')
                response = get_public(client,url)
            elif ats == 'browser':
                return probe_browser(target)
            elif ats == 'indeed':
                from .indeed import probe
                return probe()
            elif ats == 'linkedin':
                from .linkedin import probe
                return probe()
            elif ats == 'handshake':
                from .handshake import probe
                return probe()
            else:
                return HealthResult('unsupported', f'No implemented {ats} listing adapter')
            if response.status_code != 200:
                status = 'missing' if response.status_code in (404,410) else 'blocked' if response.status_code in (401,403) else 'temporary_error' if response.status_code in (408,429) or response.status_code >= 500 else 'invalid'
                return HealthResult(status,f'Listing endpoint returned HTTP {response.status_code}')
            if ats in ('greenhouse','ashby','workday','amazon','lever','breezy','smartrecruiters'):
                data=response.json()
                field='jobPostings' if ats=='workday' else 'content' if ats=='smartrecruiters' else 'jobs'
                jobs=data if ats in ('lever','breezy') else data.get(field) if isinstance(data,dict) else None
                if not isinstance(jobs,list):return HealthResult('unreadable','Expected job-list JSON schema is missing')
                return HealthResult('working' if jobs else 'empty', 'Job-list schema verified' if jobs else 'Valid job board with no current results', len(jobs))
            if ats=='github':
                data=response.json() if target.get('format')=='simplify_json' else list(markdown_rows(response.text))
                if not isinstance(data,list) or not data:return HealthResult('unreadable','No readable job records')
                return HealthResult('working','Repository job records verified',len(data))
            soup=BeautifulSoup(response.text,'html.parser')
            if ats=='siemens':
                jobs=soup.select('a[href*="/JobDetail/"]')
            else:
                scraper=CompanyCareerScraper(request_delay=0)
                try:
                    scraper.get_with_retry=lambda *a,**k:response
                    jobs=scraper.discover_jobs({**target,'career_url':str(response.url)})
                finally:scraper.close()
            if jobs:return HealthResult('working','Job listing links parsed by the adapter',len(jobs))
            if re.search(r'no (?:current |open |available )?(?:jobs|openings|positions|vacancies)|0 results',soup.get_text(' ',strip=True),re.I):
                return HealthResult('empty','Explicit no-current-openings message')
            return HealthResult('unreadable','Page loads but the scraper cannot extract job listings')
    except (httpx.TimeoutException,httpx.NetworkError) as exc:
        return HealthResult('temporary_error',type(exc).__name__)
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        health = 'blocked' if status in (401, 403) else 'temporary_error' if status in (408, 429) or status >= 500 else 'missing' if status in (404, 410) else 'invalid'
        return HealthResult(health, f'Employer listing endpoint returned HTTP {status}')
    except Exception as exc:
        return HealthResult('invalid',str(exc)[:250])


def probe_browser(target):
    from ..scrapers.browser_sites import BrowserCareerScraper
    scraper=BrowserCareerScraper(request_delay=0)
    try:
        # One query and one detail verify the rendered adapter without crawling the whole board.
        from playwright.sync_api import sync_playwright
        url=(target.get('career_url') or '').replace('{query}','mechanical%20engineer')
        public_url(url)
        with sync_playwright() as p:
            browser=p.chromium.launch(**scraper.launch_options(url))
            try:
                context=browser.new_context(user_agent=scraper.user_agent)
                links=scraper._collect_links(context,url,re.compile(scraper._pattern_for(url)),target['name'])
                if not links:
                    structured=scraper._read_jsonld_jobs(context,url,target['name'])
                    if structured:
                        return HealthResult('working','Rendered JobPosting structured data verified',len(structured))
                    return HealthResult('unreadable','Rendered search produced no parseable listing links or JobPosting data')
                href,title=links[0]; absolute=scraper._resolve(href,url)
                job=scraper._read_posting(context,absolute,absolute,target['name'],title)
                return HealthResult('working','Rendered listing and employer details verified',len(links)) if job else HealthResult('unreadable','Listing links found but job detail extraction failed')
            finally:browser.close()
    except Exception as exc:
        return HealthResult('blocked',str(exc).splitlines()[0][:250])
    finally:scraper.close()
