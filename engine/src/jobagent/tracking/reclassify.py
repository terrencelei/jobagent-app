"""Re-evaluate stored postings without changing discovery or application history."""

from ..db.models import Job, ScoreBreakdown
from ..processing.eligibility import EligibilityEngine, clean_html_text
from ..processing.normalize import compute_description_hash, normalize_location
from ..scrapers.lever import lever_description
from ..processing.track_eval import TrackEvaluator, apply_track
from ..processing.tracks import active_track
from ..processing.application_caps import detect as detect_cap, record as record_cap


def reclassify_jobs(session, job_ids=None):
    eligibility = EligibilityEngine()
    tracks = TrackEvaluator()
    shown = active_track()
    changed = 0
    jobs = session.query(Job)
    if job_ids is not None:
        jobs = jobs.filter(Job.id.in_(job_ids))
    for job in jobs.order_by(Job.id).all():
        # Recover source sections from stored payloads, without pretending this is a fresh fetch.
        raw = job.raw_source_data or {}
        description = None
        if job.source_ats == "lever" and isinstance(raw, dict) and raw.get("lists"):
            description = lever_description(raw)
        elif job.source_ats == "greenhouse" and isinstance(raw, dict) and raw.get("content"):
            description = clean_html_text(raw["content"])
        elif job.source_ats == "ashby" and isinstance(raw, dict):
            if raw.get("descriptionHtml") or raw.get("descriptionPlain"):
                description = clean_html_text(raw.get("descriptionHtml") or raw["descriptionPlain"])
            if raw.get("location") or raw.get("locationName"):
                job.location = raw.get("location") or raw["locationName"]
                job.normalized_location = normalize_location(job.location)[0]
        if description:
            job.description = description
            job.description_hash = compute_description_hash(description)
        role_type = eligibility.classify_role_type(job.title, job.description, job.employment_type)
        results = tracks.evaluate(job.title, job.description, job.company_name, job.location, job.employment_type,
                                  job.salary_min, job.posting_date, job.discovery_date)
        cap = detect_cap(job.description)
        if cap:
            record_cap(job.company_name, cap, 'job posting', job.id, job.canonical_url)
        before = (job.eligibility, job.role_type)
        job.track_results, job.role_type = results, role_type
        apply_track(job, results, shown)
        if (job.eligibility, job.role_type) != before:
            changed += 1
    session.commit()
    return changed


def show_track(session, key):
    """Switch the dashboard to another search track: copy that track's verdicts into place."""
    from ..processing.tracks import set_active_track
    set_active_track(key)
    missing = []
    for job in session.query(Job).all():
        if not apply_track(job, job.track_results, key):
            missing.append(job.id)
    session.commit()
    if missing:
        reclassify_jobs(session, missing)
    return len(missing)
