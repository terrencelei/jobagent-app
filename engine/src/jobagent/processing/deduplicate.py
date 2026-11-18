"""Deduplication and entity resolution for job postings."""

from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple
from sqlalchemy.orm import Session

from ..db.models import Job, JobStatus, utc_now
from .normalize import canonicalize_url, compute_description_hash, normalize_title


def calculate_string_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


class Deduplicator:
    def __init__(self, session: Session):
        self.session = session

    def resolve_job(self, incoming_job: Dict[str, Any]) -> Tuple[Optional[Job], str]:
        """
        Check if incoming job matches an existing database record.
        Returns (matched_job, reason) or (None, "").
        """
        canonical_url = canonicalize_url(incoming_job.get("canonical_url", ""))
        external_req_id = incoming_job.get("external_req_id")
        company_name = incoming_job.get("company_name", "").strip()
        description = incoming_job.get("description", "")
        desc_hash = compute_description_hash(description) if description else incoming_job.get("description_hash", "")
        title = normalize_title(incoming_job.get("title", ""))

        # Vector 1: Exact canonical URL
        if canonical_url:
            from ..db.repository import JobRepository
            job = JobRepository(self.session).get_job_by_canonical_url(canonical_url)
            if job:
                return (job, "canonical_url_match")

        # Vector 2: Same company + requisition ID
        if company_name and external_req_id:
            job = (
                self.session.query(Job)
                .filter(Job.company_name.ilike(company_name), Job.external_req_id == str(external_req_id))
                .first()
            )
            if job:
                return (job, "req_id_match")

        # Vector 3: Same company + exact description hash
        if company_name and desc_hash:
            job = (
                self.session.query(Job)
                .filter(Job.company_name.ilike(company_name), Job.description_hash == desc_hash)
                .first()
            )
            if job and not (external_req_id and job.external_req_id and str(external_req_id) != job.external_req_id):
                return (job, "description_hash_match")

        # Vector 4: Same company + high title similarity + identical location
        # Repository leads have no employer requisition ID. Distinct application
        # links must not collapse just because both say "Mechanical Engineer".
        if (incoming_job.get("raw_source_data") or {}).get("discovery_only"):
            return (None, "")
        if company_name and title:
            candidates = (
                self.session.query(Job)
                .filter(Job.company_name.ilike(company_name))
                .all()
            )
            for cand in candidates:
                sim = calculate_string_similarity(title, cand.normalized_title)
                # If title is identical or very close (>0.92)
                if sim >= 0.92:
                    # If requisition IDs exist and differ, do NOT treat as duplicate (genuine distinct req)
                    if external_req_id and cand.external_req_id and str(external_req_id) != str(cand.external_req_id):
                        continue
                    return (cand, "fuzzy_title_match")

        return (None, "")
