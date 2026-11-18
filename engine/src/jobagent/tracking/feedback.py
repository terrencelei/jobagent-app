"""Feedback and preference learning system."""

from datetime import datetime, timezone
import logging
from typing import Any, Dict, List, Optional
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db.models import Job, PreferenceType, UserPreference, utc_now

logger = logging.getLogger("jobagent.feedback")


class FeedbackManager:
    def __init__(self, session: Session):
        self.session = session

    def record_signal(
        self,
        job_id: int,
        pref_type: PreferenceType,
        notes: Optional[str] = None,
        weight: float = 1.0,
    ) -> UserPreference:
        job = self.session.query(Job).filter(Job.id == job_id).first()
        if not job:
            raise ValueError(f"Job {job_id} not found")

        pref = UserPreference(
            job_id=job.id,
            company=job.company_name,
            role_pattern=job.normalized_title,
            cluster_id=job.best_career_cluster,
            preference_type=pref_type,
            weight=weight,
            is_learned=True,
            notes=notes,
            created_at=utc_now(),
        )
        self.session.add(pref)
        self.session.commit()
        return pref

    def get_cluster_preference_modifiers(self) -> Dict[str, float]:
        """
        Calculate learned preference modifiers for career clusters.
        Caps modifier at max +/- 3.0 points so learned preference NEVER overpowers
        objective technical fit.
        """
        records = self.session.query(UserPreference).filter(UserPreference.is_learned.is_(True)).all()
        modifiers: Dict[str, float] = {}

        for rec in records:
            if not rec.cluster_id:
                continue
            curr = modifiers.get(rec.cluster_id, 0.0)
            if rec.preference_type in (PreferenceType.APPLY, PreferenceType.INTERVIEW, PreferenceType.OFFER):
                curr += 0.5 * rec.weight
            elif rec.preference_type in (PreferenceType.LIKE, PreferenceType.SAVE):
                curr += 0.25 * rec.weight
            elif rec.preference_type in (PreferenceType.DISLIKE, PreferenceType.IGNORE):
                curr -= 0.5 * rec.weight
            modifiers[rec.cluster_id] = curr

        # Cap modifier to [-3.0, +3.0]
        capped = {}
        for c, val in modifiers.items():
            capped[c] = max(-3.0, min(3.0, round(val, 2)))
        return capped
