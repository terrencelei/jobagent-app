"""Application tracking service for managing candidate application submissions and outcomes."""

from datetime import datetime, timezone
import logging
from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session

from ..db.models import Application, Job, JobStatus, utc_now
from ..db.repository import JobRepository
from ..processing.normalize import canonicalize_url
from .. import identity

logger = logging.getLogger("jobagent.applications")


class ApplicationTracker:
    def __init__(self, session: Session):
        self.session = session
        self.repo = JobRepository(session)

    def _resolve_job(self, identifier: str) -> Optional[Job]:
        if identifier.isdigit():
            return self.repo.get_job_by_id(int(identifier))
        # Otherwise treat as URL
        clean_url = canonicalize_url(identifier)
        return self.repo.get_job_by_canonical_url(clean_url)

    def mark_applied(
        self,
        identifier: str,
        resume_path: Optional[str] = None,
        resume_version: Optional[str] = None,
        notes: Optional[str] = None,
        confirmation_id: Optional[str] = None,
    ) -> Job:
        job = self._resolve_job(identifier)
        if not job:
            raise ValueError(f"Job not found for identifier: {identifier}")

        self.repo.record_application(
            job_id=job.id,
            status=JobStatus.APPLIED,
            resume_path=resume_path,
            resume_version=resume_version or identity.resume_filename(),
            notes=notes,
            confirmation_id=confirmation_id,
        )
        self.session.commit()
        logger.info(f"Marked Job #{job.id} ({job.title} at {job.company_name}) as APPLIED")
        return job

    def update_stage(
        self,
        identifier: str,
        stage: JobStatus,
        notes: Optional[str] = None,
    ) -> Job:
        job = self._resolve_job(identifier)
        if not job:
            raise ValueError(f"Job not found for identifier: {identifier}")

        job.status = stage
        app = self.session.query(Application).filter_by(job_id=job.id).first()
        if app:
            app.status = stage
            if notes:
                existing = app.notes or ""
                app.notes = f"{existing}\n[{stage.value} - {utc_now().strftime('%Y-%m-%d')}] {notes}".strip()

        self.session.commit()
        return job

    def list_applications(self) -> List[Dict[str, Any]]:
        apps = (
            self.session.query(Application)
            .join(Job, Application.job_id == Job.id)
            .order_by(Application.applied_date.desc())
            .all()
        )
        results = []
        for app in apps:
            results.append({
                "job_id": app.job_id,
                "company": app.job.company_name,
                "title": app.job.title,
                "status": app.status.value,
                "applied_date": app.applied_date.strftime("%Y-%m-%d %H:%M"),
                "resume_version": app.resume_version,
                "confirmation_id": app.confirmation_id,
                "notes": app.notes,
                "url": app.job.canonical_url,
            })
        return results
