"""Career sites that only exist once JavaScript has run.

Meta, Google and Microsoft publish no usable job API: Google's documented endpoint answers 404,
Microsoft's service certificate does not validate outside a browser, and Meta's is GraphQL behind
its own app. Their listings are real and public, they just require a renderer.

Job links are matched by URL shape rather than by CSS class. A careers site restyles often and a
class name breaks silently, but the path that identifies a requisition is part of the site's own
routing and changes far less.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup

from .base import BaseScraper
from ..processing.normalize import (
    canonicalize_url, compute_description_hash, extract_salary,
    normalize_location, normalize_title,
)

logger = logging.getLogger("jobagent.scrapers.browser_sites")

# Rendering is expensive, so the work is bounded per target rather than open-ended.
MAX_JOBS_PER_TARGET = 40
LIST_SETTLE_MS = 9000
DETAIL_SETTLE_MS = 6000


class BrowserCareerScraper(BaseScraper):
    """Render a career search page, collect requisition links, then read each posting."""

    # The path that identifies a requisition belongs to the site's routing, not to the user's
    # configuration, so it lives here keyed by host rather than in search.yaml.
    LINK_PATTERNS = {
        "metacareers.com": r"/profile/job_details/\d+",
        "google.com": r"jobs/results/\d+",
        "careers.microsoft.com": r"/careers/job/\d+",
        "jobs.apple.com": r"/en-us/details/\d+(?:-\d+)?/",
    }
    GENERIC_PATTERN = r"/(?:job|jobs|careers)/[\w-]*\d{4,}"

    def discover_jobs(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        company_name = target.get("name", "Unknown")
        # The search URL is carried as career_url and holds a {query} placeholder.
        search_url = target.get("search_url") or target.get("career_url")
        if not search_url:
            logger.warning(f"{company_name}: browser target needs a search URL")
            return []
        pattern = target.get("job_link_pattern") or self._pattern_for(search_url)

        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            # The rest of discovery must not fail because an optional dependency is absent.
            logger.warning("Playwright is not installed; skipping browser-rendered career sites")
            return []

        queries = target.get("queries") or self._configured_queries()
        link_re = re.compile(pattern)
        found: Dict[str, Tuple[str, str]] = {}
        discovered: List[Dict[str, Any]] = []

        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(**self.launch_options(search_url))
                context = browser.new_context(user_agent=self.user_agent)
                try:
                    structured_urls = set()
                    for query in queries:
                        if len(found) >= MAX_JOBS_PER_TARGET:
                            break
                        url = search_url.replace("{query}", query.replace(" ", "%20"))
                        links = self._collect_links(context, url, link_re, company_name)
                        if not links:
                            # Some custom ATS boards expose JobPosting JSON-LD but use URL
                            # routes that do not match our site's stable requisition patterns.
                            # Read that structured data before giving up; this stays local and
                            # avoids spending an LLM call just to rediscover fields the site
                            # already publishes.
                            for job in self._read_jsonld_jobs(context, url, company_name):
                                canonical = job["canonical_url"]
                                if canonical not in structured_urls:
                                    structured_urls.add(canonical)
                                    discovered.append(job)
                        for href, link_text in links:
                            absolute = self._resolve(href, url)
                            found.setdefault(canonicalize_url(absolute), (absolute, link_text))
                            if len(found) >= MAX_JOBS_PER_TARGET:
                                break

                    for canonical, (absolute, link_text) in found.items():
                        if canonical in structured_urls:
                            continue
                        parsed = self._read_posting(context, absolute, canonical, company_name, link_text)
                        if parsed:
                            discovered.append(parsed)
                finally:
                    context.close()
                    browser.close()
        except Exception as e:
            self.last_error = str(e)
            logger.error(f"Browser discovery failed for {company_name}: {e}")
            return discovered

        logger.info(f"{company_name}: {len(discovered)} postings read from a rendered page")
        return discovered

    def _collect_links(self, context, url: str, link_re, company_name: str) -> List[Tuple[str, str]]:
        """Return (href, link text). The link text is the posting's title as the site itself
        writes it, which beats guessing at a heading on the detail page: those pages lead with
        chrome like "Jobs" or "Job Details"."""
        page = context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(LIST_SETTLE_MS)
            pairs = page.eval_on_selector_all(
                "a[href]",
                "els => els.map(e => [e.getAttribute('href'), (e.innerText || '').trim()])") or []
            return [(h, t) for h, t in pairs if h and link_re.search(h)]
        except Exception as e:
            logger.warning(f"{company_name}: could not read {url}: {str(e).splitlines()[0]}")
            return []
        finally:
            page.close()

    def _read_jsonld_jobs(self, context, url: str, company_name: str) -> List[Dict[str, Any]]:
        """Read schema.org JobPosting records from a rendered search page.

        This is a bounded fallback for custom boards whose posting links use a route
        we do not recognize. Prefer the employer's structured fields over an LLM guess.
        """
        page = context.new_page()
        jobs: List[Dict[str, Any]] = []
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(1500)
            scripts = page.locator('script[type="application/ld+json"]').all_text_contents()
            records: List[Dict[str, Any]] = []

            def collect(node):
                if isinstance(node, list):
                    for item in node:
                        collect(item)
                elif isinstance(node, dict):
                    kind = node.get("@type")
                    kinds = kind if isinstance(kind, list) else [kind]
                    if any(str(value).rstrip("/").rsplit("/", 1)[-1].rsplit("#", 1)[-1] == "JobPosting"
                           for value in kinds if value):
                        records.append(node)
                    else:
                        for key in ("@graph", "mainEntity", "itemListElement", "item"):
                            if key in node:
                                collect(node[key])

            for raw in scripts:
                try:
                    collect(json.loads(raw))
                except (TypeError, ValueError):
                    continue

            for record in records[:MAX_JOBS_PER_TARGET]:
                title = self._clean_title(record.get("title", ""))
                posting_url = record.get("url")
                if not title or not isinstance(posting_url, str) or not posting_url.strip():
                    continue
                posting_url = urljoin(url, posting_url.strip())
                if urlparse(posting_url).scheme not in ("http", "https"):
                    continue
                canonical = canonicalize_url(posting_url)
                raw_description = record.get("description") or ""
                description = BeautifulSoup(str(raw_description), "html.parser").get_text("\n", strip=True)

                locations = record.get("jobLocation") or []
                if isinstance(locations, dict):
                    locations = [locations]
                location_parts = []
                for entry in locations if isinstance(locations, list) else []:
                    address = entry.get("address", {}) if isinstance(entry, dict) else {}
                    if isinstance(address, list):
                        address = address[0] if address else {}
                    if isinstance(address, dict):
                        part = ", ".join(str(address.get(key, "")).strip() for key in
                                          ("addressLocality", "addressRegion", "addressCountry")
                                          if address.get(key))
                        if part and part not in location_parts:
                            location_parts.append(part)
                location = "; ".join(location_parts)
                if not location and str(record.get("jobLocationType", "")).upper() == "TELECOMMUTE":
                    location = "Remote"
                norm_loc, _remote, _hybrid = normalize_location(location) if location else ("", False, False)

                salary = record.get("baseSalary") or {}
                if isinstance(salary, list):
                    salary = salary[0] if salary else {}
                salary_value = salary.get("value", {}) if isinstance(salary, dict) else {}
                if isinstance(salary_value, list):
                    salary_value = salary_value[0] if salary_value else {}
                if not isinstance(salary_value, dict):
                    salary_value = {"value": salary_value}
                minimum = salary_value.get("minValue", salary_value.get("value"))
                maximum = salary_value.get("maxValue", minimum)
                try:
                    salary_min = float(minimum) if minimum not in (None, "") else None
                    salary_max = float(maximum) if maximum not in (None, "") else None
                except (TypeError, ValueError):
                    salary_min = salary_max = None
                salary_raw = None
                if salary_min is not None:
                    currency = salary.get("currency") or ""
                    salary_raw = f"{currency} {salary_min:g}" + (f"–{salary_max:g}" if salary_max is not None and salary_max != salary_min else "")

                req_id = re.search(r"(\d{6,})", canonical)
                jobs.append({
                    "external_req_id": req_id.group(1) if req_id else canonical[-40:],
                    "company_name": company_name,
                    "title": title,
                    "normalized_title": normalize_title(title),
                    "location": location,
                    "normalized_location": norm_loc,
                    "department": record.get("industry"),
                    "description": description or title,
                    "description_hash": compute_description_hash(description or title),
                    "canonical_url": canonical,
                    "application_url": posting_url,
                    "source_ats": "browser_jsonld",
                    "salary_raw": salary_raw,
                    "salary_min": salary_min,
                    "salary_max": salary_max,
                    "posting_date": record.get("datePosted"),
                    "raw_source_data": {"source": "jobposting_jsonld", "url": posting_url},
                })
        except Exception as e:
            logger.debug(f"{company_name}: no usable JobPosting JSON-LD at {url}: {e}")
        finally:
            page.close()
        return jobs

    def _read_posting(self, context, url: str, canonical: str, company_name: str,
                      link_text: str = "") -> Optional[Dict[str, Any]]:
        page = context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(DETAIL_SETTLE_MS)
            body = page.inner_text("body")
            # Rippling's company biography can name a U.S. headquarters while this
            # particular vacancy is abroad. Prefer its explicit job location metadata.
            employer_locations = None
            if (urlparse(url).hostname or '').endswith('rippling.com'):
                try:
                    import json
                    data = json.loads(page.locator('script#__NEXT_DATA__').text_content(timeout=1000))
                    employer_locations = data['props']['pageProps']['apiData']['jobPost']['workLocations']
                except Exception:
                    employer_locations = []
            if re.search(r'page not found|this role does not exist or is no longer available', body, re.I):
                return None
            title = self._clean_title(link_text) or self._title_from_slug(canonical)
            if not title:
                for selector in ("h1", "h2"):
                    try:
                        candidate = self._clean_title(page.inner_text(selector, timeout=2000))
                    except Exception:
                        continue
                    if candidate:
                        title = candidate
                        break
        except Exception as e:
            logger.warning(f"{company_name}: could not read posting {url}: {str(e).splitlines()[0]}")
            return None
        finally:
            page.close()

        if not title or not body or len(body) < 200:
            return None

        description = re.sub(r"\n{3,}", "\n\n", body).strip()
        location = ('; '.join(employer_locations) if employer_locations is not None
                    else self._guess_location(description))
        norm_loc, _remote, _hybrid = normalize_location(location) if location else ("", False, False)
        sal_raw, sal_min, sal_max = extract_salary(description)
        if urlparse(url).hostname == 'jobs.apple.com' and sal_min is None:
            pay = re.search(r'base pay range.{0,100}?between\s*\$([\d,]+)\s+and\s*\$([\d,]+)', description, re.I)
            if pay:
                sal_raw, sal_min, sal_max = pay.group(0), float(pay[1].replace(',', '')), float(pay[2].replace(',', ''))
        req_id = re.search(r"(\d{6,})", canonical)

        return {
            "external_req_id": req_id.group(1) if req_id else canonical[-40:],
            "company_name": company_name,
            "title": title,
            "normalized_title": normalize_title(title),
            "location": location,
            "normalized_location": norm_loc,
            "department": None,
            "description": description,
            "description_hash": compute_description_hash(description),
            "canonical_url": canonical,
            "application_url": url,
            "source_ats": "browser",
            "salary_raw": sal_raw,
            "salary_min": sal_min,
            "salary_max": sal_max,
            "posting_date": None,
            "raw_source_data": {"source": "rendered", "url": url},
        }

    # Headings these sites put above the posting, which are not the job's title.
    CHROME_TITLES = {"jobs", "job details", "careers", "search", "results", "job search"}

    @classmethod
    def _clean_title(cls, text: str) -> str:
        first = (text or "").strip().splitlines()[0].strip() if (text or "").strip() else ""
        if not first or len(first) > 140 or first.lower() in cls.CHROME_TITLES:
            return ""
        return first

    @staticmethod
    def _title_from_slug(url: str) -> str:
        """Google writes the title into the URL; it is a better source than the page chrome."""
        m = re.search(r"/results/\d+-([a-z0-9-]+)", url)
        if not m:
            return ""
        return m.group(1).replace("-", " ").title()

    @staticmethod
    def _resolve(href: str, page_url: str) -> str:
        """Turn a listing href into the URL that actually serves the posting.

        Plain urljoin is wrong on Google: its links are relative to the applications root, so
        joining them against the results path doubles a segment and every fetch 404s.
        """
        host = urlparse(page_url).netloc.lower()
        if "google.com" in host:
            return urljoin("https://www.google.com/about/careers/applications/", href.lstrip("./"))
        return urljoin(page_url, href)

    def _pattern_for(self, url: str) -> str:
        host = urlparse(url).netloc.lower()
        for domain, pattern in self.LINK_PATTERNS.items():
            if domain in host:
                return pattern
        return self.GENERIC_PATTERN

    @staticmethod
    def launch_options(url):
        options = {'headless': True}
        if urlparse(url).hostname == 'jobs.apple.com':
            options['args'] = ['--disable-http2']
        return options

    @staticmethod
    def _configured_queries() -> List[str]:
        """Search the role titles the user actually curated, capped so a scan stays bounded."""
        try:
            from ..config import load_search_config
            titles = load_search_config().query_templates.get("role_titles") or []
        except Exception:
            titles = []
        return [t.lower() for t in titles[:6]] or ["mechanical engineer"]

    @staticmethod
    def _guess_location(text: str) -> str:
        """A city and state near the top of the posting, or nothing.

        A wrong location is worse than none: the ranker penalises postings it reads as being
        outside the US, so a bad guess would silently bury a good role.
        """
        head = text[:1200]
        m = re.search(r"\b([A-Z][A-Za-z.\- ]{2,24}),\s*(?:([A-Z]{2})|(California|Washington|Texas|"
                      r"New York|Massachusetts|Oregon|Colorado|Georgia|Illinois|Florida|Arizona|"
                      r"Michigan|Wisconsin|Pennsylvania|Virginia|Maryland|Ohio|Utah|Nevada|"
                      r"North Carolina|New Jersey|Minnesota|Tennessee|Missouri|Indiana))\b", head)
        return m.group(0).strip() if m else ""

    def fetch_job(self, target: Dict[str, Any], job_id: str) -> Optional[Dict[str, Any]]:
        return None

    def check_status(self, job_url: str) -> Tuple[bool, Optional[str]]:
        try:
            resp = self.get_with_retry(job_url, max_retries=2)
            if resp.status_code in (404, 410):
                return (False, f"HTTP {resp.status_code} Not Found")
        except Exception as e:
            logger.warning(f"Could not verify status of {job_url}: {e}")
        # These pages render their closure notice in JavaScript, so a fetch proves nothing more.
        return (True, None)
