"""Ashby public job board scraper."""

from datetime import datetime, timezone
import logging
from typing import Any, Dict, List, Optional, Tuple

from ..processing.eligibility import clean_html_text
from .base import BaseScraper
from ..processing.normalize import canonicalize_url, compute_description_hash, extract_salary, normalize_location, normalize_text, normalize_title

logger = logging.getLogger("jobagent.scrapers.ashby")


class AshbyScraper(BaseScraper):
    BASE_API = "https://api.ashbyhq.com/posting-api/job-board/{company}"

    def discover_jobs(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        company_slug = target.get("company_slug") or target.get("board_token")
        company_name = target.get("name", company_slug)
        if not company_slug:
            logger.error(f"No company_slug provided for Ashby company {company_name}")
            return []

        url = self.BASE_API.format(company=company_slug)
        try:
            resp = self.get_with_retry(url, params={"includeCompensation": "true"})
            if resp.status_code == 404:
                logger.warning(f"Ashby board not found for: {company_slug}")
                return []
            if resp.status_code != 200:
                logger.warning(f"Failed to fetch Ashby jobs for {company_slug}: status {resp.status_code}")
                return []

            data = resp.json()
            jobs = data.get("jobs", [])
            discovered = []

            for rj in jobs:
                if rj.get("isListed") is False:
                    continue
                job_id = str(rj.get("id") or rj.get("jobUrl", "").rstrip("/").split("/")[-1])
                title = rj.get("title", "")
                desc_html = rj.get("descriptionHtml", "")
                full_desc = clean_html_text(desc_html or rj.get("descriptionPlain", ""))

                loc_name = rj.get("location") or rj.get("locationName", "")
                norm_loc, is_remote, is_hybrid = normalize_location(loc_name)
                job_url = rj.get("jobUrl") or f"https://jobs.ashbyhq.com/{company_slug}/{job_id}"
                canonical_url = canonicalize_url(job_url)

                # Salary
                sal_raw, sal_min, sal_max = extract_salary(full_desc)
                comp = rj.get("compensation")
                if comp and isinstance(comp, dict):
                    comp_min = comp.get("minCompensation")
                    comp_max = comp.get("maxCompensation")
                    if comp_min or comp_max:
                        sal_min = float(comp_min) if comp_min else sal_min
                        sal_max = float(comp_max) if comp_max else sal_max
                        sal_raw = f"${int(sal_min):,} - ${int(sal_max):,}" if sal_min and sal_max else sal_raw

                if isinstance(comp, dict):
                    salary_components = [c for c in comp.get("summaryComponents", [])
                                         if c.get("compensationType") == "Salary" and c.get("currencyCode") == "USD" and c.get("interval") == "1 YEAR"]
                    if salary_components:
                        component = salary_components[0]
                        sal_min, sal_max = component.get("minValue"), component.get("maxValue")
                        sal_raw = comp.get("scrapeableCompensationSalarySummary") or comp.get("compensationTierSummary") or sal_raw

                published_at = rj.get("publishedAt")
                post_date = None
                if published_at:
                    try:
                        post_date = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                    except Exception:
                        pass

                parsed_job = {
                    "external_req_id": job_id,
                    "company_name": company_name,
                    "title": title,
                    "normalized_title": normalize_title(title),
                    "location": loc_name,
                    "normalized_location": norm_loc,
                    "department": rj.get("department"),
                    "employment_type": rj.get("employmentType"),
                    "description": full_desc,
                    "description_hash": compute_description_hash(full_desc),
                    "canonical_url": canonical_url,
                    "application_url": rj.get("applyUrl") or canonical_url,
                    "source_ats": "ashby",
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
            logger.error(f"Error scraping Ashby for {company_name}: {e}")
            return []

    def fetch_job(self, target: Dict[str, Any], job_id: str) -> Optional[Dict[str, Any]]:
        return None

    def check_status(self, job_url: str) -> Tuple[bool, Optional[str]]:
        try:
            resp = self.get_with_retry(job_url, max_retries=2)
            if resp.status_code in (404, 410):
                return (False, f"HTTP {resp.status_code} Not Found")

            text = resp.text.lower()
            if "job is no longer available" in text or "position closed" in text:
                return (False, "Job expired or closed on Ashby")

            return (True, None)
        except Exception as e:
            logger.warning(f"Ashby status check network error for {job_url}: {e}")
            return (True, None)
