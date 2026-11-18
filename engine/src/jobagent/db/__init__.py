"""Database module for JobAgent."""

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
)
from .repository import JobRepository, get_db_session, init_db

__all__ = [
    "Base",
    "Job",
    "Company",
    "Application",
    "JobSnapshot",
    "SearchRun",
    "ScoreBreakdown",
    "UserPreference",
    "CandidateProfile",
    "CandidateFact",
    "JobStatus",
    "FactProvenance",
    "EligibilityStatus",
    "PreferenceType",
    "JobRepository",
    "get_db_session",
    "init_db",
]
