"""Greenhouse public board scraper."""

from datetime import datetime, timezone
import logging
from typing import Any, Dict, List, Optional, Tuple
from bs4 import BeautifulSoup
import httpx

from ..processing.eligibility import clean_html_text
from .base import BaseScraper, ScrapingError
from ..processing.normalize import canonicalize_url, compute_description_hash, extract_salary, normalize_location, normalize_text, normalize_title

logger = logging.getLogger("jobagent.scrapers.greenhouse")



def office_location(name, offices):
    """A bare city ("San Mateo", Skild AI 2026-11-01) is not a confirmed U.S. location; the job's office with the
    same name carries the full one ("San Mateo, California, United States"). Only a matching office is used."""
    from ..processing.us_locations import is_us_location
    if not name or is_us_location(name):
        return name
    key = ' '.join(name.split()).casefold()
    for office in offices or []:
        full = (office or {}).get('location') or ''
        if ' '.join(str((office or {}).get('name') or '').split()).casefold() == key and is_us_location(full):
            return full
    return name

class GreenhouseScraper(BaseScraper):
    BASE_API = "https://boards-api.greenhouse.io/v1/boards/{board}/jobs"

    def discover_jobs(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        board_token = target.get("board_token") or target.get("company_slug")
        company_name = target.get("name", board_token)
        if not board_token:
            logger.error(f"No board_token provided for company {company_name}")
            return []

        api_url = self.BASE_API.format(board=board_token)
        try:
            resp = self.get_with_retry(api_url, params={"content": "true"})
            if resp.status_code == 404:
                logger.warning(f"Greenhouse board not found: {board_token}")
                return []
            if resp.status_code != 200:
                logger.warning(f"Failed to fetch Greenhouse board {board_token}: status {resp.status_code}")
                return []

            data = resp.json()
            raw_jobs = data.get("jobs", [])
            discovered = []

            for rj in raw_jobs:
                job_id = str(rj.get("id"))
                title = rj.get("title", "")
                content_html = rj.get("content", "")
                plain_desc = clean_html_text(content_html)
                canonical_url = canonicalize_url(rj.get("absolute_url") or f"https://boards.greenhouse.io/{board_token}/jobs/{job_id}")

                loc_info = rj.get("location", {})
                loc_name = loc_info.get("name") if isinstance(loc_info, dict) else str(loc_info or "")
                loc_name = office_location(loc_name, rj.get("offices"))
                norm_loc, is_remote, is_hybrid = normalize_location(loc_name)

                # Requisition ID
                internal_code = rj.get("requisition_id") or job_id

                # Salary
                sal_raw, sal_min, sal_max = extract_salary(plain_desc)

                # Updated date
                updated_at_str = rj.get("first_published")
                post_date = None
                if updated_at_str:
                    try:
                        post_date = datetime.fromisoformat(updated_at_str.replace("Z", "+00:00"))
                    except Exception:
                        pass

                parsed_job = {
                    "external_req_id": str(internal_code),
                    "company_name": company_name,
                    "title": title,
                    "normalized_title": normalize_title(title),
                    "location": loc_name,
                    "normalized_location": norm_loc,
                    "department": (rj.get("departments") or [{}])[0].get("name") if rj.get("departments") else None,
                    "description": plain_desc,
                    "description_hash": compute_description_hash(plain_desc),
                    "canonical_url": canonical_url,
                    "application_url": canonical_url,
                    "source_ats": "greenhouse",
                    "salary_raw": sal_raw,
                    "salary_min": sal_min,
                    "salary_max": sal_max,
                    "posting_date": post_date,
                    "raw_source_data": rj,
                }
                discovered.append(parsed_job)

            return discovered
        except Exception as e:
            self.last_error = str(e)
            logger.error(f"Error scraping Greenhouse for {company_name}: {e}")
            return []

    def fetch_job(self, target: Dict[str, Any], job_id: str) -> Optional[Dict[str, Any]]:
        board_token = target.get("board_token") or target.get("company_slug")
        if not board_token:
            return None
        url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}"
        try:
            resp = self.get_with_retry(url)
            if resp.status_code == 200:
                return resp.json()
        except Exception as e:
            logger.warning(f"Error fetching Greenhouse job {job_id}: {e}")
        return None

    def check_status(self, job_url: str) -> Tuple[bool, Optional[str]]:
        """
        Check if job is active.
        Returns: (is_active, closure_evidence)
        """
        try:
            resp = self.get_with_retry(job_url, max_retries=2)
            if resp.status_code in (404, 410):
                return (False, f"HTTP {resp.status_code} Not Found")

            text = resp.text.lower()
            if "job is no longer available" in text or "posting has closed" in text or "no longer accepting applications" in text:
                return (False, "Explicit closure notice on page")

            return (True, None)
        except Exception as e:
            # Temporary error: never mark closed on transient errors!
            logger.warning(f"Could not verify status of {job_url} due to network issue: {e}")
            return (True, None)
