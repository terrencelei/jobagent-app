"""Rivian's public Jibe search API, including full descriptions and pagination."""

from datetime import datetime
import re
from urllib.parse import urlparse

from .base import BaseScraper
from ..processing.eligibility import clean_html_text
from ..processing.normalize import (
    canonicalize_url, compute_description_hash, extract_salary,
    normalize_location, normalize_title,
)


class RivianScraper(BaseScraper):
    API = "https://careers.rivian.com/api/jobs"
    PAGE_SIZE = 100
    MAX_PAGES = 100

    def search_page(self, target, page=1, *, keywords=None):
        # The target's employer search filters must survive pagination.
        from urllib.parse import parse_qs
        query = parse_qs(urlparse(target.get("career_url") or "").query)
        params = {k: v[-1] for k, v in query.items() if k not in {"page", "limit"}}
        params.update(page=page, limit=self.PAGE_SIZE)
        if keywords is not None:
            params["keywords"] = keywords
        response = self.get_with_retry(self.API, params=params)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("jobs"), list):
            raise ValueError("Unrecognized Rivian search schema")
        total = payload.get("totalCount")
        if isinstance(total, bool) or not isinstance(total, int) or total < 0:
            raise ValueError("Rivian search missing valid totalCount")
        rows = []
        for item in payload["jobs"]:
            data = item.get("data") if isinstance(item, dict) else None
            if not isinstance(data, dict) or not data.get("req_id") or not data.get("title"):
                raise ValueError("Rivian search contains malformed job record")
            if not data.get("description"):
                raise ValueError("Rivian search job lacks full description")
            rows.append(data)
        if not rows and total:
            raise ValueError("Rivian search returned empty page before totalCount")
        return rows, total

    def probe(self, target):
        rows, total = self.search_page(target)
        return [job for row in rows if (job := self._parse(target, row))], total

    def discover_jobs(self, target):
        self.last_error = None
        found, seen, received = [], set(), 0
        try:
            for page in range(1, self.MAX_PAGES + 1):
                rows, total = self.search_page(target, page)
                new_ids = {str(row["req_id"]) for row in rows} - seen
                if not new_ids and rows:
                    raise ValueError("Rivian pagination repeated a page")
                received += len(rows)
                for row in rows:
                    job_id = str(row["req_id"])
                    if job_id not in seen:
                        seen.add(job_id)
                        job = self._parse(target, row)
                        if job:
                            found.append(job)
                if received >= total:
                    break
            else:
                raise ValueError(f"Rivian search truncated after {self.MAX_PAGES} pages")
        except Exception as exc:
            self.last_error = str(exc)
        return found

    def fetch_job(self, target, job_id):
        self.last_error = None
        try:
            # Jibe has no /api/jobs/{id} route. Search by ID then match it exactly:
            # keyword search can return other jobs mentioning the same number.
            rows, _ = self.search_page({}, keywords=str(job_id))
            for row in rows:
                if str(row["req_id"]) == str(job_id):
                    return self._parse(target, row)
        except Exception as exc:
            self.last_error = str(exc)
        return None

    def _parse(self, target, data):
        if data.get("searchable") is False or data.get("applyable") is False:
            return None
        job_id = str(data["req_id"])
        description = clean_html_text(data["description"])
        for key in ("responsibilities", "qualifications"):
            section = clean_html_text(data.get(key) or "")
            if section and section not in description:
                description += f"\n\n{key.title()}\n{section}"
        location = data.get("full_location") or ", ".join(
            str(data[k]) for k in ("city", "state", "country") if data.get(k))
        normalized, _, _ = normalize_location(location)
        salary_raw, salary_min, salary_max = extract_salary(description)
        posted = None
        if data.get("posted_date"):
            try:
                posted = datetime.fromisoformat(data["posted_date"].replace("Z", "+00:00"))
            except ValueError:
                pass
        url = f"https://careers.rivian.com/careers-home/jobs/{job_id}"
        categories = data.get("categories") or []
        return {
            "external_req_id": job_id, "company_name": target.get("name", "Rivian"),
            "title": data["title"], "normalized_title": normalize_title(data["title"]),
            "location": location, "normalized_location": normalized,
            "department": "; ".join(c["name"] for c in categories if isinstance(c, dict) and c.get("name")) or None,
            "employment_type": data.get("employment_type"),
            "description": description, "description_hash": compute_description_hash(description),
            "canonical_url": canonicalize_url(url), "application_url": data.get("apply_url") or url,
            "source_ats": "rivian", "salary_raw": salary_raw, "salary_min": salary_min,
            "salary_max": salary_max, "posting_date": posted, "raw_source_data": data,
        }

    def check_status(self, job_url):
        match = re.search(r"/jobs/(\d+)", urlparse(job_url).path)
        if not match:
            return True, None
        try:
            rows, total = self.search_page({}, keywords=match[1])
            exact = [row for row in rows if str(row["req_id"]) == match[1]]
            if exact:
                if exact[0].get("applyable") is False or exact[0].get("searchable") is False:
                    return False, "Rivian API explicitly marks the requisition unavailable"
                return True, None
            # Absence from keyword search is not an explicit employer closure notice.
        except Exception:
            pass
        return True, None
