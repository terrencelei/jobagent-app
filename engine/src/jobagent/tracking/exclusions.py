"""Keep dismissed jobs off the dashboard, and keep them from coming back.

Judging a role to be outside the candidate's background costs real attention, so that
judgement has to persist. A posting is rediscovered on every scan and often moves to a new
URL, which is why an exclusion can match on the URL, on the company and title together, or
on a title pattern covering a whole category of work.
"""

import re
from typing import Any, Dict, List, Optional

from ..db.models import Job, JobExclusion, JobStatus, utc_now
from ..processing.normalize import canonicalize_url, normalize_title


def _key(company: str, title: str) -> str:
    return f"{(company or '').strip().lower()}::{normalize_title(title or '').strip().lower()}"


def add_exclusion(session, *, reason: str, scope: str = "company_title",
                  job: Optional[Job] = None, value: Optional[str] = None,
                  company_name: Optional[str] = None) -> JobExclusion:
    """Record an exclusion. With a job and no value, the job supplies the value."""
    if scope not in ("url", "company_title", "title_pattern"):
        raise ValueError(f"Unknown exclusion scope: {scope}")
    if value is None:
        if job is None:
            raise ValueError("Pass either a job or an explicit value")
        value = canonicalize_url(job.canonical_url or "") if scope == "url" else _key(job.company_name, job.title)
        company_name = company_name or job.company_name
    if scope == "title_pattern":
        re.compile(value)  # fail here rather than on every future scan
    existing = session.query(JobExclusion).filter(
        JobExclusion.scope == scope, JobExclusion.value == value).first()
    if existing:
        return existing
    rec = JobExclusion(scope=scope, value=value, company_name=company_name, reason=reason)
    session.add(rec)
    return rec


def load_exclusions(session) -> List[JobExclusion]:
    return session.query(JobExclusion).all()


def matches(exclusions: List[JobExclusion], *, title: str, company: str, url: str = "") -> Optional[JobExclusion]:
    """The exclusion that covers this posting, or None."""
    canon = canonicalize_url(url or "")
    key = _key(company, title)
    for e in exclusions:
        if e.scope == "url" and canon and e.value == canon:
            return e
        if e.scope == "company_title" and e.value == key:
            return e
        if e.scope == "title_pattern" and re.search(e.value, title or "", re.I):
            if e.company_name and (company or "").strip().lower() != e.company_name.strip().lower():
                continue
            return e
    return None


def dismiss_job(session, job: Job, reason: str, scope: str = "company_title") -> Dict[str, Any]:
    """Take a job off the dashboard and stop it being offered again."""
    job.status = JobStatus.IGNORED
    note = f"Dismissed {utc_now().date()}: {reason}"
    job.eligibility_reasons = f"{job.eligibility_reasons}\n{note}" if job.eligibility_reasons else note
    rec = add_exclusion(session, reason=reason, scope=scope, job=job)
    return {"job_id": job.id, "title": job.title, "company": job.company_name,
            "scope": rec.scope, "value": rec.value}
