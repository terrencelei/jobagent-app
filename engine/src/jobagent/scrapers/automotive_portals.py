"""Public BMW Job Finder and Mercedes-Benz Beesite listings.

These are the endpoints called by the employers' own career-site JavaScript.
Listing shape/pagination failures remain errors, never evidence that jobs closed.
"""
import json
import re
from datetime import datetime, timezone
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup

from .base import BaseScraper
from ..processing.eligibility import clean_html_text
from ..processing.normalize import canonicalize_url, compute_description_hash, extract_salary, normalize_location, normalize_title


def _job(target, ats, req, title, location, description, url, apply_url=None, department=None, date=None, raw=None):
    if not str(req).strip() or not title or not description:
        raise ValueError(f"Incomplete {ats} job detail")
    salary_raw, salary_min, salary_max = extract_salary(description)
    return dict(external_req_id=str(req), company_name=target.get("name") or ("BMW" if ats == "bmw" else "Mercedes-Benz"),
                title=title, normalized_title=normalize_title(title), location=location,
                normalized_location=normalize_location(location)[0], description=description,
                description_hash=compute_description_hash(description), canonical_url=canonicalize_url(url),
                application_url=apply_url or url, source_ats=ats, department=department,
                salary_raw=salary_raw, salary_min=salary_min, salary_max=salary_max,
                posting_date=date, raw_source_data=raw or {})


def _date(value):
    try:
        return datetime.strptime(str(value), "%Y%m%d" if len(str(value)) == 8 else "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


class _PortalScraper(BaseScraper):
    PAGE_SIZE = 50
    MAX_PAGES = 200

    def discover_jobs(self, target):
        self.last_error = None
        jobs, seen = [], set()
        try:
            offset = 0
            for _ in range(self.MAX_PAGES):
                rows, total = self.search_page(target, offset)
                fresh = [r for r in rows if r["id"] not in seen]
                if offset < total and not fresh:
                    raise ValueError("Listing pagination repeated or stopped before reported total")
                for row in fresh:
                    seen.add(row["id"])
                    job = self.fetch_job(target, row["id"])
                    if job is None:
                        raise ValueError(self.last_error or f"Could not read detail {row['id']}")
                    jobs.append(job)
                offset += len(rows)
                if offset >= total:
                    return jobs
            raise ValueError("Listing pagination truncated at safety bound")
        except Exception as exc:
            self.last_error = str(exc)
            return jobs

    def probe(self, target):
        """Validate one real listing page and its first employer detail."""
        self.last_error = None
        rows, total = self.search_page(target, 0)
        if rows:
            detail = self.fetch_job(target, rows[0]["id"])
            if not detail:
                raise ValueError(self.last_error or "Could not verify first job detail")
            return [detail], total
        return [], total

    def check_status(self, job_url):
        try:
            response = self.get_with_retry(job_url, max_retries=2)
            if response.status_code in (404, 410):
                return False, f"HTTP {response.status_code} Not Found"
            if response.status_code == 200:
                soup = BeautifulSoup(response.text, "html.parser")
                # Ignore scripts/navigation, which often contain generic closure translations.
                for node in soup(["script", "style", "nav", "footer"]):
                    node.decompose()
                text = (soup.find("main") or soup).get_text(" ", strip=True)
                if re.search(r"(?:this (?:job|position|vacancy) is no longer (?:available|open)|no longer accepting applications|job posting has (?:closed|expired))", text, re.I):
                    return False, "Explicit employer posting closure notice"
        except Exception:
            pass
        return True, None


class BMWScraper(_PortalScraper):
    # The public AEM portal stalls on the global synthetic browser + JobAgent UA.
    # Use the HTTP library's honest native identifier for this portal.
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        import httpx
        self.client.headers["User-Agent"] = f"python-httpx/{httpx.__version__}"

    ROOT = "https://www.bmwgroup.jobs"

    def _search_config(self, target):
        url = target.get("career_url") or self.ROOT + "/us/en.html#location=US"
        parsed = urlparse(url)
        if parsed.hostname not in ("www.bmwgroup.jobs", "bmwgroup.jobs", "jobs.bmwgroup.com"):
            raise ValueError("Unexpected BMW career host")
        if parsed.hostname == "jobs.bmwgroup.com":
            url = self.ROOT + "/us/en.html#location=US"
        response = self.get_with_retry(url.split("#")[0])
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        component = soup.select_one("[data-jobfinder-path]")
        if not component:
            raise ValueError("BMW page has no Job Finder component")
        endpoint = url.split(".html")[0].split("?")[0] + component["data-jobfinder-path"]
        if urlparse(endpoint).hostname not in ("www.bmwgroup.jobs", "bmwgroup.jobs"):
            raise ValueError("Unexpected BMW listing endpoint")
        filters = parse_qs(urlparse(url).fragment)
        filter_search = ",".join(f"{key}_{value}" for key, values in filters.items() if key in ("location", "jobfield", "jobtype") for value in values)
        return endpoint, filter_search or "location_US", filters.get("fulltext", [""])[0]

    def search_page(self, target, offset=0):
        # Cache only endpoint configuration, not mutable employer search results.
        key = target.get("career_url", "")
        if getattr(self, "_config_key", None) != key:
            self._config = self._search_config(target)
            self._config_key = key
        endpoint, filters, query = self._config
        response = self.get_with_retry(endpoint, params={"rowIndex": offset, "blockCount": self.PAGE_SIZE, "filterSearch": filters, "textSearch": query})
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        table = soup.select_one(".grp-jobfinder__table[data-counter]")
        if not table or not str(table["data-counter"]).isdigit():
            raise ValueError("Unrecognized BMW listing response")
        rows = []
        for wrapper in table.select(".grp-jobfinder__wrapper[data-job-id]"):
            link = wrapper.select_one("a.grp-jobfinder__link-jobdescription[href]")
            req = wrapper["data-job-id"]
            if not req.isdigit() or not link or not link.get("aria-label"):
                raise ValueError("Malformed BMW listing row")
            rows.append({"id": req, "title": link["aria-label"], "url": urljoin(self.ROOT, link["href"])})
        total = int(table["data-counter"])
        if total and not rows:
            raise ValueError("BMW returned a nonempty total without rows")
        return rows, total

    def fetch_job(self, target, job_id):
        url = self.ROOT + f"/us/en/jobfinder/job-description-copy.{job_id}.html"
        try:
            if not str(job_id).isdigit():
                raise ValueError("Invalid BMW job identifier")
            response = self.get_with_retry(url)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "html.parser")
            root = soup.select_one('[itemtype="https://schema.org/JobPosting"]')
            title = root.select_one(".cmp-title__text-title1") if root else None
            description = root.select_one('[itemprop="description"]') if root else None
            req = root.select_one('[itemprop="identifier"]') if root else None
            if not title or not description or not req or req.get_text(strip=True) != str(job_id):
                raise ValueError("Unrecognized or mismatched BMW detail")
            location = root.select_one(".grp-jobdescription__jobLocation")
            department = root.select_one(".grp-jobdescription__jobField")
            apply = root.select_one("a.grp-jobdescription-apply-button[href]")
            date = root.select_one('[itemprop="datePosted"]')
            return _job(target, "bmw", job_id, title.get_text(" ", strip=True), location.get_text(" ", strip=True) if location else "",
                        clean_html_text(str(description)), url, urljoin(url, apply["href"]) if apply else url,
                        department.get_text(" ", strip=True) if department else None, _date(date.get_text(strip=True)) if date else None,
                        {"url": url, "detail_fetched": True})
        except Exception as exc:
            self.last_error = str(exc)
            return None


class MercedesScraper(_PortalScraper):
    API = "https://jobs.api.mercedes-benz.com/search"

    def _request(self, offset=0, criteria=None, count=None):
        payload = {"LanguageCode": "EN", "SearchParameters": {"FirstItem": offset + 1, "CountItem": count or self.PAGE_SIZE,
                   "Sort": [{"Criterion": "PublicationStartDate", "Direction": "DESC"}]},
                   "SearchCriteria": criteria if criteria is not None else [{"CriterionName": "PositionLocation.Country", "CriterionValue": ["475"]}]}
        response = self.get_with_retry(self.API, params={"data": json.dumps(payload)})
        response.raise_for_status()
        data = response.json().get("SearchResult")
        if not isinstance(data, dict) or not isinstance(data.get("SearchResultCountAll"), int) or not isinstance(data.get("SearchResultItems"), list):
            raise ValueError("Unrecognized Mercedes listing response")
        rows = []
        for item in data["SearchResultItems"]:
            row = item.get("MatchedObjectDescriptor", {})
            if not str(row.get("ID", "")).isdigit() or not row.get("PositionTitle") or urlparse(row.get("PositionURI", "")).hostname != "jobs.mercedes-benz.com":
                raise ValueError("Malformed Mercedes listing row")
            rows.append(row)
        if data["SearchResultCountAll"] and not rows:
            raise ValueError("Mercedes returned nonempty total without rows")
        return rows, data["SearchResultCountAll"]

    def search_page(self, target, offset=0):
        # enUS is the US career portal. Preserve its country scope across every page.
        rows, total = self._request(offset)
        if offset == 0:
            self._listing_rows = {}
        self._listing_rows.update({str(row["ID"]): row for row in rows})
        return [{"id": str(row["ID"]), "title": row["PositionTitle"], "url": row["PositionURI"]} for row in rows], total

    def fetch_job(self, target, job_id):
        try:
            if not re.fullmatch(r"(?:\d+|[Mm][Ee][Rr][A-Za-z0-9]+)", str(job_id)):
                raise ValueError("Invalid Mercedes job identifier")
            field = "ID" if str(job_id).isdigit() else "PositionID"
            cached = getattr(self, "_listing_rows", {}).get(str(job_id))
            if cached:
                rows, total = [cached], 1
            else:
                rows, total = self._request(criteria=[{"CriterionName": field, "CriterionValue": str(job_id)}], count=1)
            if total != 1 or len(rows) != 1 or str(rows[0].get(field, "")).lower() != str(job_id).lower():
                raise ValueError("Missing or mismatched Mercedes job detail")
            row = rows[0]
            descriptions = row.get("PositionFormattedDescription") or []
            description = clean_html_text("\n".join(str(value) for part in descriptions if isinstance(part, dict) for value in part.values() if isinstance(value, str)))
            locations = row.get("PositionLocation") or []
            location = "; ".join(", ".join(filter(None, [part.get("CityName"), part.get("CountryName")])) for part in locations)
            apply = row.get("ApplyURI") or []
            return _job(target, "mercedes", row.get("PositionID") or job_id, row["PositionTitle"], location, description,
                        row["PositionURI"], apply[0] if apply else None, row.get("DepartmentName"), _date(row.get("PublicationStartDate")), row)
        except Exception as exc:
            self.last_error = str(exc)
            return None
