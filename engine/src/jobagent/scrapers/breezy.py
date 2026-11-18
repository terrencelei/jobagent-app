"""Breezy HR public job board scraper (https://{company}.breezy.hr)."""

from datetime import datetime
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

from ..processing.eligibility import clean_html_text
from .base import BaseScraper
from ..processing.normalize import canonicalize_url, compute_description_hash, extract_salary, normalize_location, normalize_title

logger = logging.getLogger("jobagent.scrapers.breezy")


def breezy_description(html: str) -> str:
    """The posting page carries the full text as schema.org JobPosting, with the visible body as a fallback."""
    soup = BeautifulSoup(html, "html.parser")
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            data = json.loads(script.string or "")
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("@type") == "JobPosting" and data.get("description"):
            return clean_html_text(data["description"])
    body = soup.select_one(".description")
    return clean_html_text(str(body)) if body else ""


class BreezyScraper(BaseScraper):
    BASE_URL = "https://{company}.breezy.hr"

    def _description(self, url: str) -> str:
        try:
            resp = self.get_with_retry(url, max_retries=2)
            if resp.status_code == 200:
                return breezy_description(resp.text)
        except Exception as e:
            logger.warning(f"Error fetching Breezy posting {url}: {e}")
        return ""

    def discover_jobs(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        company_slug = target.get("company_slug") or target.get("board_token")
        company_name = target.get("name", company_slug)
        if not company_slug:
            logger.error(f"No company_slug provided for Breezy company {company_name}")
            return []

        url = self.BASE_URL.format(company=company_slug) + "/json"
        try:
            resp = self.get_with_retry(url)
            if resp.status_code != 200:
                logger.warning(f"Failed to fetch Breezy postings for {company_slug}: status {resp.status_code}")
                return []
            postings = resp.json()
            if not isinstance(postings, list):
                return []

            discovered = []
            for post in postings:
                job_id = post.get("id", "")
                title = post.get("name", "")
                hosted_url = post.get("url") or f"{self.BASE_URL.format(company=company_slug)}/p/{post.get('friendly_id', job_id)}"
                full_desc = self._description(hosted_url)

                location = post.get("location") or {}
                loc_name = location.get("name", "")
                if location.get("is_remote") and "remote" not in loc_name.lower():
                    loc_name = f"{loc_name} (Remote)" if loc_name else "Remote"
                norm_loc, _, _ = normalize_location(loc_name)

                sal_raw, sal_min, sal_max = extract_salary(post.get("salary") or "")
                if sal_min is None:
                    sal_raw, sal_min, sal_max = extract_salary(full_desc)

                post_date = None
                if post.get("published_date"):
                    try:
                        post_date = datetime.fromisoformat(post["published_date"].replace("Z", "+00:00"))
                    except ValueError:
                        pass

                discovered.append({
                    "external_req_id": job_id,
                    "company_name": company_name,
                    "title": title,
                    "normalized_title": normalize_title(title),
                    "location": loc_name,
                    "normalized_location": norm_loc,
                    "department": post.get("department"),
                    "employment_type": (post.get("type") or {}).get("name"),
                    "description": full_desc,
                    "description_hash": compute_description_hash(full_desc),
                    "canonical_url": canonicalize_url(hosted_url),
                    "application_url": hosted_url.rstrip("/") + "/apply",
                    "source_ats": "breezy",
                    "salary_raw": sal_raw,
                    "salary_min": sal_min,
                    "salary_max": sal_max,
                    "posting_date": post_date,
                    "raw_source_data": post,
                })
            return discovered
        except Exception as e:
            self.last_error = str(e)
            logger.error(f"Error scraping Breezy for {company_name}: {e}")
            return []

    def fetch_job(self, target: Dict[str, Any], job_id: str) -> Optional[Dict[str, Any]]:
        company_slug = target.get("company_slug") or target.get("board_token")
        if not company_slug:
            return None
        try:
            resp = self.get_with_retry(self.BASE_URL.format(company=company_slug) + "/json")
            if resp.status_code == 200:
                return next((p for p in resp.json() if p.get("id") == job_id), None)
        except Exception as e:
            logger.warning(f"Error fetching Breezy job {job_id}: {e}")
        return None

    def check_status(self, job_url: str) -> Tuple[bool, Optional[str]]:
        try:
            resp = self.get_with_retry(job_url, max_retries=2)
            if resp.status_code in (404, 410):
                return (False, f"HTTP {resp.status_code} Not Found")
            # A closed posting redirects to the board's home page instead of returning 404.
            if resp.status_code == 200 and "/p/" not in str(resp.url):
                return (False, "Posting redirects to the Breezy board home page")
            return (True, None)
        except Exception as e:
            logger.warning(f"Breezy status check network error for {job_url}: {e}")
            return (True, None)
