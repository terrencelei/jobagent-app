"""Database repository and session management for JobAgent."""

from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
import json
from typing import Any, Dict, Generator, List, Optional, Tuple
from sqlalchemy import create_engine, desc, func, or_, and_, select, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from ..config import CandidateProfileConfig, SearchConfig, get_settings, load_profile_config, load_search_config
from ..processing.us_locations import is_us_location
from ..processing.qualifications import EARLY_CAREER_PATTERN, SENIOR_PATTERN
from ..processing.normalize import normalize_title, compute_description_hash, canonicalize_url
from .models import (
    Base,
    Job,
    Company,
    Application,
    JobSnapshot,
    SearchRun,
    ScoreBreakdown,
    UserPreference,
    CandidateProfile,
    CandidateFact,
    JobStatus,
    FactProvenance,
    EligibilityStatus,
    PreferenceType,
    utc_now,
)

_ENGINE = None
_SESSION_FACTORY = None


def get_engine(db_url: Optional[str] = None):
    global _ENGINE
    if _ENGINE is None or db_url is not None:
        target_url = db_url or get_settings().db_url
        if target_url.startswith("sqlite"):
            connect_args = {"check_same_thread": False, "timeout": 30.0}
            engine = create_engine(target_url, connect_args=connect_args)

            @event.listens_for(engine, "connect")
            def set_sqlite_pragma(dbapi_connection, connection_record):
                cursor = dbapi_connection.cursor()
                cursor.execute("PRAGMA journal_mode=WAL")
                cursor.execute("PRAGMA busy_timeout=30000")
                cursor.execute("PRAGMA synchronous=NORMAL")
                cursor.close()

            _ENGINE = engine
        else:
            _ENGINE = create_engine(target_url)
    return _ENGINE


def get_session_factory(db_url: Optional[str] = None):
    global _SESSION_FACTORY
    if _SESSION_FACTORY is None or db_url is not None:
        engine = get_engine(db_url)
        _SESSION_FACTORY = sessionmaker(
            autocommit=False, autoflush=False, expire_on_commit=False, bind=engine
        )
    return _SESSION_FACTORY


@contextmanager
def get_db_session(db_url: Optional[str] = None) -> Generator[Session, None, None]:
    factory = get_session_factory(db_url)
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def init_db(db_url: Optional[str] = None, engine=None, session: Optional[Session] = None) -> None:
    """Initialize database tables and seed initial candidate profile, facts, and target companies."""
    target_engine = engine or get_engine(db_url)
    Base.metadata.create_all(bind=target_engine)
    # create_all does not migrate existing installations.
    columns = {column['name'] for column in inspect(target_engine).get_columns('jobs')}
    with target_engine.begin() as connection:
        for name, kind in [('role_type', 'VARCHAR(20)'), ('user_notes', 'TEXT'), ('fit_review', 'JSON'), ('user_fit_label', 'JSON'), ('track_results', 'JSON'), ('experience_required_years', 'FLOAT'), ('experience_preferred_years', 'FLOAT')]:
            if name not in columns:
                connection.execute(text(f'ALTER TABLE jobs ADD COLUMN {name} {kind}'))
        if 'interviewed' not in {column['name'] for column in inspect(target_engine).get_columns('applications')}:
            connection.execute(text('ALTER TABLE applications ADD COLUMN interviewed BOOLEAN NOT NULL DEFAULT 0'))

    def _seed(sess: Session):
        profile_config = load_profile_config()
        existing_profile = sess.query(CandidateProfile).first()
        if not existing_profile:
            cand = profile_config.candidate
            profile = CandidateProfile(
                full_name=cand.get("name") or "Candidate",
                email=cand.get("email", ""),
                phone=cand.get("phone", ""),
                profile_data=profile_config.model_dump(),
            )
            sess.add(profile)
            sess.flush()

            # Seed explicit facts
            facts = [
                ("EDUCATION", "institution", profile_config.education.institution, FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("EDUCATION", "graduation_date", profile_config.education.graduation_date, FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("EDUCATION", "expected_graduation", profile_config.education.expected_graduation, FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("EDUCATION", "gpa", profile_config.education.gpa, FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("EDUCATION", "degree", profile_config.education.degree, FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("EDUCATION", "majors", ", ".join([m.get("name", "") for m in profile_config.education.majors]), FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("WORK_AUTH", "citizenship", cand.get("citizenship") or "", FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("WORK_AUTH", "sponsorship_required", str(bool(cand.get("requires_sponsorship", False))).lower(), FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("AVAILABILITY", "target_start_date", cand.get("target_start_date") or profile_config.education.graduation_date, FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("AVAILABILITY", "target_season", cand.get("target_season") or "", FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("AVAILABILITY", "earliest_start_date", cand.get("earliest_start_date") or profile_config.education.graduation_date, FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("LOCATION", "home_location", cand.get("location") or "", FactProvenance.USER_PROVIDED, "profile.yaml", True),
                ("LOCATION", "relocation_allowed", str(bool(cand.get("relocation_allowed", True))).lower(), FactProvenance.USER_PROVIDED, "profile.yaml", True),
            ]

            # Skills facts
            for cat, skill_dict in [("PROGRAMMING", profile_config.skills.programming), ("ENGINEERING", profile_config.skills.engineering)]:
                for sk in skill_dict.get("explicit", []):
                    facts.append(("SKILL_EXPLICIT", f"{cat}:{sk}", sk, FactProvenance.USER_PROVIDED, "profile.yaml:explicit_skills", True))
                for sk in skill_dict.get("inferred", []):
                    facts.append(("SKILL_INFERRED", f"{cat}:{sk}", sk, FactProvenance.MODEL_INFERENCE, "profile.yaml:inferred_skills", True))

            for category, key, val, prov, ref, ver in facts:
                sess.add(CandidateFact(
                    category=category,
                    key=key,
                    value=val,
                    provenance=prov,
                    source_reference=ref,
                    verified=ver,
                ))

        # Seed companies from search.yaml
        search_config = load_search_config()
        for ats_group, company_list in search_config.target_companies.items():
            for comp in company_list:
                name = comp.get("name")
                if not name:
                    continue
                ats_type = comp.get("ats_type") or ats_group
                board_token = comp.get("board_token") or comp.get("company_slug")
                career_url = comp.get("career_url")
                slug = comp.get("company_slug") or comp.get("board_token") or name.lower().replace(" ", "-")

                existing_comp = sess.query(Company).filter_by(name=name).first()
                if not existing_comp:
                    sess.add(Company(
                        name=name,
                        slug=slug,
                        ats_type=ats_type,
                        board_token=board_token,
                        career_url=career_url,
                    ))
                    sess.flush()
                else:
                    existing_comp.ats_type = ats_type
                    existing_comp.board_token = board_token
                    existing_comp.career_url = career_url
                    existing_comp.slug = slug

        from ..discovery.source_catalog import seed_sources
        seed_sources(sess, search_config)

    if session:
        _seed(session)
    else:
        with get_db_session(db_url) as sess:
            _seed(sess)


class JobRepository:
    def __init__(self, session: Session):
        self.session = session

    def get_job_by_id(self, job_id: int) -> Optional[Job]:
        return self.session.query(Job).filter(Job.id == job_id).first()

    def get_job_by_canonical_url(self, url: str) -> Optional[Job]:
        url = canonicalize_url(url)
        aliases = {url, url.replace('://boards.greenhouse.io/', '://job-boards.greenhouse.io/'),
                   url.replace('://job-boards.greenhouse.io/', '://boards.greenhouse.io/')}
        return self.session.query(Job).filter(Job.canonical_url.in_(aliases)).first()

    def get_job_by_external_id(self, company_name: str, external_req_id: str) -> Optional[Job]:
        return (
            self.session.query(Job)
            .filter(Job.company_name == company_name, Job.external_req_id == external_req_id)
            .first()
        )

    def get_job_by_description_hash(self, company_name: str, desc_hash: str) -> Optional[Job]:
        return (
            self.session.query(Job)
            .filter(Job.company_name == company_name, Job.description_hash == desc_hash)
            .first()
        )

    def find_duplicate_candidate(
        self,
        canonical_url: str,
        company_name: str,
        external_req_id: Optional[str],
        description_hash: str,
    ) -> Optional[Job]:
        """Check known duplicate vectors: canonical URL, req ID, or exact description hash within company."""
        if canonical_url:
            job = self.get_job_by_canonical_url(canonical_url)
            if job:
                return job
        if external_req_id and company_name:
            job = self.get_job_by_external_id(company_name, external_req_id)
            if job:
                return job
        if description_hash and company_name:
            job = self.get_job_by_description_hash(company_name, description_hash)
            if job and not (external_req_id and job.external_req_id and str(external_req_id) != job.external_req_id):
                return job
        return None

    def upsert_job(self, job_data: Dict[str, Any]) -> Tuple[Job, bool, bool]:
        """
        Upsert a job record.
        Returns: (job, is_new, is_updated)
        CRITICAL: Never resurrect an APPLIED, INTERVIEW, OFFER, REJECTED, or WITHDRAWN job back to NEW/ACTIVE.
        """
        from ..processing.eligibility import EligibilityEngine
        job_data = dict(job_data)
        if not is_us_location(job_data.get("location")):
            raise ValueError("U.S.-only policy: a confirmed U.S. job location is required before storing a posting")
        title = job_data.get("title", "")
        job_data["role_type"] = EligibilityEngine.classify_role_type(title, job_data.get("description", ""), job_data.get("employment_type"))
        if "normalized_title" not in job_data or not job_data["normalized_title"]:
            job_data["normalized_title"] = normalize_title(title)
        if "description_hash" not in job_data or not job_data["description_hash"]:
            job_data["description_hash"] = compute_description_hash(job_data.get("description", ""))

        canonical_url = canonicalize_url(job_data.get("canonical_url", ""))
        job_data["canonical_url"] = canonical_url
        company_name = job_data.get("company_name", "")
        external_req_id = job_data.get("external_req_id")
        desc_hash = job_data.get("description_hash", "")

        existing = self.find_duplicate_candidate(canonical_url, company_name, external_req_id, desc_hash)
        now = utc_now()

        if existing is None:
            job = Job(**job_data)
            job.discovery_date = now
            job.last_seen = now
            self.session.add(job)
            self.session.flush()

            # Record snapshot
            snapshot = JobSnapshot(
                job_id=job.id,
                snapshot_date=now,
                status=job.status,
                description_hash=job.description_hash,
                raw_data=job.raw_source_data,
            )
            self.session.add(snapshot)
            return job, True, False

        # Existing job found
        is_updated = False
        existing.last_seen = now
        existing.failure_count = 0  # reset failures since it was seen

        # Check if description changed
        if desc_hash and existing.description_hash != desc_hash:
            existing.description = job_data.get("description", existing.description)
            existing.description_hash = desc_hash
            is_updated = True

        # Update metadata fields if provided
        for field in [
            "title", "normalized_title", "location", "normalized_location",
            "department", "employment_type", "seniority", "salary_raw",
            "salary_min", "salary_max", "requirements", "preferred_qualifications",
            "application_url", "stated_start_date", "graduation_requirements",
            "eligibility", "eligibility_reasons", "best_career_cluster",
            "cluster_scores", "relevance_score", "urgency_score", "priority_score",
            "early_career_boost", "role_type", "posting_date", "raw_source_data", "track_results",
            "experience_required_years", "experience_preferred_years"
        ]:
            if field in job_data and job_data[field] is not None:
                curr_val = getattr(existing, field)
                if curr_val != job_data[field]:
                    setattr(existing, field, job_data[field])
                    is_updated = True

        # Status transition rule:
        # If job was CLOSED but discovered again, reactivate it if not in application pipeline
        non_resurrectable_statuses = {
            JobStatus.APPLIED,
            JobStatus.INTERVIEW,
            JobStatus.OFFER,
            JobStatus.REJECTED,
            JobStatus.WITHDRAWN,
            JobStatus.SAVED,
            JobStatus.IGNORED,
            JobStatus.CLOSED,
        }
        if existing.status == JobStatus.CLOSED and existing.application is None:
            # Reopen to ACTIVE
            existing.status = JobStatus.ACTIVE
            is_updated = True
        elif existing.status not in non_resurrectable_statuses and existing.status != JobStatus.ACTIVE:
            # Active ongoing listing
            existing.status = JobStatus.ACTIVE

        # Record snapshot if updated, keeping only the newest few per job (services/maintenance.py)
        if is_updated:
            snapshot = JobSnapshot(
                job_id=existing.id,
                snapshot_date=now,
                status=existing.status,
                description_hash=existing.description_hash,
                raw_data=job_data.get("raw_source_data"),
            )
            self.session.add(snapshot)
            self.session.flush()
            from ..services.maintenance import prune_snapshots
            prune_snapshots(self.session, job_id=existing.id)

        return existing, False, is_updated

    @classmethod
    def get_new_grad_filter(cls):
        return and_(
            Job.title.regexp_match(EARLY_CAREER_PATTERN),
            ~Job.title.regexp_match(SENIOR_PATTERN),
        )

    def list_jobs(
        self,
        statuses: Optional[List[JobStatus]] = None,
        min_priority: Optional[float] = None,
        min_relevance: Optional[float] = None,
        career_cluster: Optional[str] = None,
        company_name: Optional[str] = None,
        new_grad_only: bool = False,
        only_new_today: bool = False,
        search_query: Optional[str] = None,
        eligibilities: Optional[List[str]] = None,
        role_types: Optional[List[str]] = None,
        sort_by: str = "priority",
        limit: int = 50,
        offset: int = 0,
    ) -> List[Job]:
        query = self.session.query(Job)
        # A queue is only useful if everything on it can actually be applied to, so callers
        # narrow by eligibility and by role type rather than filtering in the view.
        if eligibilities:
            query = query.filter(Job.eligibility.in_(eligibilities))
        if role_types:
            if "FULL_TIME" in role_types:
                query = query.filter(Job.role_type.in_(role_types))
            else:
                query = query.filter(Job.role_type.in_(role_types))

        if statuses:
            query = query.filter(Job.status.in_(statuses))
        else:
            # By default exclude CLOSED and IGNORED from discovery lists
            query = query.filter(Job.status.notin_([JobStatus.CLOSED, JobStatus.IGNORED]))

        if only_new_today:
            now = utc_now()
            cutoff = now - timedelta(hours=24)
            query = query.filter(
                or_(
                    Job.posting_date >= cutoff,
                    and_(Job.posting_date.is_(None), Job.discovery_date >= cutoff),
                ),
                func.coalesce(Job.posting_date, Job.discovery_date) <= now,
            )

        if min_priority is not None:
            query = query.filter(Job.priority_score >= min_priority)
        if min_relevance is not None:
            query = query.filter(Job.relevance_score >= min_relevance)
        if career_cluster:
            query = query.filter(Job.best_career_cluster == career_cluster)
        if company_name:
            query = query.filter(Job.company_name.ilike(f"%{company_name}%"))
        if new_grad_only:
            query = query.filter(self.get_new_grad_filter())
        if search_query:
            pattern = f"%{search_query}%"
            query = query.filter(
                or_(
                    Job.title.ilike(pattern),
                    Job.company_name.ilike(pattern),
                )
            )

        if sort_by == "priority":
            query = query.order_by(desc(Job.priority_score), desc(Job.posting_date))
        elif sort_by == "relevance":
            query = query.order_by(desc(Job.relevance_score), desc(Job.priority_score))
        elif sort_by == "urgency":
            query = query.order_by(desc(Job.urgency_score), desc(Job.priority_score))
        elif sort_by == "newest":
            query = query.order_by(
                desc(func.coalesce(Job.posting_date, Job.discovery_date)),
                desc(Job.priority_score),
            )
        else:
            query = query.order_by(desc(Job.priority_score))

        return query.offset(offset).limit(limit).all()

    def get_status_counts(self) -> Dict[str, int]:
        results = (
            self.session.query(Job.status, func.count(Job.id))
            .group_by(Job.status)
            .all()
        )
        counts = {status.value: 0 for status in JobStatus}
        for status, count in results:
            counts[status.value] = count
        return counts

    def record_application(
        self,
        job_id: int,
        status: JobStatus = JobStatus.APPLIED,
        resume_path: Optional[str] = None,
        resume_version: Optional[str] = None,
        cover_letter_path: Optional[str] = None,
        confirmation_id: Optional[str] = None,
        notes: Optional[str] = None,
        answers: Optional[Dict[str, Any]] = None,
        applied_date: Optional[datetime] = None,
    ) -> Application:
        job = self.get_job_by_id(job_id)
        if not job:
            raise ValueError(f"Job id {job_id} not found")

        now = utc_now()
        if applied_date is not None:
            applied_date = applied_date.replace(tzinfo=timezone.utc) if applied_date.tzinfo is None else applied_date.astimezone(timezone.utc)
            if applied_date > now + timedelta(seconds=5):
                raise ValueError('Submission date cannot be in the future')
        previous_status = job.status
        job.status = status
        if notes is not None:
            job.user_notes = notes

        app = self.session.query(Application).filter_by(job_id=job_id).first()
        if not app:
            app = Application(
                job_id=job_id,
                status=status,
                applied_date=applied_date or now,
                resume_path=resume_path,
                resume_version=resume_version or "Master_Resume_v1",
                cover_letter_path=cover_letter_path,
                confirmation_id=confirmation_id,
                notes=notes,
                answers=answers or {},
            )
            self.session.add(app)
        else:
            app.status = status
            if applied_date is not None:
                app.applied_date = applied_date
            if resume_path:
                app.resume_path = resume_path
            if resume_version:
                app.resume_version = resume_version
            if cover_letter_path:
                app.cover_letter_path = cover_letter_path
            if confirmation_id:
                app.confirmation_id = confirmation_id
            if notes:
                app.notes = notes
            if answers:
                app.answers = answers

        # Record preference signal for learning
        pref = UserPreference(
            job_id=job_id,
            company=job.company_name,
            role_pattern=job.normalized_title,
            cluster_id=job.best_career_cluster,
            preference_type=PreferenceType.APPLY if status == JobStatus.APPLIED else PreferenceType.SAVE,
            weight=1.5 if status == JobStatus.APPLIED else 1.0,
            is_learned=True,
            notes=f"User marked {status.value}",
        )
        if previous_status != status:
            self.session.add(pref)
        return app

    def set_job_status(self, job_id: int, status: JobStatus, notes: Optional[str] = None) -> Job:
        job = self.get_job_by_id(job_id)
        if not job:
            raise ValueError(f"Job id {job_id} not found")

        previous_status = job.status
        job.status = status
        if notes is not None:
            job.user_notes = notes
        app = self.session.query(Application).filter_by(job_id=job_id).first()
        if status in {JobStatus.APPLIED, JobStatus.INTERVIEW, JobStatus.OFFER, JobStatus.REJECTED, JobStatus.WITHDRAWN}:
            if app is None:
                app = Application(job_id=job_id, status=status, notes=notes)
                self.session.add(app)
            else:
                app.status = status
                if notes is not None:
                    app.notes = notes
        elif app is not None:
            # Keep status records in sync even when an operator explicitly restores a job.
            app.status = status
            if notes is not None:
                app.notes = notes

        pref_map = {
            JobStatus.SAVED: PreferenceType.SAVE,
            JobStatus.IGNORED: PreferenceType.IGNORE,
            JobStatus.INTERVIEW: PreferenceType.INTERVIEW,
            JobStatus.OFFER: PreferenceType.OFFER,
        }
        if status in pref_map and status != previous_status:
            pref = UserPreference(
                job_id=job_id,
                company=job.company_name,
                role_pattern=job.normalized_title,
                cluster_id=job.best_career_cluster,
                preference_type=pref_map[status],
                weight=1.0 if status != JobStatus.IGNORED else -1.0,
                is_learned=True,
                notes=notes,
            )
            self.session.add(pref)

        return job

    def record_search_run(
        self,
        sources_checked: int,
        jobs_scanned: int,
        new_jobs: int,
        updated_jobs: int,
        duplicates_merged: int,
        closed_jobs: int,
        errors_count: int,
        high_fit_new_jobs: int,
        new_grad_jobs: int,
        top_match_title: Optional[str] = None,
        top_match_company: Optional[str] = None,
        top_match_score: Optional[float] = None,
        error_log: Optional[List[Dict[str, Any]]] = None,
    ) -> SearchRun:
        run = SearchRun(
            completed_at=utc_now(),
            sources_checked=sources_checked,
            jobs_scanned=jobs_scanned,
            new_jobs=new_jobs,
            updated_jobs=updated_jobs,
            duplicates_merged=duplicates_merged,
            closed_jobs=closed_jobs,
            errors_count=errors_count,
            high_fit_new_jobs=high_fit_new_jobs,
            new_grad_jobs=new_grad_jobs,
            top_match_title=top_match_title,
            top_match_company=top_match_company,
            top_match_score=top_match_score,
            error_log=error_log or [],
        )
        self.session.add(run)
        return run

    def get_latest_search_run(self) -> Optional[SearchRun]:
        # Email-alert imports and single-posting checks record one-source runs; the dashboard's
        # coverage and partial-source report describe the latest real discovery scan.
        full = self.session.query(SearchRun).filter(SearchRun.sources_checked > 1).order_by(desc(SearchRun.id)).first()
        return full or self.session.query(SearchRun).order_by(desc(SearchRun.id)).first()

    def get_candidate_facts(self, category: Optional[str] = None) -> List[CandidateFact]:
        q = self.session.query(CandidateFact)
        if category:
            q = q.filter_by(category=category)
        return q.all()
