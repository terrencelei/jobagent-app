"""Amazon job search scraper.

Amazon does not publish a board on any of the hosted ATSs, but amazon.jobs answers a plain
JSON search endpoint. Discovery is driven by the configured role titles rather than by a board
listing, because there is no board to list: the endpoint only answers queries.
"""

from datetime import datetime
import logging
from typing import Any, Dict, List, Optional, Tuple

from .base import BaseScraper
from ..processing.eligibility import clean_html_text
from ..processing.normalize import (
    canonicalize_url, compute_description_hash, extract_salary,
    normalize_location, normalize_title,
)

logger = logging.getLogger("jobagent.scrapers.amazon")


class AmazonScraper(BaseScraper):
    SEARCH_API = "https://www.amazon.jobs/en/search.json"
    PAGE_SIZE = 100
    # One query returns at most a few hundred rows, so the role titles are the unit of work.
    # Without a query list the target still yields something useful rather than nothing.
    DEFAULT_QUERIES = ["mechanical engineer", "robotics engineer", "hardware engineer"]

    def discover_jobs(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        company_name = target.get("name", "Amazon")
        queries = target.get("queries") or self._configured_queries()
        seen: Dict[str, Dict[str, Any]] = {}

        for query in queries:
            offset = 0
            while True:
                try:
                    resp = self.get_with_retry(self.SEARCH_API, params={
                        "base_query": query,
                        "result_limit": self.PAGE_SIZE,
                        "offset": offset,
                        "sort": "recent",
                    })
                except Exception as e:
                    self.last_error = str(e)
                    logger.warning(f"Amazon search failed for {query!r}: {e}")
                    break
                if resp.status_code != 200:
                    logger.warning(f"Amazon search {query!r} returned {resp.status_code}")
                    break
                try:
                    data = resp.json()
                except Exception:
                    logger.warning(f"Amazon search {query!r} returned non-JSON")
                    break

                jobs = data.get("jobs") or []
                for rj in jobs:
                    parsed = self._parse(rj, company_name)
                    if parsed:
                        # The same requisition answers several queries; keep it once.
                        seen.setdefault(parsed["external_req_id"], parsed)

                offset += self.PAGE_SIZE
                if len(jobs) < self.PAGE_SIZE or offset >= int(data.get("hits") or 0):
                    break

        return list(seen.values())

    def _configured_queries(self) -> List[str]:
        """Use the role titles the user curated; fall back if the config cannot be read."""
        try:
            from ..config import load_search_config
            titles = load_search_config().query_templates.get("role_titles") or []
        except Exception:
            titles = []
        return [t.lower() for t in titles[:8]] or self.DEFAULT_QUERIES

    def _parse(self, rj: Dict[str, Any], company_name: str) -> Optional[Dict[str, Any]]:
        req_id = str(rj.get("id_icims") or rj.get("id") or "").strip()
        title = (rj.get("title") or "").strip()
        if not req_id or not title:
            return None

        # Amazon splits the posting across three fields; the qualifications carry the
        # requirements an eligibility decision depends on, so all three are kept.
        parts = [rj.get("description") or ""]
        for heading, key in [('Basic Qualifications', 'basic_qualifications'), ('Preferred Qualifications', 'preferred_qualifications')]:
            if rj.get(key):
                parts.append(f'<h2>{heading}</h2>' + rj[key])
        description = clean_html_text("<br/><br/>".join(p for p in parts if p))

        job_path = rj.get("job_path") or f"/en/jobs/{req_id}"
        canonical_url = canonicalize_url(f"https://www.amazon.jobs{job_path}")
        location = rj.get("normalized_location") or rj.get("location") or ""
        norm_loc, _is_remote, _is_hybrid = normalize_location(location)
        sal_raw, sal_min, sal_max = extract_salary(description)

        post_date = None
        posted = rj.get("posted_date")
        if posted:
            try:
                post_date = datetime.strptime(posted, "%B %d, %Y")
            except Exception:
                pass

        return {
            "external_req_id": req_id,
            "company_name": company_name,
            "title": title,
            "normalized_title": normalize_title(title),
            "location": location,
            "normalized_location": norm_loc,
            "department": rj.get("job_category") or rj.get("job_family"),
            "description": description,
            "description_hash": compute_description_hash(description),
            "canonical_url": canonical_url,
            "application_url": rj.get("url_next_step") or canonical_url,
            "source_ats": "amazon",
            "salary_raw": sal_raw,
            "salary_min": sal_min,
            "salary_max": sal_max,
            "posting_date": post_date,
            "employment_type": rj.get("job_schedule_type"),
            "raw_source_data": rj,
        }

    def fetch_job(self, target: Dict[str, Any], job_id: str) -> Optional[Dict[str, Any]]:
        try:
            resp = self.get_with_retry(self.SEARCH_API, params={
                "base_query": job_id, "result_limit": 10})
            if resp.status_code != 200:
                return None
            for rj in resp.json().get("jobs") or []:
                if str(rj.get("id_icims")) == str(job_id):
                    return rj
        except Exception as e:
            logger.warning(f"Error fetching Amazon job {job_id}: {e}")
        return None

    def check_status(self, job_url: str) -> Tuple[bool, Optional[str]]:
        try:
            resp = self.get_with_retry(job_url, max_retries=2)
            if resp.status_code in (404, 410):
                return (False, f"HTTP {resp.status_code} Not Found")
            text = resp.text.lower()
            if "no longer accepting applications" in text or "job is no longer available" in text:
                return (False, "Explicit closure notice on page")
            return (True, None)
        except Exception as e:
            # A network problem is not evidence that a posting closed.
            logger.warning(f"Could not verify status of {job_url}: {e}")
            return (True, None)
