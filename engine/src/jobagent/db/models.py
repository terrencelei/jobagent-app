"""Database models for JobAgent using SQLAlchemy."""

from datetime import datetime, timezone
import enum
from typing import Any, Dict, List, Optional
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    JSON,
    Index,
    UniqueConstraint,
)
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class SourceRecord(Base):
    __tablename__ = "sources"
    id = Column(Integer, primary_key=True)
    key = Column(String(64), unique=True, nullable=False)
    company_name = Column(String(255), nullable=False, index=True)
    ats_type = Column(String(50), nullable=False)
    target = Column(JSON, nullable=False)
    enabled = Column(Boolean, default=True, nullable=False)
    health = Column(String(30), default="unchecked", nullable=False)
    checked_at = Column(DateTime)
    detail = Column(Text)
    jobs_found = Column(Integer, default=0)
    origin = Column(String(30), default="catalog")


class CompanyWatch(Base):
    __tablename__ = "company_watches"
    id = Column(Integer, primary_key=True)
    company_key = Column(String(255), unique=True, nullable=False)
    company_name = Column(String(255), nullable=False)
    enabled = Column(Boolean, default=False, nullable=False)
    minimum_fit = Column(Float, default=0, nullable=False)
    started_at = Column(DateTime)
    baseline_at = Column(DateTime)
    last_checked_at = Column(DateTime)
    last_error = Column(Text)


class WatchAlert(Base):
    __tablename__ = "watch_alerts"
    id = Column(Integer, primary_key=True)
    watch_id = Column(Integer, ForeignKey("company_watches.id"), nullable=False)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=False)
    status = Column(String(30), default="pending", nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    sent_at = Column(DateTime)
    error = Column(Text)
    __table_args__ = (UniqueConstraint("watch_id", "job_id"),)


class SourceTask(Base):
    __tablename__ = "source_tasks"
    id = Column(Integer, primary_key=True)
    kind = Column(String(30), nullable=False)
    payload = Column(JSON, nullable=False)
    status = Column(String(30), default="queued", nullable=False)
    result = Column(JSON)
    error = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    completed_at = Column(DateTime)


class JobStatus(str, enum.Enum):
    NEW = "NEW"
    ACTIVE = "ACTIVE"
    SAVED = "SAVED"
    APPLIED = "APPLIED"
    INTERVIEW = "INTERVIEW"
    OFFER = "OFFER"
    REJECTED = "REJECTED"
    WITHDRAWN = "WITHDRAWN"
    CLOSED = "CLOSED"
    IGNORED = "IGNORED"


class FactProvenance(str, enum.Enum):
    USER_PROVIDED = "USER_PROVIDED"
    SOURCE_FACT = "SOURCE_FACT"
    EXTRACTED_FACT = "EXTRACTED_FACT"
    MODEL_INFERENCE = "MODEL_INFERENCE"


class EligibilityStatus(str, enum.Enum):
    STRONG_MATCH = "STRONG_MATCH"
    ELIGIBLE = "ELIGIBLE"
    LIKELY_ELIGIBLE = "LIKELY_ELIGIBLE"
    UNCERTAIN = "UNCERTAIN"
    POSSIBLE_CONFLICT = "POSSIBLE_CONFLICT"
    LIKELY_INELIGIBLE = "LIKELY_INELIGIBLE"
    INELIGIBLE = "INELIGIBLE"


class PreferenceType(str, enum.Enum):
    LIKE = "LIKE"
    DISLIKE = "DISLIKE"
    SAVE = "SAVE"
    IGNORE = "IGNORE"
    APPLY = "APPLY"
    INTERVIEW = "INTERVIEW"
    OFFER = "OFFER"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Company(Base):
    __tablename__ = "companies"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False, unique=True, index=True)
    slug = Column(String(255), nullable=False, index=True)
    domain = Column(String(255), nullable=True)
    ats_type = Column(String(50), nullable=True)  # greenhouse, lever, ashby, workday, direct
    board_token = Column(String(255), nullable=True)
    career_url = Column(String(1024), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    jobs = relationship("Job", back_populates="company_rel", cascade="all, delete-orphan")


class Job(Base):
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    external_req_id = Column(String(255), nullable=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id"), nullable=True)
    company_name = Column(String(255), nullable=False, index=True)
    title = Column(String(512), nullable=False, index=True)
    normalized_title = Column(String(512), nullable=True, index=True)
    department = Column(String(255), nullable=True)
    location = Column(String(512), nullable=True)
    normalized_location = Column(String(512), nullable=True)
    employment_type = Column(String(100), nullable=True)  # Full-time, Intern, etc.
    seniority = Column(String(100), nullable=True)
    # FULL_TIME or INTERNSHIP. Internships are filtered out of the default queue rather
    # than discarded, so they stay viewable on their own tab.
    role_type = Column(String(20), nullable=True, index=True)
    user_notes = Column(Text, nullable=True)
    salary_raw = Column(String(255), nullable=True)
    salary_min = Column(Float, nullable=True)
    salary_max = Column(Float, nullable=True)
    description = Column(Text, nullable=False)
    description_hash = Column(String(64), nullable=True, index=True)
    requirements = Column(JSON, nullable=True)
    preferred_qualifications = Column(JSON, nullable=True)
    canonical_url = Column(String(2048), nullable=False, unique=True, index=True)
    application_url = Column(String(2048), nullable=False)
    source_ats = Column(String(50), nullable=False, index=True)
    raw_source_data = Column(JSON, nullable=True)
    status = Column(Enum(JobStatus), default=JobStatus.NEW, index=True, nullable=False)
    posting_date = Column(DateTime, nullable=True, index=True)
    discovery_date = Column(DateTime, default=utc_now, nullable=False, index=True)
    last_seen = Column(DateTime, default=utc_now, nullable=False)
    application_deadline = Column(DateTime, nullable=True)
    stated_start_date = Column(String(255), nullable=True)
    graduation_requirements = Column(String(512), nullable=True)

    # Computed fields
    eligibility = Column(Enum(EligibilityStatus), default=EligibilityStatus.UNCERTAIN, nullable=False, index=True)
    eligibility_reasons = Column(JSON, default=list)
    best_career_cluster = Column(String(100), nullable=True, index=True)
    cluster_scores = Column(JSON, default=dict)
    # The model's read of the whole posting (services/fit_review.py), for the description_hash it saw.
    fit_review = Column(JSON, nullable=True)
    # His own call on the posting ({fit, note, labeled_at}); it overrides the rules and the reviewer,
    # and the reviewer learns from it.
    user_fit_label = Column(JSON, nullable=True)
    # Every search track's verdict ({track: eligibility, reasons, scores, discipline, breakdown});
    # the columns above mirror the active track (processing/track_eval.py).
    track_results = Column(JSON, nullable=True)
    # Years of experience the posting requires / prefers (None: not stated).
    experience_required_years = Column(Float, nullable=True)
    experience_preferred_years = Column(Float, nullable=True)
    relevance_score = Column(Float, default=0.0, index=True)
    urgency_score = Column(Float, default=0.0, index=True)
    priority_score = Column(Float, default=0.0, index=True)
    early_career_boost = Column(Boolean, default=False)
    failure_count = Column(Integer, default=0)

    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # Relationships
    company_rel = relationship("Company", back_populates="jobs")
    application = relationship("Application", back_populates="job", uselist=False, cascade="all, delete-orphan")
    snapshots = relationship("JobSnapshot", back_populates="job", cascade="all, delete-orphan")
    score_breakdown = relationship("ScoreBreakdown", back_populates="job", uselist=False, cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_jobs_priority_status", "priority_score", "status"),
        Index("ix_jobs_company_title", "company_name", "normalized_title"),
    )


class JobSnapshot(Base):
    __tablename__ = "job_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=False, index=True)
    snapshot_date = Column(DateTime, default=utc_now, nullable=False)
    status = Column(Enum(JobStatus), nullable=False)
    description_hash = Column(String(64), nullable=False)
    raw_data = Column(JSON, nullable=True)

    job = relationship("Job", back_populates="snapshots")


class JobExclusion(Base):
    """A job the user should not be shown again.

    Dismissing a posting has to outlive the posting itself: the same req is rediscovered on
    the next scan, often at a new URL, so an exclusion matches on the canonical URL, on the
    company and title together, or on a title pattern for a whole category of work.
    """

    __tablename__ = "job_exclusions"

    id = Column(Integer, primary_key=True)
    # "url", "company_title" or "title_pattern".
    scope = Column(String(20), nullable=False, index=True)
    value = Column(Text, nullable=False)
    company_name = Column(String(255), nullable=True)
    reason = Column(Text, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)

    __table_args__ = (Index("ix_job_exclusions_scope_value", "scope", "value"),)


class Application(Base):
    __tablename__ = "applications"

    id = Column(Integer, primary_key=True, autoincrement=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=False, unique=True, index=True)
    status = Column(Enum(JobStatus), default=JobStatus.APPLIED, nullable=False)
    applied_date = Column(DateTime, default=utc_now, nullable=False)
    resume_path = Column(String(1024), nullable=True)
    resume_version = Column(String(100), nullable=True)
    cover_letter_path = Column(String(1024), nullable=True)
    confirmation_id = Column(String(255), nullable=True)
    notes = Column(Text, nullable=True)
    answers = Column(JSON, default=dict)
    # The employer interviewed him for this role. Kept apart from status, which only holds where it stands now:
    # a role he interviewed for and was then rejected from is REJECTED with interviewed set (2026-11-13).
    interviewed = Column(Boolean, default=False, nullable=False, server_default='0')
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    job = relationship("Job", back_populates="application")


class SearchRun(Base):
    __tablename__ = "search_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    started_at = Column(DateTime, default=utc_now, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    sources_checked = Column(Integer, default=0)
    jobs_scanned = Column(Integer, default=0)
    new_jobs = Column(Integer, default=0)
    updated_jobs = Column(Integer, default=0)
    duplicates_merged = Column(Integer, default=0)
    closed_jobs = Column(Integer, default=0)
    errors_count = Column(Integer, default=0)
    high_fit_new_jobs = Column(Integer, default=0)
    new_grad_jobs = Column(Integer, default=0)
    top_match_title = Column(String(512), nullable=True)
    top_match_company = Column(String(255), nullable=True)
    top_match_score = Column(Float, nullable=True)
    error_log = Column(JSON, default=list)
    summary_data = Column(JSON, default=dict)


class ScoreBreakdown(Base):
    __tablename__ = "score_breakdowns"

    id = Column(Integer, primary_key=True, autoincrement=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=False, unique=True, index=True)
    semantic_role_match = Column(Float, default=0.0)
    technical_skill_match = Column(Float, default=0.0)
    experience_match = Column(Float, default=0.0)
    industry_match = Column(Float, default=0.0)
    early_career_fit = Column(Float, default=0.0)
    role_preference = Column(Float, default=0.0)
    location_preference = Column(Float, default=0.0)
    company_preference = Column(Float, default=0.0)
    penalties = Column(Float, default=0.0)
    total_relevance = Column(Float, default=0.0)
    urgency = Column(Float, default=0.0)
    priority = Column(Float, default=0.0)

    matching_skills = Column(JSON, default=list)
    missing_skills = Column(JSON, default=list)
    matching_experience = Column(JSON, default=list)
    explanation = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)

    job = relationship("Job", back_populates="score_breakdown")


class UserPreference(Base):
    __tablename__ = "user_preferences"

    id = Column(Integer, primary_key=True, autoincrement=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True, index=True)
    company = Column(String(255), nullable=True)
    role_pattern = Column(String(255), nullable=True)
    cluster_id = Column(String(100), nullable=True)
    preference_type = Column(Enum(PreferenceType), nullable=False)
    weight = Column(Float, default=1.0)
    is_learned = Column(Boolean, default=False)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)


class CandidateProfile(Base):
    __tablename__ = "candidate_profiles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    full_name = Column(String(255), nullable=False)
    email = Column(String(255), nullable=False)
    phone = Column(String(50), nullable=True)
    profile_data = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)


class CandidateFact(Base):
    __tablename__ = "candidate_facts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    category = Column(String(100), nullable=False, index=True)
    key = Column(String(255), nullable=False, index=True)
    value = Column(Text, nullable=False)
    provenance = Column(Enum(FactProvenance), nullable=False, default=FactProvenance.USER_PROVIDED)
    source_reference = Column(String(512), nullable=False)
    verified = Column(Boolean, default=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        Index("ix_candidate_facts_cat_key", "category", "key"),
    )
