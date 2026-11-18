"""Cover-letter drafts for the dashboard from verified candidate facts.

Applications themselves are prepared and submitted by application-agent workers (services/application_runner.py);
the old MANUAL/REVIEW/AUTO package flow and resume-variant selection were removed on 2026-10-23 as unused."""

import logging
from typing import Dict

from sqlalchemy.orm import Session

from ..db.models import CandidateFact, Job
from ..db.repository import JobRepository

logger = logging.getLogger("jobagent.application_agent")


class ApplicationAgent:
    def __init__(self, session: Session):
        self.session = session
        self.repo = JobRepository(session)
        self.facts: Dict[str, str] = {}
        self._load_candidate_facts()

    def _load_candidate_facts(self) -> None:
        db_facts = self.session.query(CandidateFact).filter(CandidateFact.verified.is_(True)).all()
        for f in db_facts:
            self.facts[f"{f.category}:{f.key}"] = f.value
            self.facts[f.key] = f.value

    def generate_cover_letter(self, job: Job) -> str:
        """Draft a cover letter from the candidate's own profile (config/profile.yaml): education,
        then the experience or project whose signals best match the posting."""
        from ..config import load_profile_config
        from ..identity import grad_timing, school_short_name
        profile = load_profile_config()
        cand = profile.candidate if isinstance(profile.candidate, dict) else {}
        edu = profile.education
        timing = grad_timing(profile)
        company, title = job.company_name, job.title

        majors = [m.get("name", "") for m in edu.majors if m.get("name")]
        major_text = " and ".join(majors) if majors else "engineering"
        dual = "dual degrees" if len(majors) > 1 else "a degree"
        body_p1 = (
            f"Dear Hiring Team,\n\n"
            f"I am writing to express my strong interest in the {title} position at {company}. "
            f"As a student at {school_short_name(edu.institution)} completing {dual} in {major_text} "
            f"in {timing.grad_label}, I am excited about the opportunity to contribute to your team beginning {timing.avail_label}."
        )

        corpus = f"{title} {job.best_career_cluster or ''} {job.description or ''}".lower()
        blocks = [(exp.summary, sum(1 for sig in exp.signals if sig.lower() in corpus), f"{exp.title} at {exp.company}")
                  for exp in profile.experience if exp.summary]
        blocks += [(proj.summary, sum(1 for sig in proj.signals if sig.lower() in corpus), proj.name)
                   for proj in profile.projects if proj.summary]
        paragraphs = [body_p1]
        if blocks:
            # Highest signal overlap first; ties keep the profile's order (most recent first).
            summary, _, label = max(enumerate(blocks), key=lambda e: (e[1][1], -e[0]))[1]
            paragraphs.append(f"Most relevant to this role is my work as {label}: {summary.strip().rstrip('.')}.")

        contact = "\n".join(v for v in (cand.get("name") or "", cand.get("email") or "") if v)
        paragraphs.append(
            f"I would welcome the opportunity to discuss how my experience can support {company}'s objectives.\n\n"
            f"Sincerely,\n{contact}"
        )
        return "\n\n".join(paragraphs)
