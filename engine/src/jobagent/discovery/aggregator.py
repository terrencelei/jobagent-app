"""Aggregator ingester for discovering new grad and early career engineering opportunities nationwide."""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set
import httpx
from sqlalchemy.orm import Session

from ..db.models import Company
from ..identity import grad_timing
from ..processing.normalize import canonicalize_url, compute_description_hash, detect_seniority, normalize_location, normalize_title

logger = logging.getLogger("jobagent.discovery.aggregator")

SIMPLIFY_NEW_GRAD_URL = "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json"


class AggregatorIngester:
    """Ingests broad, multi-employer early career and new grad job feeds."""

    ENGINEERING_KEYWORDS = {
        "mechanical", "hardware", "robotics", "mechatronics", "systems", "manufacturing",
        "aerospace", "controls", "automation", "test", "data science", "thermal", "optics",
        "sensor", "actuator", "vehicle", "propulsion", "dynamics", "flight", "electronics",
        "embedded", "quality", "reliability", "npi", "process", "equipment", "product design",
        "instrumentation", "modeling", "simulation", "electromechanical", "structures", "space",
        "guidance", "navigation", "gnc", "avionics", "battery", "powertrain",
        # Statistics & data science track
        "data scientist", "data analyst", "analytics", "statistic", "machine learning", "quantitative",
        "business intelligence",
    }

    def __init__(self, session: Optional[Session] = None):
        self.session = session

    def fetch_simplify_listings(self) -> List[Dict[str, Any]]:
        """Fetch real-time early career and new grad listings from Simplify repository feed."""
        try:
            with httpx.Client(timeout=15.0, follow_redirects=True) as client:
                resp = client.get(SIMPLIFY_NEW_GRAD_URL, headers={"User-Agent": "JobAgent/1.0"})
                if resp.status_code == 200:
                    return resp.json()
                logger.warning(f"SimplifyJobs feed returned HTTP {resp.status_code}")
        except Exception as e:
            logger.error(f"Failed to fetch SimplifyJobs feed: {e}")
        return []

    def is_engineering_relevant(self, title: str, category: str = "") -> bool:
        """Filter for roles matching mechanical, hardware, robotics, systems, or data science."""
        t_lower = title.lower()
        c_lower = category.lower()

        # Reject explicitly unrelated software-only or business tracks
        unrelated = ["frontend", "front-end", "react", "accounting", "paralegal", "nurse", "sales rep", "marketing coordinator"]
        if any(u in t_lower for u in unrelated):
            return False

        if any(kw in t_lower or kw in c_lower for kw in self.ENGINEERING_KEYWORDS):
            return True
        return False

    def detect_ats_from_url(self, url: str) -> str:
        """Detect underlying ATS provider from URL."""
        u = url.lower()
        if "greenhouse.io" in u:
            return "greenhouse"
        elif "lever.co" in u:
            return "lever"
        elif "ashbyhq.com" in u:
            return "ashby"
        elif "breezy.hr" in u:
            return "breezy"
        elif "myworkdayjobs.com" in u:
            return "workday"
        elif "icims.com" in u:
            return "icims"
        elif "oraclecloud.com" in u:
            return "oracle"
        return "direct"

    def discover_jobs(self) -> List[Dict[str, Any]]:
        """Discover and normalize early-career engineering positions across all employers."""
        raw_items = self.fetch_simplify_listings()
        discovered: List[Dict[str, Any]] = []

        for item in raw_items:
            # Only process active listings
            if not item.get("active", True):
                continue

            title = item.get("title") or ""
            category = item.get("category") or ""
            if not self.is_engineering_relevant(title, category):
                continue

            company_name = item.get("company_name") or "Unknown Company"
            raw_url = item.get("url") or ""
            if not raw_url or not raw_url.startswith("http"):
                continue

            canonical = canonicalize_url(raw_url)
            norm_title = normalize_title(title)
            detected_level, is_senior, is_early = detect_seniority(title)

            # Extract locations
            loc_list = item.get("locations", [])
            loc_str = ", ".join(loc_list) if isinstance(loc_list, list) and loc_list else str(loc_list or "United States")
            norm_loc, is_remote, is_hybrid = normalize_location(loc_str)

            # Degree handling
            degrees = item.get("degrees", [])
            degrees_str = ", ".join(degrees) if isinstance(degrees, list) else str(degrees or "")

            # Posting date
            date_posted = item.get("date_posted")
            posting_dt = None
            if date_posted and isinstance(date_posted, (int, float)):
                try:
                    posting_dt = datetime.fromtimestamp(date_posted, tz=timezone.utc)
                except Exception:
                    posting_dt = None

            source_ats = self.detect_ats_from_url(raw_url)

            # Generate synthetic description if body not directly provided in feed
            desc = (
                f"Position: {title}\n"
                f"Company: {company_name}\n"
                f"Category: {category}\n"
                f"Locations: {loc_str}\n"
                f"Target Degree Level: {degrees_str}\n"
                f"Source: Early-Career & New Grad Network\n\n"
                f"Official application link: {raw_url}\n"
            )

            job_dict = {
                "external_req_id": item.get("id"),
                "company_name": company_name,
                "title": title,
                "normalized_title": norm_title,
                "department": category or "Engineering",
                "location": loc_str,
                "normalized_location": norm_loc,
                "employment_type": "Full-time",
                "seniority": detected_level or "Entry Level",
                "salary_raw": None,
                "salary_min": None,
                "salary_max": None,
                "description": desc,
                "description_hash": compute_description_hash(desc),
                "requirements": {"degrees": degrees} if degrees else {},
                "preferred_qualifications": {},
                "canonical_url": canonical,
                "application_url": raw_url,
                "source_ats": source_ats,
                "raw_source_data": item,
                "posting_date": posting_dt,
                "stated_start_date": None,
                "graduation_requirements": f"{grad_timing().prior_year}/{grad_timing().year} Early Career",
                "early_career_boost": True,
            }
            discovered.append(job_dict)

            # Register company in DB if session provided and company is new
            if self.session:
                try:
                    existing = self.session.query(Company).filter(Company.name.ilike(company_name)).first()
                    if not existing:
                        comp_url = item.get("company_url") or ""
                        if "simplify.jobs" in comp_url:
                            comp_url = ""
                        # Only set career_url if it is an actual direct ATS portal or valid URL
                        valid_career_url = comp_url or (
                            raw_url if any(ats in raw_url for ats in ["greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "icims.com"]) else None
                        )
                        new_comp = Company(
                            name=company_name,
                            slug=company_name.lower().replace(" ", "-")[:250],
                            ats_type=source_ats,
                            career_url=valid_career_url,
                            is_active=True,
                        )
                        self.session.add(new_comp)
                        self.session.flush()
                except Exception:
                    pass

        if self.session:
            try:
                self.session.commit()
            except Exception:
                self.session.rollback()

        logger.info(f"Aggregator discovered {len(discovered)} active early-career engineering positions.")
        return discovered
