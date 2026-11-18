"""IBM's official careers search API, including full indexed job descriptions.

The public Careers search bundle uses appId=careers and scope=careers2. Its
`body` field is the full posting; `description` is only a truncated teaser.
No browser challenge or HTML-detail request is needed for discovery.
"""

from datetime import datetime, timezone
import re
import time
from urllib.parse import parse_qs, urlparse

import httpx

from .base import BaseScraper, ScrapingError
from ..processing.eligibility import clean_html_text
from ..processing.normalize import (
    canonicalize_url, compute_description_hash, extract_salary,
    normalize_location, normalize_title,
)


class IBMScraper(BaseScraper):
    API = "https://www-api.ibm.com/search/api/v2"
    FIELDS = ["title", "url", "description", "body", "date", "field_keyword_05",
              "field_keyword_08", "field_keyword_17", "field_keyword_18",
              "field_keyword_19", "field_text_01"]
    PAGE_SIZE = 100
    MAX_PAGES = 100

    def _search(self, target, offset=0, size=100, job_id=None):
        query = str(target.get("search") or parse_qs(urlparse(
            target.get("career_url", "")).query).get("q", [""])[0]).strip()
        must = []
        if job_id is not None:
            if not re.fullmatch(r"\d+", str(job_id)):
                raise ValueError("Invalid IBM job ID")
            must.append({"simple_query_string": {
                "query": str(job_id), "fields": ["field_text_01"]}})
        elif query:
            must.append({"simple_query_string": {
                "query": query, "fields": ["title", "body"]}})
        payload = {
            "appId": "careers", "scopes": ["careers2"],
            "query": {"bool": {"must": must}},
            "from": offset, "size": size, "lang": "zz", "cc": "us",
            # Stable unique ordering is essential: _doc order differs across
            # replicas and repeated IDs otherwise silently lose later postings.
            "_source": self.FIELDS, "sort": [{"_id": "asc"}],
        }
        # BaseScraper only has GET retry support. Match its domain-level rate
        # limiting and bounded transient retry policy for this public POST.
        response = None
        for attempt in range(3):
            self._wait_for_rate_limit("www-api.ibm.com")
            try:
                response = self.client.post(self.API, json=payload)
                if response.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(1.5 ** attempt)
                    continue
                response.raise_for_status()
                break
            except (httpx.RequestError, httpx.TimeoutException):
                if attempt == 2:
                    raise
                time.sleep(1.5 ** attempt)
        if response is None:
            raise ScrapingError("IBM API returned no response")
        data = response.json()
        if not isinstance(data, dict) or data.get("timed_out") or data.get("errors") or data.get("error"):
            raise ValueError("IBM search API failed or timed out")
        if data.get("_shards", {}).get("failed", 0):
            raise ValueError("IBM search API returned partial shard results")
        hits = data.get("hits")
        if not isinstance(hits, dict) or not isinstance(hits.get("hits"), list):
            raise ValueError("Unrecognized IBM search API schema")
        total = hits.get("total")
        if isinstance(total, dict):
            if total.get("relation") != "eq":
                raise ValueError("IBM API total is a lower bound; discovery would be incomplete")
            total = total.get("value")
        if not isinstance(total, int) or isinstance(total, bool) or total < 0:
            raise ValueError("Invalid IBM search result count")
        if len(hits["hits"]) > size or len(hits["hits"]) > total:
            raise ValueError("IBM search returned an inconsistent result count")
        rows = [self._normalize(hit, target) for hit in hits["hits"]]
        if total > offset and not rows:
            raise ValueError("IBM search returned an empty page before its advertised total")
        return rows, total

    @staticmethod
    def _job_id(url):
        parsed = urlparse(url)
        if parsed.hostname not in {"careers.ibm.com", "ibmglobal.avature.net"}:
            raise ValueError("Unexpected IBM job host")
        if not re.fullmatch(r"/(?:[a-z]{2}_[A-Z]{2}/)?careers/JobDetail/?", parsed.path):
            raise ValueError("Unexpected IBM job detail URL")
        job_id = parse_qs(parsed.query).get("jobId", [""])[0]
        if not re.fullmatch(r"\d+", job_id):
            raise ValueError("Missing IBM job ID")
        return job_id

    def _normalize(self, hit, target):
        source = hit.get("_source") if isinstance(hit, dict) else None
        if not isinstance(source, dict):
            raise ValueError("IBM search hit has no source")
        url = source.get("url")
        if not isinstance(url, str):
            raise ValueError("IBM search hit has no URL")
        job_id = self._job_id(url)
        if str(source.get("field_text_01")) != job_id:
            raise ValueError("IBM search hit ID does not match job URL")
        title, body = source.get("title"), source.get("body")
        if not isinstance(title, str) or not title.strip() or not isinstance(body, str) or not body.strip():
            raise ValueError(f"IBM job {job_id} lacks a title or full body")
        description = clean_html_text(body)
        location = str(source.get("field_keyword_19") or "").strip()
        country = str(source.get("field_keyword_05") or "").strip()
        if country and country.lower() not in location.lower():
            location = ", ".join(part for part in (location, country) if part)
        normalized_location, _, _ = normalize_location(location)
        salary_raw, salary_min, salary_max = extract_salary(description)
        date = None
        if source.get("date"):
            try:
                date = datetime.fromisoformat(str(source["date"]).replace("Z", "+00:00"))
                if date.tzinfo is None:
                    date = date.replace(tzinfo=timezone.utc)
            except ValueError:
                pass
        # IBM's own search script localizes these same exact detail routes.
        canonical = f"https://careers.ibm.com/en_US/careers/JobDetail?jobId={job_id}"
        return {
            "external_req_id": job_id, "company_name": target.get("name", "IBM"),
            "title": title.strip(), "normalized_title": normalize_title(title),
            "description": description, "description_hash": compute_description_hash(description),
            "location": location, "normalized_location": normalized_location,
            "department": source.get("field_keyword_08"),
            "canonical_url": canonicalize_url(canonical), "application_url": canonical,
            "source_ats": "ibm", "salary_raw": salary_raw,
            "salary_min": salary_min, "salary_max": salary_max, "posting_date": date,
            "raw_source_data": {"api": self.API, "source": source},
        }

    def probe(self, target):
        """Cheap schema-validated health check with genuine full descriptions."""
        return self._search(target, size=2)

    def discover_jobs(self, target):
        self.last_error = None
        jobs, seen = [], set()
        offset = 0
        try:
            for _ in range(self.MAX_PAGES):
                rows, total = self._search(target, offset=offset, size=self.PAGE_SIZE)
                new_rows = [row for row in rows if row["external_req_id"] not in seen]
                if rows and len(new_rows) != len(rows):
                    raise ValueError("IBM pagination repeated jobs; results may be incomplete")
                for row in new_rows:
                    seen.add(row["external_req_id"])
                    jobs.append(row)
                offset += len(rows)
                if offset >= total:
                    return jobs
            raise ValueError(f"IBM pagination truncated at {offset} of {total} jobs")
        except Exception as exc:
            self.last_error = str(exc)
        return jobs

    def fetch_job(self, target, job_id):
        try:
            rows, _ = self._search(target, size=2, job_id=job_id)
            return next((row for row in rows if row["external_req_id"] == str(job_id)), None)
        except Exception as exc:
            self.last_error = str(exc)
            return None

    def check_status(self, job_url):
        try:
            job_id = self._job_id(job_url)
            rows, _ = self._search({}, size=2, job_id=job_id)
            if any(row["external_req_id"] == job_id for row in rows):
                return True, None
            # An absent index hit alone does not prove the employer closed it.
            response = self.get_with_retry(job_url, max_retries=2)
            if response.status_code in (404, 410):
                return False, f"HTTP {response.status_code} on IBM job detail"
        except Exception:
            pass
        return True, None
