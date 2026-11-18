"""Direct company career site scraper for custom career portals."""

import logging
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup

from .base import BaseScraper
from ..processing.normalize import canonicalize_url, compute_description_hash, extract_salary, normalize_location, normalize_text, normalize_title

logger = logging.getLogger("jobagent.scrapers.company_sites")


NEWS_AND_NON_JOB_DOMAINS = {
    "businesswire.com", "prnewswire.com", "globenewswire.com", "yahoo.com",
    "finance.yahoo.com", "therobotreport.com", "robophil.com", "newsdirectory3.com",
    "desca.net", "calosba.ca.gov", "digitimes.com", "kark.com", "packagingtechtoday.com",
    "aktiensensor.com", "marketscale.com", "fortune.com", "bisnow.com",
    "huntsvillebusinessjournal.com", "science.report", "pv-magazine-australia.com",
    "lemob-news.com", "natlawreview.com", "timestech.in", "reuters.com",
    "bloomberg.com", "techcrunch.com", "forbes.com", "wsj.com", "nytimes.com",
    "medium.com", "youtube.com", "linkedin.com", "twitter.com", "x.com", "facebook.com",
    "instagram.com", "tiktok.com", "reddit.com", "cnbc.com", "marketwatch.com",
    "simplify.jobs",
}

NON_JOB_PATH_PATTERNS = (
    "/news/", "/news-releases/", "/press/", "/press-release", "/press-releases/",
    "/articles/", "/article/", "/blog/", "/blogs/", "/media/", "/story/", "/stories/",
    "/events/", "/webinar/", "/webinars/", "/podcast/", "/podcasts/", "/investors/",
    "/sec-filings/", "/about/", "/contact/", "/privacy/", "/terms/",
)

NON_JOB_HEADLINE_PHRASES = (
    "launches", "unveils", "announces", "secures", "raises", "partners with",
    "partner with", "acquires", "acquisition", "develops", "speaks on", "a day in the life",
    "learn about", "how to", "revenue", "quarter", "q1", "q2", "q3", "q4",
    "boosts share", "seed funding", "grant", "donation", "tested in", "layoffs",
    "webinar", "joins russell", "signs up to", "agreement with", "invests",
)


# Posting pages opened per source scan (setting scraping.direct_detail_limit), so eligibility can
# read the employer's actual requirements.


def posting_text(html: str) -> str:
    """Readable text of a job posting page, without scripts, navigation or footers."""
    soup = BeautifulSoup(html, "html.parser")
    for node in soup(["script", "style", "noscript", "svg", "nav", "header", "footer", "form"]):
        node.decompose()
    root = soup.find("main") or soup.find("article") or soup.body or soup
    lines = [normalize_text(line) for line in root.get_text("\n").splitlines()]
    return "\n".join(line for line in lines if line)[:20000]


class CompanyCareerScraper(BaseScraper):
    def _detail(self, url: str) -> Optional[str]:
        try:
            resp = self.get_with_retry(url, max_retries=2)
            text = posting_text(resp.text) if resp.status_code == 200 else ""
            return text if len(text) >= 400 else None
        except Exception as e:
            logger.warning(f"Could not read posting {url}: {e}")
            return None

    def discover_jobs(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        career_url = target.get("career_url", "")
        company_name = target.get("name", "Unknown")
        if not career_url:
            return []

        parsed_career = urlparse(career_url)
        career_domain = parsed_career.netloc.lower()
        if any(d in career_domain for d in NEWS_AND_NON_JOB_DOMAINS) or "simplify.jobs" in career_url:
            return []

        try:
            resp = self.get_with_retry(career_url)
            if resp.status_code != 200:
                logger.warning(f"Company career page {career_url} returned {resp.status_code}")
                return []

            soup = BeautifulSoup(resp.text, "html.parser")
            discovered = []
            links = soup.find_all("a", href=True)

            keywords = [
                "engineer", "mechanical", "hardware", "robotics", "mechatronics",
                "product design", "manufacturing", "test", "automation", "controls",
                "data", "analyst", "analytics", "statistic", "machine learning", "scientist",
            ]

            from ..settings import setting
            detail_limit = setting('scraping.direct_detail_limit')
            seen_urls = set()
            for a in links:
                text = normalize_text(a.get_text())
                href = a["href"].strip()
                full_url = urljoin(career_url, href)
                parsed_link = urlparse(full_url)
                link_domain = parsed_link.netloc.lower()
                link_path = parsed_link.path.lower()
                canonical = canonicalize_url(full_url)

                if canonical in seen_urls:
                    continue

                # Filter out news, press, blog, investor and external media sites
                if any(d in link_domain for d in NEWS_AND_NON_JOB_DOMAINS):
                    continue
                if any(p in link_path for p in NON_JOB_PATH_PATTERNS):
                    continue

                # Check text length and exclude news headline phrasing
                if len(text) <= 5 or len(text) >= 120:
                    continue
                text_lower = text.lower()
                if any(phrase in text_lower for phrase in NON_JOB_HEADLINE_PHRASES):
                    continue
                if "$" in text or "%" in text:
                    continue

                # Check if link text or href indicates an engineering role
                has_keyword = any(k in text_lower or k in href.lower() for k in keywords)
                if not has_keyword:
                    continue

                # Require link to look like a job listing path or role title
                has_job_path = any(jp in link_path for jp in ["/job", "/jobs", "/career", "/careers", "/position", "/openings", "/apply"])
                has_role_title = any(rt in text_lower for rt in ["engineer", "developer", "technician", "intern", "associate", "specialist", "designer", "scientist", "analyst", "statistician", "manager", "lead"])
                if not (has_job_path or has_role_title):
                    continue
                seen_urls.add(canonical)
                detail = self._detail(full_url) if len(seen_urls) <= detail_limit else None
                plain_desc = detail or f"{text} at {company_name}\nEmployer requirements not fetched."
                salary_raw, salary_min, salary_max = extract_salary(detail or "")
                norm_loc, is_remote, is_hybrid = normalize_location("United States")

                parsed_job = {
                    "external_req_id": canonical.split("/")[-1] or None,
                    "company_name": company_name,
                    "title": text,
                    "normalized_title": normalize_title(text),
                    "location": "United States",
                    "normalized_location": norm_loc,
                    "department": None,
                    "description": plain_desc,
                    "description_hash": compute_description_hash(plain_desc),
                    "canonical_url": canonical,
                    "application_url": canonical,
                    "source_ats": "direct_career_site",
                    "salary_raw": salary_raw,
                    "salary_min": salary_min,
                    "salary_max": salary_max,
                    "raw_source_data": {"url": full_url, "link_text": text, "detail_fetched": bool(detail)},
                }
                discovered.append(parsed_job)
            return discovered
        except Exception as e:
            self.last_error = str(e)
            logger.warning(f"Error scraping company career site {career_url}: {e}")
            return []

    def fetch_job(self, target: Dict[str, Any], job_id: str) -> Optional[Dict[str, Any]]:
        return None

    def check_status(self, job_url: str) -> Tuple[bool, Optional[str]]:
        try:
            resp = self.get_with_retry(job_url, max_retries=2)
            if resp.status_code in (404, 410):
                return (False, f"HTTP {resp.status_code} Not Found")
            return (True, None)
        except Exception as e:
            logger.warning(f"Status check failed for {job_url}: {e}")
            return (True, None)
