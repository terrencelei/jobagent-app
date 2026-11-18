"""Lever public postings scraper."""

from datetime import datetime, timezone
import logging
from typing import Any, Dict, List, Optional, Tuple

from ..processing.eligibility import clean_html_text
from .base import BaseScraper
from ..processing.normalize import canonicalize_url, compute_description_hash, extract_salary, normalize_location, normalize_text, normalize_title

logger = logging.getLogger("jobagent.scrapers.lever")


def lever_description(post):
    """Requirements live in lists, separately from the introductory description."""
    sections = [post.get("descriptionPlain") or clean_html_text(post.get("description", ""))]
    for section in post.get("lists", []):
        sections.append(section.get("text", "") + "\n" + clean_html_text(section.get("content", "")))
    sections.append(post.get("additionalPlain") or clean_html_text(post.get("additional", "")))
    return "\n\n".join(sections)


class LeverScraper(BaseScraper):
    BASE_API = "https://api.lever.co/v0/postings/{company}?mode=json"

    def discover_jobs(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        company_slug = target.get("company_slug") or target.get("board_token")
        company_name = target.get("name", company_slug)
        if not company_slug:
            logger.error(f"No company_slug provided for Lever company {company_name}")
            return []

        url = self.BASE_API.format(company=company_slug)
        try:
            resp = self.get_with_retry(url)
            if resp.status_code == 404:
                logger.warning(f"Lever board not found for: {company_slug}")
                return []
            if resp.status_code != 200:
                logger.warning(f"Failed to fetch Lever postings for {company_slug}: status {resp.status_code}")
                return []

            postings = resp.json()
            if not isinstance(postings, list):
                return []

            discovered = []
            for post in postings:
                job_id = post.get("id", "")
                title = post.get("text", "")
                full_desc = lever_description(post)

                categories = post.get("categories", {})
                loc_name = categories.get("location", "")
                norm_loc, is_remote, is_hybrid = normalize_location(loc_name)
                commitment = categories.get("commitment", "")
                team = categories.get("team") or categories.get("department")

                hosted_url = post.get("hostedUrl") or f"https://jobs.lever.co/{company_slug}/{job_id}"
                canonical_url = canonicalize_url(hosted_url)
                apply_url = post.get("applyUrl") or hosted_url

                sal_raw, sal_min, sal_max = extract_salary(full_desc)

                salary = post.get("salaryRange") or {}
                if salary.get("currency") == "USD" and salary.get("interval") in ("per-year", "year"):
                    sal_min, sal_max = salary.get("min"), salary.get("max")
                    sal_raw = f"${sal_min:,.0f} - ${sal_max:,.0f}" if sal_min is not None and sal_max is not None else sal_raw

                created_at_ms = post.get("createdAt")
                post_date = None
                if created_at_ms:
                    try:
                        post_date = datetime.fromtimestamp(created_at_ms / 1000.0, tz=timezone.utc)
                    except Exception:
                        pass

                parsed_job = {
                    "external_req_id": job_id,
                    "company_name": company_name,
                    "title": title,
                    "normalized_title": normalize_title(title),
                    "location": loc_name,
                    "normalized_location": norm_loc,
                    "department": team,
                    "employment_type": commitment,
                    "description": full_desc,
                    "description_hash": compute_description_hash(full_desc),
                    "canonical_url": canonical_url,
                    "application_url": apply_url,
                    "source_ats": "lever",
                    "salary_raw": sal_raw,
                    "salary_min": sal_min,
                    "salary_max": sal_max,
                    "posting_date": post_date,
                    "raw_source_data": post,
                }
                discovered.append(parsed_job)

            return discovered
        except Exception as e:
            self.last_error = str(e)
            logger.error(f"Error scraping Lever for {company_name}: {e}")
            return []

    def fetch_job(self, target: Dict[str, Any], job_id: str) -> Optional[Dict[str, Any]]:
        company_slug = target.get("company_slug") or target.get("board_token")
        if not company_slug:
            return None
        url = f"https://api.lever.co/v0/postings/{company_slug}/{job_id}"
        try:
            resp = self.get_with_retry(url)
            if resp.status_code == 200:
                return resp.json()
        except Exception as e:
            logger.warning(f"Error fetching Lever job {job_id}: {e}")
        return None

    def check_status(self, job_url: str) -> Tuple[bool, Optional[str]]:
        try:
            resp = self.get_with_retry(job_url, max_retries=2)
            if resp.status_code in (404, 410):
                return (False, f"HTTP {resp.status_code} Not Found")

            text = resp.text.lower()
            if "job is no longer available" in text or "posting has expired" in text:
                return (False, "Job expired or closed on Lever")

            return (True, None)
        except Exception as e:
            logger.warning(f"Lever status check network error for {job_url}: {e}")
            return (True, None)
