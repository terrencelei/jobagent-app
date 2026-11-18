"""Job lifecycle pipeline executing discovery, deduplication, scoring, and status tracking."""

from datetime import datetime, timezone
import logging
import threading
from typing import Any, Dict, List, Optional, Tuple
from sqlalchemy.orm import Session

from ..config import load_profile_config, load_ranking_config
from .exclusions import load_exclusions, matches
from ..db.models import (
    EligibilityStatus,
    Job,
    JobSnapshot,
    JobStatus,
    ScoreBreakdown,
    SearchRun,
    utc_now,
)
from ..db.repository import JobRepository
from ..processing.deduplicate import Deduplicator
from ..processing.eligibility import EligibilityEngine
from ..processing.normalize import canonicalize_url, compute_description_hash, normalize_location, normalize_title
from ..ranking.scorer import RelevanceScorer
from ..processing.track_eval import TrackEvaluator, delete_job, prunable, rejected_everywhere
from ..processing.us_locations import is_us_location
from ..processing.tracks import active_track
from ..processing.application_caps import detect as detect_cap, record as record_cap
from ..scrapers import get_scraper_for_ats

logger = logging.getLogger("jobagent.lifecycle")

# Held while a batch is written through the pipeline (a scan's write phase, an inbox batch, a pasted link),
# never while a scan is still fetching sources, so a single addition waits seconds rather than a whole scan.
PIPELINE_LOCK = threading.RLock()


class JobLifecyclePipeline:
    def __init__(self, session: Session):
        self.session = session
        self.repo = JobRepository(session)
        self.deduplicator = Deduplicator(session)
        self.eligibility_engine = EligibilityEngine()
        self.scorer = RelevanceScorer()
        # Every posting is judged for every search track; the active one is shown.
        self.tracks = TrackEvaluator()

    def process_discovered_jobs(
        self,
        raw_jobs: List[Dict[str, Any]],
        sources_checked: int = 1,
        record_run: bool = True,
    ) -> Dict[str, Any]:
        """
        Execute full lifecycle pipeline on a batch of newly scraped job observations.

        A record with ``keep`` set (a posting he added himself by link) is stored even when he
        excluded it before or no search track accepts it; record_run=False leaves the search-run
        history alone for such single additions.
        """
        with PIPELINE_LOCK:
            return self._process_discovered_jobs(raw_jobs, sources_checked, record_run)

    def _process_discovered_jobs(self, raw_jobs, sources_checked, record_run):
        stats = {
            "sources_checked": sources_checked,
            "jobs_scanned": len(raw_jobs),
            "new_jobs": 0,
            "updated_jobs": 0,
            "duplicates_merged": 0,
            "closed_jobs": 0,
            "errors_count": 0,
            "high_fit_new_jobs": 0,
            "new_grad_jobs": 0,
            "top_match_title": None,
            "top_match_company": None,
            "top_match_score": 0.0,
            "error_log": [],
        }

        # A dismissal has to survive rediscovery, so excluded postings are dropped before
        # anything else looks at them.
        exclusions = load_exclusions(self.session)
        stats["excluded_jobs"] = 0

        for raw in raw_jobs:
            try:
                title = raw.get("title", "")
                company = raw.get("company_name", "")
                keep = bool(raw.get("keep"))
                hit = matches(exclusions, title=title, company=company,
                              url=raw.get("canonical_url", ""))
                if hit and not keep:
                    stats["excluded_jobs"] += 1
                    continue
                description = raw.get("description", "")
                loc = raw.get("location", "")
                # Independent of ranking, pruning settings, track or saved fit labels.
                if not is_us_location(loc):
                    stats["skipped_non_us_or_unknown"] = stats.get("skipped_non_us_or_unknown", 0) + 1
                    continue
                canonical_url = canonicalize_url(raw.get("canonical_url", ""))
                ext_req_id = raw.get("external_req_id")
                desc_hash = compute_description_hash(description)

                # A discovery-only feed must never replace a verified employer description.
                existing_match, match_reason = self.deduplicator.resolve_job(raw)
                def is_discovery_only(text):
                    return any(marker in (text or "") for marker in (
                        "Source: Early-Career & New Grad Network", "Employer requirements not fetched."))

                if (existing_match and is_discovery_only(description)
                        and existing_match.description and not is_discovery_only(existing_match.description)):
                    existing_match.last_seen = utc_now()
                    stats["duplicates_merged"] += 1
                    continue

                # 1. Eligibility and scoring, for every search track
                salary_min = raw.get("salary_min")
                existing_match, match_reason = self.deduplicator.resolve_job(raw)
                track_results = self.tracks.evaluate(
                    title, description, company, loc, raw.get("employment_type"), salary_min,
                    raw.get("posting_date"), existing_match.discovery_date if existing_match else utc_now())
                # A posting no track accepts is not stored; one that stopped qualifying is removed
                # unless he has acted on it.
                if rejected_everywhere(track_results) and not keep:
                    if existing_match:
                        existing_match.track_results = track_results
                    if not existing_match or prunable(self.session, existing_match):
                        if existing_match:
                            delete_job(self.session, existing_match)
                        stats["skipped_ineligible"] = stats.get("skipped_ineligible", 0) + 1
                        continue
                    # Otherwise it is his history (applied, saved, labelled): keep it up to date.
                shown = track_results[active_track()]
                eligibility_status = EligibilityStatus(shown["eligibility"])
                reasons, stated_start_date = shown["reasons"], shown["stated_start_date"]
                score_res = {**{k: shown[k] for k in ("best_career_cluster", "cluster_scores", "relevance_score",
                                                     "urgency_score", "priority_score", "early_career_boost",
                                                     "experience_required_years", "experience_preferred_years")},
                             "breakdown": shown["breakdown"]}
                with self.session.begin_nested():
                    # Check for existing duplicate record
                    existing_match, match_reason = self.deduplicator.resolve_job(raw)
                    if existing_match:
                        stats["duplicates_merged"] += 1

                    # Upsert Job Record
                    job_data = {
                        "external_req_id": ext_req_id,
                        "company_name": company,
                        "title": title,
                        "normalized_title": normalize_title(title),
                        "location": loc,
                        "normalized_location": normalize_location(loc)[0],
                        "department": raw.get("department"),
                        "employment_type": raw.get("employment_type"),
                        "seniority": raw.get("seniority"),
                        "role_type": self.eligibility_engine.classify_role_type(title, description, raw.get("employment_type")),
                        "salary_raw": raw.get("salary_raw"),
                        "salary_min": raw.get("salary_min"),
                        "salary_max": raw.get("salary_max"),
                        "description": description,
                        "description_hash": desc_hash,
                        "canonical_url": canonical_url,
                        "application_url": raw.get("application_url", canonical_url),
                        "source_ats": raw.get("source_ats", "direct"),
                        "raw_source_data": raw.get("raw_source_data"),
                        "posting_date": raw.get("posting_date"),
                        "stated_start_date": stated_start_date,
                        "eligibility": eligibility_status,
                        "eligibility_reasons": reasons,
                        "best_career_cluster": score_res["best_career_cluster"],
                        "cluster_scores": score_res["cluster_scores"],
                        "relevance_score": score_res["relevance_score"],
                        "urgency_score": score_res["urgency_score"],
                        "priority_score": score_res["priority_score"],
                        "early_career_boost": score_res["early_career_boost"],
                        "track_results": track_results,
                        "experience_required_years": score_res["experience_required_years"],
                        "experience_preferred_years": score_res["experience_preferred_years"],
                    }

                    job, is_new, is_updated = self.repo.upsert_job(job_data)
                    # An employer limit on applications waits for his decision before any application there.
                    cap = detect_cap(description)
                    if cap:
                        record_cap(company, cap, 'job posting', job.id, canonical_url)

                    if is_new:
                        stats["new_jobs"] += 1
                        if score_res["priority_score"] >= 85.0:
                            stats["high_fit_new_jobs"] += 1
                        if score_res["early_career_boost"] or "new grad" in title.lower():
                            stats["new_grad_jobs"] += 1
                    elif is_updated:
                        stats["updated_jobs"] += 1

                    # Update ScoreBreakdown safely via relationship
                    breakdown = score_res["breakdown"]
                    if not job.score_breakdown:
                        sb = ScoreBreakdown(
                            job_id=job.id,
                            semantic_role_match=breakdown["semantic_role_match"],
                            technical_skill_match=breakdown["technical_skill_match"],
                            experience_match=breakdown["experience_match"],
                            industry_match=breakdown["industry_match"],
                            early_career_fit=breakdown["early_career_fit"],
                            role_preference=breakdown["role_preference"],
                            location_preference=breakdown["location_preference"],
                            company_preference=breakdown["company_preference"],
                            penalties=breakdown["penalties"],
                            total_relevance=score_res["relevance_score"],
                            urgency=score_res["urgency_score"],
                            priority=score_res["priority_score"],
                            matching_skills=breakdown["matching_skills"],
                            missing_skills=breakdown["missing_skills"],
                            matching_experience=breakdown["matching_experience"],
                            explanation=breakdown["explanation"],
                        )
                        job.score_breakdown = sb
                        self.session.add(sb)
                    else:
                        for component in ("semantic_role_match", "technical_skill_match", "experience_match", "industry_match", "early_career_fit", "role_preference", "location_preference", "company_preference", "penalties"):
                            setattr(job.score_breakdown, component, breakdown[component])
                        job.score_breakdown.total_relevance = score_res["relevance_score"]
                        job.score_breakdown.urgency = score_res["urgency_score"]
                        job.score_breakdown.priority = score_res["priority_score"]
                        job.score_breakdown.matching_skills = breakdown["matching_skills"]
                        job.score_breakdown.missing_skills = breakdown["missing_skills"]
                        job.score_breakdown.matching_experience = breakdown["matching_experience"]
                        job.score_breakdown.explanation = breakdown["explanation"]

                    # Track top match
                    if score_res["priority_score"] > stats["top_match_score"]:
                        stats["top_match_score"] = score_res["priority_score"]
                        stats["top_match_title"] = title
                        stats["top_match_company"] = company

            except Exception as e:
                logger.error(f"Error processing job {raw.get('title')}: {e}")
                stats["errors_count"] += 1
                stats["error_log"].append({"job": raw.get("title"), "error": str(e)})

        # Record search run
        if not record_run:
            self.session.commit()
            return stats
        self.repo.record_search_run(
            sources_checked=stats["sources_checked"],
            jobs_scanned=stats["jobs_scanned"],
            new_jobs=stats["new_jobs"],
            updated_jobs=stats["updated_jobs"],
            duplicates_merged=stats["duplicates_merged"],
            closed_jobs=stats["closed_jobs"],
            errors_count=stats["errors_count"],
            high_fit_new_jobs=stats["high_fit_new_jobs"],
            new_grad_jobs=stats["new_grad_jobs"],
            top_match_title=stats["top_match_title"],
            top_match_company=stats["top_match_company"],
            top_match_score=stats["top_match_score"],
            error_log=stats["error_log"],
        )
        self.session.commit()
        return stats

    def verify_active_jobs(self, max_check: int = 50, seen_before=None, confirmations: int = 2, max_seconds: float | None = None) -> int:
        """
        Verify status of active jobs.
        CRITICAL: Never mark a job CLOSED because of:
        - timeout
        - HTTP 5xx error
        - rate limiting
        - temporary scraper failure
        A posting closes only on positive closure evidence found on `confirmations` separate passes
        in a row (2026-11-14: a site flapping through maintenance answered 404 once for a live job).

        seen_before: skip postings a scan has listed since that time; the scan itself proved them live.
        Order: postings awaiting their confirming check first, then the longest unchecked.
        """
        import time
        from urllib.parse import urlparse
        query = self.session.query(Job).filter(Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE, JobStatus.SAVED]))
        if seen_before is not None:
            query = query.filter(Job.last_seen < seen_before)
        active_jobs = query.order_by(Job.failure_count.desc(), Job.last_seen.asc()).limit(max_check).all()

        scrapers, closed_count, checked, started = {}, 0, 0, time.monotonic()
        try:
            for job in active_jobs:
                if max_seconds is not None and time.monotonic() - started > max_seconds:
                    break
                try:
                    # Workday boards are also stored as "direct" postings; their public page says 200 for a removed job.
                    host = (urlparse(job.canonical_url or '').hostname or '').lower()
                    kind = 'workday' if host.endswith('.myworkdayjobs.com') else (job.source_ats or 'direct').lower()
                    scraper = scrapers.get(kind) or scrapers.setdefault(kind, get_scraper_for_ats(kind))
                    is_active, closure_evidence = scraper.check_status(job.canonical_url)
                    checked += 1

                    if not is_active and closure_evidence:
                        job.failure_count = (job.failure_count or 0) + 1
                        if job.failure_count >= confirmations:
                            job.status = JobStatus.CLOSED
                            job.failure_count = 0
                            closed_count += 1
                            logger.info(f"Marked job {job.id} ({job.title}) CLOSED due to: {closure_evidence}")
                    elif is_active:
                        # Verified active, or nothing could be learned: either way not evidence of closure.
                        job.failure_count = 0
                        job.last_seen = utc_now()

                except Exception as e:
                    # Network or scraper error: NEVER close job on temporary failure
                    logger.warning(f"Status check exception for job {job.id} (ignoring to prevent false closure): {e}")
                if checked % 25 == 0:
                    self.session.commit()  # short write transactions: workers and the dashboard share this database
        finally:
            for scraper in scrapers.values():
                try:
                    scraper.close()
                except Exception:
                    pass
        self.session.commit()
        self.last_verification = {'checked': checked, 'closed': closed_count, 'candidates': len(active_jobs)}
        return closed_count
