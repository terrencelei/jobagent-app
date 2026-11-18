"""Normalization utilities for job postings, titles, locations, salaries, and URLs."""

import hashlib
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from bs4 import BeautifulSoup
from .qualifications import is_early_career, SENIOR_PATTERN


TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gh_jid", "gh_src", "lever-source", "ashby_jid", "ref", "source",
    "fbclid", "gclid", "source_type", "src", "mode", "sid"
}

EARLY_CAREER_MARKERS = [
    "new grad", "university grad", "university hire", "college grad",
    "entry level", "early career", "associate engineer", "engineer 1",
    "engineer i", "level 1", "l1", "rotational", "campus hire"
]

SENIOR_MARKERS = [
    "senior", "sr.", "sr ", "staff", "principal", "lead", "head of",
    "director", "vice president", "vp", "manager", "chief", "architect iii",
    "engineer iii", "engineer iv", "level 3", "level 4"
]


def canonicalize_url(url: str) -> str:
    """Strip tracking query parameters, normalize trailing slashes and casing."""
    if not url:
        return ""
    try:
        parsed = urlparse(url.strip())
        netloc = parsed.netloc.lower()
        path = parsed.path.rstrip("/")
        if not path:
            path = "/"

        # Filter out tracking query parameters
        clean_queries = []
        for k, v in parse_qsl(parsed.query, keep_blank_values=True):
            if k.lower() not in TRACKING_PARAMS:
                clean_queries.append((k, v))
        clean_query = urlencode(sorted(clean_queries))

        # Standardize known ATS domains
        if "boards.greenhouse.io" in netloc or "job-boards.greenhouse.io" in netloc:
            # Format: /board_token/jobs/job_id
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 3 and parts[1] == "jobs":
                board, _, job_id = parts[:3]
                path = f"/{board}/jobs/{job_id}"
                clean_query = ""  # Greenhouse job IDs are unique
        elif "jobs.lever.co" in netloc:
            # Format: /company/job_id
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 2:
                company, job_id = parts[:2]
                path = f"/{company}/{job_id}"
                clean_query = ""
        elif "jobs.ashbyhq.com" in netloc:
            # Format: /company/job_id
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 2:
                company, job_id = parts[:2]
                path = f"/{company}/{job_id}"
                clean_query = ""

        return urlunparse((
            parsed.scheme.lower() or "https",
            netloc,
            path,
            "",
            clean_query,
            ""
        ))
    except Exception:
        return url.strip()


def normalize_text(text: str) -> str:
    """Strip HTML tags and condense whitespace."""
    if not text:
        return ""
    # If contains HTML tags, strip them
    if "<" in text and ">" in text:
        soup = BeautifulSoup(text, "html.parser")
        clean = soup.get_text(separator=" ")
    else:
        clean = text
    return re.sub(r"\s+", " ", clean).strip()


def compute_description_hash(description: str) -> str:
    """Compute SHA256 of cleaned, lowercased description text."""
    clean = normalize_text(description).lower()
    return hashlib.sha256(clean.encode("utf-8")).hexdigest()


def normalize_title(title: str) -> str:
    """Clean job title by stripping bracketed requisition IDs, department tags, and emojis."""
    if not title:
        return ""
    t = title.strip()
    # Strip emojis
    t = re.sub(r"[\U00010000-\U0010ffff]", "", t)
    # Strip bracketed requisitions e.g. [Req-12345], (JR2026518655), (7894094003)
    t = re.sub(r"\[[^\]]*(?:req|jr|job|id|#)[0-9\-_\s]*[^\]]*\]", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\([^)]*(?:req|jr|job|id|#)[0-9\-_\s]*[^)]*\)", "", t, flags=re.IGNORECASE)
    # Strip standalone numbers in parentheses e.g. (7894094003)
    t = re.sub(r"\(\d{5,}\)", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def detect_seniority(title: str, description: str = "") -> Tuple[str, bool, bool]:
    """
    Detect seniority level and flags.
    Returns: (seniority_str, is_senior, is_early_career)
    """
    title_lower = title.lower()
    desc_lower = description[:1000].lower() if description else ""

    is_senior = bool(re.search(SENIOR_PATTERN, title_lower))
    early = is_early_career(title)
    if early and not is_senior:
        return ("Early Career / New Grad", False, True)
    if is_senior:
        return ("Senior / Leadership", True, False)
    return ("Mid / Unspecified", False, False)


def normalize_location(location_str: Optional[str]) -> Tuple[str, bool, bool]:
    """
    Normalize location and detect remote / hybrid status.
    Returns: (normalized_location, is_remote, is_hybrid)
    """
    if not location_str:
        return ("Unspecified Location", False, False)

    loc = normalize_text(location_str)
    loc_lower = loc.lower()

    is_remote = "remote" in loc_lower or "anywhere" in loc_lower
    is_hybrid = "hybrid" in loc_lower

    # Clean redundant labels
    cleaned = re.sub(r"\b(remote|hybrid|onsite|on-site)\b", "", loc, flags=re.IGNORECASE)
    cleaned = re.sub(r"[,/\|\-\(\)]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    if not cleaned:
        cleaned = "Remote" if is_remote else "United States"

    return (cleaned or loc, is_remote, is_hybrid)


def extract_salary(text: str) -> Tuple[Optional[str], Optional[float], Optional[float]]:
    """
    Extract base salary range from text.
    Handles ranges like "$95,000 - $125,000", "$95k - $120k", "$45 - $60 / hour".
    Converts hourly rates to annualized base pay (assuming 2080 hours).
    Returns: (raw_string, min_annual, max_annual)
    """
    if not text:
        return (None, None, None)

    # Search for yearly dollar amounts: e.g. $90,000 - $120,000 or $90k - $120k
    yearly_pattern = re.search(
        r"\$\s*(\d{2,3}(?:,\d{3})*|\d{2,3})\s*(?:k|K)?\s*(?:-|–|to)\s*\$\s*(\d{2,3}(?:,\d{3})*|\d{2,3})\s*(k|K)?",
        text
    )
    if yearly_pattern:
        raw_min = yearly_pattern.group(1).replace(",", "")
        raw_max = yearly_pattern.group(2).replace(",", "")
        has_k = bool(yearly_pattern.group(3)) or ("k" in yearly_pattern.group(0).lower())

        min_val = float(raw_min) * 1000 if (has_k and float(raw_min) < 1000) or float(raw_min) < 1000 else float(raw_min)
        max_val = float(raw_max) * 1000 if (has_k and float(raw_max) < 1000) or float(raw_max) < 1000 else float(raw_max)

        if 40000 <= min_val <= 500000:
            return (yearly_pattern.group(0), min_val, max_val)

    # Hourly pattern: e.g. $45.00 - $65.00 / hr or per hour
    hourly_pattern = re.search(
        r"\$\s*(\d{2}(?:\.\d{2})?)\s*(?:-|–|to)\s*\$\s*(\d{2}(?:\.\d{2})?)\s*(?:/|per)?\s*(?:hr|hour)",
        text,
        flags=re.IGNORECASE
    )
    if hourly_pattern:
        h_min = float(hourly_pattern.group(1))
        h_max = float(hourly_pattern.group(2))
        return (hourly_pattern.group(0), h_min * 2080, h_max * 2080)

    return (None, None, None)
