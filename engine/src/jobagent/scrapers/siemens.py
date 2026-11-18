"""Siemens public career search, including filtered searches and pagination."""

from datetime import datetime, timezone
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseScraper
from ..processing.eligibility import clean_html_text
from ..processing.normalize import (
    canonicalize_url, compute_description_hash, extract_salary,
    normalize_location, normalize_title,
)


class SiemensScraper(BaseScraper):
    ROOT = "https://jobs.siemens.com/en_US/externaljobs/"

    def discover_jobs(self, target):
        self.last_error = None
        jobs, seen_jobs, seen_pages = [], set(), set()
        page_url = target.get("career_url")
        if not page_url:
            self.last_error = "Missing Siemens career_url"
            return jobs
        try:
            while page_url:
                if page_url in seen_pages:
                    raise ValueError("Siemens pagination repeated a page")
                seen_pages.add(page_url)
                response = self.get_with_retry(page_url)
                response.raise_for_status()
                soup = BeautifulSoup(response.text, "html.parser")
                job_ids = []
                for link in soup.select("a[href]"):
                    url = urlparse(urljoin(page_url, link["href"]))
                    match = re.fullmatch(r"/en_US/externaljobs/JobDetail/(\d+)/?", url.path)
                    if url.hostname == "jobs.siemens.com" and match:
                        job_ids.append(match[1])
                if not job_ids and not re.search(r"(?:0\s+results|no (?:jobs|results|positions))", soup.get_text(" ", strip=True), re.I):
                    raise ValueError("Unrecognized Siemens search page: no job links or empty-results message")
                for job_id in job_ids:
                    if job_id in seen_jobs:
                        continue
                    seen_jobs.add(job_id)
                    job = self.fetch_job(target, job_id)
                    if job:
                        jobs.append(job)
                next_link = soup.find("a", attrs={"aria-label": re.compile(r"Go to Next Page", re.I)})
                page_url = urljoin(page_url, next_link["href"]) if next_link and next_link.get("href") else None
                if page_url and urlparse(page_url).hostname != "jobs.siemens.com":
                    raise ValueError("Unexpected Siemens pagination host")
        except Exception as exc:
            self.last_error = str(exc)
        return jobs

    def fetch_job(self, target, job_id):
        url = self.ROOT + "JobDetail/" + str(job_id)
        try:
            response = self.get_with_retry(url)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "html.parser")
            title_node = soup.select_one(".section__header__text__title")
            articles = soup.select("article.article--details")
            fields = {}
            for field in soup.select(".article__content__view__field"):
                label = field.select_one(".article__content__view__field__label")
                value = field.select_one(".article__content__view__field__value")
                if label and value:
                    fields[label.get_text(" ", strip=True)] = value.get_text("; ", strip=True)
            description = clean_html_text("\n".join(str(a) for a in articles))
            if not title_node or not description or fields.get("Job ID") != str(job_id):
                raise ValueError(f"Unrecognized Siemens job detail: {url}")
            title = title_node.get_text(" ", strip=True)
            location = fields.get("Location(s)", "")
            normalized_location, _, _ = normalize_location(location)
            salary_raw, salary_min, salary_max = extract_salary(description)
            posting_date = None
            if fields.get("Posted since"):
                try:
                    posting_date = datetime.strptime(fields["Posted since"], "%d-%b-%Y").replace(tzinfo=timezone.utc)
                except ValueError:
                    pass
            apply_link = soup.find("a", href=re.compile(r"/ApplicationMethods\?"))
            return {
                "external_req_id": str(job_id),
                "company_name": target.get("name", "Siemens"),
                "title": title,
                "normalized_title": normalize_title(title),
                "location": location,
                "normalized_location": normalized_location,
                "department": fields.get("Organization"),
                "description": description,
                "description_hash": compute_description_hash(description),
                "canonical_url": canonicalize_url(url),
                "application_url": urljoin(url, apply_link["href"]) if apply_link else url,
                "source_ats": "siemens",
                "salary_raw": salary_raw,
                "salary_min": salary_min,
                "salary_max": salary_max,
                "posting_date": posting_date,
                "raw_source_data": {"url": url, "fields": fields},
            }
        except Exception as exc:
            self.last_error = str(exc)
            return None

    def check_status(self, job_url):
        try:
            response = self.get_with_retry(job_url, max_retries=2)
            if response.status_code in (404, 410):
                return False, f"HTTP {response.status_code} Not Found"
            if response.status_code == 200:
                text = BeautifulSoup(response.text, "html.parser").get_text(" ", strip=True).lower()
                if any(notice in text for notice in (
                    "job is no longer available", "job is no longer open",
                    "no longer accepting applications", "posting has closed",
                )):
                    return False, "Explicit closure notice on Siemens page"
        except Exception:
            pass
        return True, None
