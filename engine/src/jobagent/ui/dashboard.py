"""One set of queue definitions and payloads for API, counters and static export."""

from datetime import timedelta, timezone
from sqlalchemy import and_, exists, func, or_
from sqlalchemy.orm import aliased

from ..db.models import Application, EligibilityStatus, Job, JobStatus, utc_now
from ..processing.tracks import active_track, per_track
from ..db.repository import JobRepository
from ..processing.eligibility import clean_html_text

TAB_COUNTS = {
    "top_priority": "ACTIVE", "new_today": "NEW_TODAY", "new_grad": "NEW_GRAD",
    "high_match": "HIGH_MATCH", "urgent": "URGENT", "internships": "INTERNSHIPS",
    "needs_review": "NEEDS_REVIEW", "ineligible": "INELIGIBLE", "other_roles": "OTHER_ROLES",
    "saved": "SAVED", "applied": "APPLIED", "interview": "INTERVIEW", "offer": "OFFER",
    "rejected": "REJECTED", "withdrawn": "WITHDRAWN", "closed": "CLOSED", "ignored": "IGNORED",
}
APPLICABLE = ("STRONG_MATCH", "ELIGIBLE", "LIKELY_ELIGIBLE")


def tab_filters(now=None, in_flight=()):
    """Predicates per tab. `in_flight` lists job ids whose application is submitted but not yet recorded
    (awaiting the employer's receipt); Find roles leaves those out like the roles already applied to."""
    now = now or utc_now()
    opened = Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE])
    full_time = Job.role_type == "FULL_TIME"
    # A posting he applied to often has a second open listing (another source, another location) under the
    # same company and title; Find roles treats those as applied too (31 such rows on 2026-10-23).
    twin = aliased(Job)
    applied_twin = exists().where(and_(twin.id != Job.id, func.lower(twin.company_name) == func.lower(Job.company_name),
                                       twin.normalized_title == Job.normalized_title,
                                       twin.status.in_([JobStatus.APPLIED, JobStatus.INTERVIEW, JobStatus.OFFER])))
    applicable = and_(opened, full_time, Job.eligibility.in_(APPLICABLE), ~applied_twin,
                      *([Job.id.notin_(list(in_flight))] if in_flight else []))
    effective = func.coalesce(Job.posting_date, Job.discovery_date)
    filters = {
        "top_priority": applicable,
        "new_today": and_(applicable, effective >= now - timedelta(hours=24), effective <= now),
        "new_grad": and_(applicable, JobRepository.get_new_grad_filter()),
        "high_match": and_(applicable, Job.priority_score >= 85),
        "urgent": and_(applicable, Job.urgency_score >= 80),
        "internships": and_(opened, Job.role_type == "INTERNSHIP"),
        "other_roles": and_(opened, Job.role_type == "OTHER"),
        "needs_review": and_(opened, or_(Job.role_type.is_(None), and_(full_time, Job.eligibility.in_(["UNCERTAIN", "POSSIBLE_CONFLICT"])))),
        "ineligible": and_(opened, full_time, Job.eligibility.in_(["INELIGIBLE", "LIKELY_INELIGIBLE"])),
    }
    for tab in ("saved", "applied", "interview", "offer", "rejected", "withdrawn", "closed", "ignored"):
        filters[tab] = Job.status == JobStatus(tab.upper())
    return filters


def dashboard_counts(session, now=None, in_flight=()):
    counts = {TAB_COUNTS[tab]: session.query(Job).filter(predicate).count()
              for tab, predicate in tab_filters(now, in_flight).items()}
    counts["OPEN_TOTAL"] = session.query(Job).filter(Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE])).count()
    return counts


def source_counts(session, now=None):
    totals = dict(session.query(Job.source_ats, func.count(Job.id)).group_by(Job.source_ats).all())
    applicable = dict(session.query(Job.source_ats, func.count(Job.id)).filter(tab_filters(now)['top_priority']).group_by(Job.source_ats).all())
    return [{'source': source, 'stored': count, 'applicable': applicable.get(source, 0)}
            for source, count in sorted(totals.items())]


# The company selector limits which companies get new applications. Tabs that show his
# application history (an offer, an interview, a past submission) ignore it, so narrowing
# the apply list never hides an employer he already applied to.
HISTORY_TABS = frozenset({"applied", "interview", "offer", "rejected", "withdrawn", "closed", "ignored"})


SORTS = {'best': 'Best match first', 'fit': 'Highest fit', 'newest': 'Newest posting', 'salary': 'Highest pay', 'company': 'Company A to Z'}


def jobs_query(session, tab, cluster=None, query=None, now=None, applied_days=None, in_flight=(), companies=(), states=(), sort=None):
    filters = tab_filters(now, in_flight)
    if tab not in filters:
        raise ValueError("Unknown dashboard tab")
    result = session.query(Job).filter(filters[tab])
    if companies and tab not in HISTORY_TABS:
        result = result.filter(func.lower(Job.company_name).in_([name.casefold() for name in companies]))
    # Interview tracking must stay visible regardless of discovery discipline.
    if cluster and tab != 'interview':
        result = result.filter(Job.best_career_cluster == cluster)
    if query:
        # Escape before adding SQL wildcards. User searches are literal substrings.
        pattern = '%' + query.replace('/', '//').replace('%', '/%').replace('_', '/_') + '%'
        result = result.filter(or_(*(col.ilike(pattern, escape='/') for col in
                                    (Job.title, Job.company_name))))  # his rule 11-14: title and company only
    if states:
        # A posting's state is read from its free-text location (ui/locations.py), so match on the location strings
        # that read as one of the chosen states.
        from .locations import state_of
        wanted = {code.upper() for code in states}
        places = [place for (place,) in result.with_entities(Job.location).distinct() if state_of(place) in wanted]
        result = result.filter(Job.location.in_(places)) if places else result.filter(Job.id == -1)
    chosen = {'fit': (Job.relevance_score.desc(),), 'newest': (func.coalesce(Job.posting_date, Job.discovery_date).desc(),),
              'salary': (Job.salary_min.desc().nullslast(),), 'company': (func.lower(Job.company_name).asc(), Job.priority_score.desc())}.get(sort or '')
    if chosen:
        if tab == 'applied':
            result = result.outerjoin(Application, Application.job_id == Job.id)
            if applied_days:
                result = result.filter(Application.applied_date >= (now or utc_now()) - timedelta(days=applied_days))
        return result.order_by(*chosen, Job.priority_score.desc(), Job.id.desc())
    if tab == 'applied':
        # Submission time is independent of when a posting was discovered or ranked.
        # Legacy status-only records have no date; keep them after dated records.
        result = result.outerjoin(Application, Application.job_id == Job.id)
        if applied_days:
            # His Applied-page range (past day / week / 2 weeks / month); undated legacy records drop out.
            result = result.filter(Application.applied_date >= (now or utc_now()) - timedelta(days=applied_days))
        return result.order_by(Application.applied_date.desc().nullslast(), Job.id.desc())
    first = Job.urgency_score if tab == 'urgent' else func.coalesce(Job.posting_date, Job.discovery_date) if tab == 'new_today' else Job.priority_score
    return result.order_by(first.desc(), Job.priority_score.desc(), Job.id.desc())


def _iso(value):
    if value is None:
        return None
    return (value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value).isoformat()


def job_payload(job, now=None, detail=False):
    now = now or utc_now()
    effective = job.posting_date or job.discovery_date
    hours = None
    if effective:
        effective = effective.replace(tzinfo=timezone.utc) if effective.tzinfo is None else effective
        hours = (now - effective).total_seconds() / 3600
    result = {k: getattr(job, k) for k in (
        "id", "company_name", "title", "location", "department", "employment_type", "salary_raw",
        "source_ats", "canonical_url", "application_url", "priority_score", "relevance_score",
        "urgency_score", "best_career_cluster", "early_career_boost", "role_type",
        "experience_required_years", "experience_preferred_years")}
    result.update(status=job.status.value, eligibility=job.eligibility.value,
                  posting_date=_iso(job.posting_date), discovery_date=_iso(job.discovery_date),
                  applied_date=_iso(job.application.applied_date) if job.application else None,
                  resume_sent=(job.application.resume_version if job.application and (job.application.resume_path or str(job.application.resume_version or '').startswith(('Standing', 'Tailored'))) else None),
                  resume_file=bool(job.application and job.application.resume_path),
                  last_seen=_iso(job.last_seen), posting_age_hours=hours,
                  is_today=hours is not None and 0 <= hours <= 24,
                  posting_age="Date not specified" if hours is None else "Future-dated" if hours < 0 else f"{max(1, int(hours))}h ago" if hours < 24 else f"{int(hours/24)}d ago")
    if detail:
        track = active_track()
        reasons = job.eligibility_reasons or []
        if isinstance(reasons, str):
            reasons = [r.strip() for r in reasons.splitlines() if r.strip()]
        sb = job.score_breakdown
        result.update(description=clean_html_text(job.description), eligibility_reasons=reasons,
                      cluster_scores=job.cluster_scores or {}, notes=job.user_notes if job.user_notes is not None else job.application.notes if job.application else None,
                      breakdown={k: getattr(sb, k) for k in (
                          "semantic_role_match", "technical_skill_match", "experience_match", "industry_match",
                          "early_career_fit", "matching_skills", "missing_skills", "matching_experience", "explanation")} if sb else {},
                      fit_review=per_track(job.fit_review, track), user_fit_label=per_track(job.user_fit_label, track),
                      track=track)
    return result


RULE_FITS = {'STRONG_MATCH', 'ELIGIBLE', 'LIKELY_ELIGIBLE'}


def label_agreement(session, track=None):
    """How often the rules and the reviewer agree with the postings he has labelled, in one track."""
    track = track or active_track()
    rows = session.query(Job.track_results, Job.eligibility, Job.fit_review, Job.user_fit_label).filter(Job.user_fit_label.isnot(None)).all()
    labelled = []
    for results, shown, review, label in rows:
        label = per_track(label, track)
        if label and label.get('fit') is not None:
            verdict = ((results or {}).get(track) or {}).get('eligibility')
            labelled.append((EligibilityStatus(verdict) if verdict else shown, per_track(review, track) or {}, label))
    reviewed = [(r, l) for _, r, l in labelled if 'fit' in r]
    return {'labels': len(labelled),
            'rules_agree': sum((e.value in RULE_FITS) == l['fit'] for e, _, l in labelled),
            'reviewed': len(reviewed), 'reviewer_agree': sum(r['fit'] == l['fit'] for r, l in reviewed)}
