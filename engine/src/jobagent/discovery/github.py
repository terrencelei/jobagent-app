"""Read curated GitHub job lists as leads, never as verified employer requirements."""

import re
from datetime import datetime, timezone
from html import unescape
from urllib.parse import quote, urlparse

from bs4 import BeautifulSoup

from ..config import GitHubSource
from ..processing.normalize import canonicalize_url, normalize_title
from ..processing.qualifications import SENIOR_PATTERN, is_early_career
from ..processing.eligibility import clean_html_text
from ..processing.normalize import extract_salary
from ..scrapers.base import BaseScraper


def cell_text(value):
    value = re.sub(r"<br\s*/?>", ", ", value, flags=re.I)
    value = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", value)
    return BeautifulSoup(value, "html.parser").get_text(" ", strip=True).replace("**", "").strip()


def application_links(value):
    links = [a["href"] for a in BeautifulSoup(value, "html.parser").find_all("a", href=True)]
    links += re.findall(r"\]\((https?://\S+?)\)(?=\s|$)", value)
    return [unescape(link) for link in links if urlparse(link).scheme in ("http", "https")]


def markdown_rows(text):
    """Read named table columns, including HTML apply buttons and continuation employers."""
    headers, company = [], ""
    headings = {}
    details = []
    for line in text.splitlines():
        heading = re.match(r"^(#{1,6})\s+(.*)", line)
        if heading:
            level = len(heading[1])
            headings = {k: v for k, v in headings.items() if k < level}
            headings[level] = cell_text(heading[2])
            headers, company = [], ""
        if "<details" in line:
            details.append("")
            headers, company = [], ""
        if "<summary" in line and details:
            details[-1] = cell_text(line)
        if "</details>" in line:
            if details:
                details.pop()
            headers, company = [], ""
            continue
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip().replace(r"\|", "|") for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
        names = [cell_text(c).lower() for c in cells]
        if "company" in names and any(n in names for n in ("role", "position", "title")):
            headers, company = names, ""
            continue
        if not headers or len(cells) != len(headers) or all(re.fullmatch(r"[:\-\s]+", c) for c in cells):
            continue
        row = dict(zip(headers, cells))
        context = " / ".join([*headings.values(), *details])
        section = details[-1] if details else headings.get(max(headings, default=0), "")
        if re.search(r"\b(inactive|archived?|closed|international)\b", context, re.I):
            continue
        if re.search(r"\binternships\b", section, re.I) and not re.search(r"new.grad", section, re.I):
            continue
        raw_company = cell_text(row["company"])
        if raw_company and raw_company not in ("↳", "↪", "↑", '"', "—"):
            company = raw_company.lstrip("↳↪ ")
        title = cell_text(row.get("role", row.get("position", row.get("title", ""))))
        apply = next((row[k] for k in ("application/link", "application", "apply", "posting", "link") if k in row), "")
        if not company or "🔒" in line or re.search(r"\bclosed\b|<del>|~~", apply, re.I):
            continue
        links = application_links(apply)
        # Prefer the employer over a companion auto-apply link.
        links.sort(key=lambda u: urlparse(u).hostname in ("simplify.jobs", "www.simplify.jobs"))
        if not links:
            continue
        yield {"company_name": company, "title": title, "url": links[0],
               "locations": cell_text(row.get("location", row.get("locations", ""))),
               "category": context, "posted_label": cell_text(row.get("posted", row.get("age", "")))}


def relevant_title(title):
    """Roles either search track could want: mechanical/robotics engineering or statistics/data science."""
    if re.search(SENIOR_PATTERN, title) or re.search(r"\b(manager|supervisor|intern(?:ship)?|co[- ]?op|technician|operator)\b", title, re.I):
        return False
    if re.search(r"\b(front.?end|back.?end|full.?stack|software|business systems|IT systems|network|cyber|sales|recruiter)\b", title, re.I):
        return False
    # Titles either search track (config/tracks.yaml) could want; each track judges them afterwards.
    from ..processing.tracks import discovery_title_pattern
    return bool(re.search(rf"\b(?:{discovery_title_pattern()})\b", title, re.I))


def detect_ats(url):
    host = (urlparse(url).hostname or "").lower()
    for domain, ats in (("greenhouse.io", "greenhouse"), ("lever.co", "lever"),
                        ("ashbyhq.com", "ashby"), ("breezy.hr", "breezy"), ("myworkdayjobs.com", "workday"),
                        ("icims.com", "icims"), ("oraclecloud.com", "oracle")):
        if host == domain or host.endswith("." + domain):
            return ats
    return "direct"


class GitHubJobsScraper(BaseScraper):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.boards = {}

    def discover_jobs(self, target):
        source = target if isinstance(target, GitHubSource) else GitHubSource(**target)
        self.last_error, self.truncated, self.warnings = None, False, []
        repository_url = f"https://github.com/{source.repository}"
        path = quote(source.path, safe="/")
        raw_url = f"https://raw.githubusercontent.com/{source.repository}/{quote(source.ref, safe='')}/{path}"
        source_url = f"{repository_url}/blob/{quote(source.ref, safe='')}/{path}"
        jobs, seen = [], set()
        try:
            response = self.get_with_retry(raw_url)
            response.raise_for_status()
            if source.format == "simplify_json":
                items = response.json()
                if not isinstance(items, list):
                    raise ValueError("Expected a JSON list of job records")
            else:
                items = list(markdown_rows(response.text))
                if not items:
                    raise ValueError("No readable job table; repository format may have changed")
            # Spend bounded employer requests on explicit entry-level roles first.
            items = sorted((i for i in items if isinstance(i, dict)),
                           key=lambda i: not is_early_career(i.get("title") or ""))
            for item in items:
                if not isinstance(item, dict) or item.get("active") is False or item.get("is_visible") is False:
                    continue
                title = item.get("title") or ""
                company = item.get("company_name") or ""
                url = item.get("url") or ""
                if not company or not relevant_title(title) or not self.valid_job_url(url):
                    continue
                if len(jobs) >= source.max_jobs:
                    self.truncated = True
                    break
                if urlparse(url).hostname in source.resolve_redirect_hosts:
                    try:
                        resolved = self.get_with_retry(url, max_retries=1)
                        final_url = str(resolved.url)
                        if urlparse(final_url).hostname in source.resolve_redirect_hosts or not self.valid_job_url(final_url):
                            raise ValueError("No employer redirect available")
                        if resolved.status_code in (404, 410):
                            raise ValueError("Employer link reports a removed posting")
                        # A blocked employer page can still supply its canonical link.
                        # Keep that lead unverified instead of mistaking HTTP 403 for closure.
                        url = final_url
                    except Exception:
                        self.warnings.append(f"Could not resolve employer link for {company}: {title}")
                        continue
                canonical = canonicalize_url(url)
                if canonical in seen:
                    continue
                seen.add(canonical)
                locations = item.get("locations") or ""
                location = ", ".join(locations) if isinstance(locations, list) else str(locations)
                degrees = item.get("degrees") or []
                degree_text = ", ".join(degrees) if isinstance(degrees, list) else str(degrees)
                desc = f"Position: {title}\nCompany: {company}\nLocations: {location}\n"
                if degree_text:
                    desc += f"Target Degree Level: {degree_text}\n"
                desc += f"Source: GitHub job list ({source.repository})\nEmployer requirements not fetched.\nOfficial application link: {url}"
                posting_date = None
                # Relative README ages and commit times are not employer posting dates.
                if isinstance(item.get("date_posted"), (int, float)):
                    try:
                        posting_date = datetime.fromtimestamp(item["date_posted"], tz=timezone.utc)
                    except (ValueError, OverflowError, OSError):
                        pass
                jobs.append({
                    "company_name": company, "title": title, "normalized_title": normalize_title(title),
                    "location": location, "description": desc, "source_ats": detect_ats(url),
                    "canonical_url": canonical, "application_url": url, "posting_date": posting_date,
                    # Feed UUIDs are not employer requisition IDs; deduplicate using employer links.
                    "external_req_id": None,
                    "raw_source_data": {"discovery_only": True, "github_repository": source.repository,
                                        "github_source_url": source_url, "listing": item},
                })
        except Exception as exc:
            self.last_error = str(exc)
        else:
            # Outbound-link failures are item warnings, not a repository fetch failure.
            self.last_error = None
        return jobs

    def enrich_job(self, job):
        """Use existing employer adapters; failures retain the explicitly unverified lead."""
        from ..scrapers import get_scraper_for_ats
        from ..scrapers.workday import WorkdayScraper

        parsed = urlparse(job["canonical_url"])
        parts = [p for p in parsed.path.split("/") if p]
        ats = job["source_ats"]
        repository_error = self.last_error
        try:
            detail = None
            breezy = ats == "breezy" and (parsed.hostname or "").endswith(".breezy.hr") and parts[:1] == ["p"]
            if (ats in ("greenhouse", "lever", "ashby") and len(parts) >= 2) or breezy:
                # Breezy names the board in the subdomain (company.breezy.hr/p/<id>), the others in the path.
                board = parsed.hostname.split(".")[0] if breezy else parts[0]
                key = (ats, board)
                if key not in self.boards:
                    scraper = get_scraper_for_ats(ats)
                    try:
                        postings = scraper.discover_jobs({"name": job["company_name"],
                                                          "board_token": board, "company_slug": board})
                        self.boards[key] = {canonicalize_url(p["canonical_url"]).replace(
                            "://job-boards.greenhouse.io/", "://boards.greenhouse.io/"): p for p in postings}
                    finally:
                        scraper.close()
                lookup = job["canonical_url"].replace("://job-boards.greenhouse.io/", "://boards.greenhouse.io/")
                detail = self.boards[key].get(lookup)
            elif ats == "workday" and "/job/" in parsed.path:
                _, _, cxs = WorkdayScraper.board(job["canonical_url"])
                path = "/job/" + parsed.path.split("/job/", 1)[1]
                response = self.get_with_retry(cxs + path, max_retries=2)
                response.raise_for_status()
                raw = response.json().get("jobPostingInfo", {})
                if raw.get("jobDescription") and raw.get("canApply") is not False:
                    description = clean_html_text(raw["jobDescription"])
                    salary, minimum, maximum = extract_salary(description)
                    detail = {**job, "title": raw.get("title") or job["title"],
                              "description": description, "location": raw.get("location") or job["location"],
                              "employment_type": raw.get("timeType"), "external_req_id": raw.get("jobReqId"),
                              "salary_raw": salary, "salary_min": minimum, "salary_max": maximum,
                              "raw_source_data": {"jobPostingInfo": raw}}
            if detail and detail.get("description"):
                provenance = job["raw_source_data"]
                return {**job, **detail, "raw_source_data": {
                    **(detail.get("raw_source_data") or {}), "discovery_only": False,
                    "github_repository": provenance["github_repository"],
                    "github_source_url": provenance["github_source_url"], "github_listing": provenance["listing"]}}
        except Exception as exc:
            self.warnings.append(f"Employer details unavailable for {job['company_name']}: {type(exc).__name__}")
        finally:
            # Detail requests share the HTTP helper, but cannot change feed health.
            self.last_error = repository_error
        return job

    @staticmethod
    def valid_job_url(url):
        parsed = urlparse(url)
        host = parsed.hostname or ""
        return (parsed.scheme in ("http", "https") and bool(host) and not parsed.username
                and host not in ("github.com", "raw.githubusercontent.com", "simplify.jobs", "www.simplify.jobs"))

    def fetch_job(self, target, job_id):
        return next((j for j in self.discover_jobs(target) if j["canonical_url"] == job_id), None)

    def check_status(self, job_url):
        # Repository removal or a failed read never constitutes employer closure evidence.
        return True, None
