"""Judge a posting under every search track, and show the active one.

Each job keeps every track's verdict in `track_results`; the long-standing columns (eligibility,
scores, discipline, breakdown) mirror the active track, so the dashboard, queue and autoplay work
unchanged and the toggle only has to copy one track's verdict into place.
"""
from pathlib import Path

from ..db.models import (Application, EligibilityStatus, Job, JobSnapshot, JobStatus, ScoreBreakdown,
                         UserPreference, WatchAlert)
from ..ranking.scorer import RelevanceScorer
from .tracks import active_track, load_tracks

REJECTED = {'INELIGIBLE', 'LIKELY_INELIGIBLE'}
# A posting he has acted on is history, whatever the rules now say about it.
KEPT_STATUSES = {JobStatus.SAVED, JobStatus.APPLIED, JobStatus.INTERVIEW, JobStatus.OFFER, JobStatus.REJECTED, JobStatus.WITHDRAWN}
SCORE_KEYS = ('best_career_cluster', 'cluster_scores', 'relevance_score', 'urgency_score', 'priority_score', 'early_career_boost',
              'experience_required_years', 'experience_preferred_years')
BREAKDOWN_KEYS = ('semantic_role_match', 'technical_skill_match', 'experience_match', 'industry_match', 'early_career_fit',
                  'role_preference', 'location_preference', 'company_preference', 'penalties', 'matching_skills',
                  'missing_skills', 'matching_experience', 'explanation')


class TrackEvaluator:
    def __init__(self, tracks=None):
        self.scorers = {key: RelevanceScorer(track=track) for key, track in (tracks or load_tracks()).items()}

    def evaluate(self, title, description, company, location=None, employment_type=None, salary_min=None,
                 posting_date=None, discovery_date=None):
        results = {}
        for key, scorer in self.scorers.items():
            status, reasons, start, conflict = scorer.eligibility_engine.evaluate(
                title=title, description=description, location=location, employment_type=employment_type, salary_min=salary_min)
            scores = scorer.score_job(title, description, company, location, posting_date, discovery_date, conflict, salary_min)
            results[key] = {'eligibility': status.value, 'reasons': reasons, 'stated_start_date': start, 'start_conflict': conflict,
                            **{k: scores[k] for k in SCORE_KEYS},
                            'breakdown': {k: scores['breakdown'][k] for k in BREAKDOWN_KEYS}}
        return results


def rejected_everywhere(results) -> bool:
    """Ineligible for every track: nothing he searches for, so it is not kept (if pruning is on)."""
    from ..settings import setting
    if not setting('pruning.enabled'):
        return False
    rejected = REJECTED if setting('pruning.include_likely_ineligible') else {'INELIGIBLE'}
    return bool(results) and all(r['eligibility'] in rejected for r in results.values())


def apply_track(job, results, key=None):
    """Mirror one track's verdict into the job's display columns and score breakdown."""
    key = key or active_track()
    r = (results or {}).get(key)
    if not r:
        return False
    job.eligibility = EligibilityStatus(r['eligibility'])
    job.eligibility_reasons = r['reasons']
    job.stated_start_date = r['stated_start_date']
    for k in SCORE_KEYS:
        if k in r:  # verdicts stored before experience years were read lack those two
            setattr(job, k, r[k])
    if not job.score_breakdown:
        job.score_breakdown = ScoreBreakdown(job_id=job.id)
    for k in BREAKDOWN_KEYS:
        setattr(job.score_breakdown, k, r['breakdown'][k])
    job.score_breakdown.total_relevance = r['relevance_score']
    job.score_breakdown.urgency = r['urgency_score']
    job.score_breakdown.priority = r['priority_score']
    return True


def prunable(session, job, agent_dir=None, queued_ids=None) -> bool:
    """Whether a posting rejected by every track can be deleted without losing any of his history."""
    # Callers that omit queued_ids (rediscovery in lifecycle.py) must still keep runner postings.
    if queued_ids is None:
        queued_ids = runner_job_ids()
    if not rejected_everywhere(job.track_results) or job.status in KEPT_STATUSES or job.user_fit_label or job.id in queued_ids:
        return False
    if session.query(Application.id).filter_by(job_id=job.id).first():
        return False
    agent_dir = Path(agent_dir or _agent_dir())
    return not (agent_dir / 'state' / f'jobagent-{job.id}.json').exists()


def delete_job(session, job):
    session.query(WatchAlert).filter_by(job_id=job.id).delete()
    session.query(UserPreference).filter_by(job_id=job.id).update({'job_id': None})
    session.query(JobSnapshot).filter_by(job_id=job.id).delete()
    session.query(ScoreBreakdown).filter_by(job_id=job.id).delete()
    session.delete(job)


def runner_job_ids(data_dir=None):
    """Postings the application runner still references (queued, parked, dismissed)."""
    import json
    from ..config import get_settings
    path = Path(data_dir or get_settings().data_dir) / 'application-runner' / 'queue.json'
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return set()
    return {j.get('job_id') for key in ('jobs', 'dismissed_items') for j in data.get(key, [])} | set(data.get('skipped', []))


def prune_rejected(session, agent_dir=None):
    """Delete every stored posting that no track accepts and he has not acted on."""
    queued = runner_job_ids()
    removed = 0
    for job in session.query(Job).filter(Job.track_results.isnot(None)).all():
        if prunable(session, job, agent_dir, queued):
            delete_job(session, job)
            removed += 1
    session.commit()
    return removed


def _agent_dir():
    from jobagent.config import AGENT_DIR
    return AGENT_DIR
