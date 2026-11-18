"""Natural language conversational agent interface for JobAgent."""

import re
from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session

from ..db.models import Job, JobStatus, PreferenceType, UserPreference, utc_now
from ..db.repository import JobRepository
from ..processing.normalize import canonicalize_url
from .application_agent import ApplicationAgent


class JobAgentAssistant:
    def __init__(self, session: Session):
        self.session = session
        self.repo = JobRepository(session)
        self.app_agent = ApplicationAgent(session)

    def process_command(self, query: str) -> Dict[str, Any]:
        """
        Parse and execute a natural language request from the candidate.
        """
        q = query.strip()
        q_lower = q.lower()

        # 1. "I applied to <company> <role>" or "I already applied to <url>"
        url_match = re.search(r"https?://[^\s]+", q)
        if "applied" in q_lower:
            if url_match:
                target_url = canonicalize_url(url_match.group(0))
                job = self.repo.get_job_by_canonical_url(target_url)
                if job:
                    self.repo.record_application(job_id=job.id, status=JobStatus.APPLIED, notes="Recorded via natural language prompt")
                    return {
                        "action": "marked_applied",
                        "message": f"Successfully recorded application for Job #{job.id}: {job.title} at {job.company_name}.",
                        "job": {"id": job.id, "title": job.title, "company": job.company_name}
                    }
                else:
                    return {
                        "action": "job_not_found",
                        "message": f"Could not find an existing job record matching URL: {target_url}. You can add it using `jobagent search`.",
                    }

            # Search by company name in query
            for comp in {c.company_name.lower() for c in self.session.query(Job.company_name).distinct()}:
                if comp in q_lower:
                    jobs = (
                        self.session.query(Job)
                        .filter(Job.company_name.ilike(f"%{comp}%"))
                        .order_by(Job.priority_score.desc())
                        .all()
                    )
                    if jobs:
                        target_job = jobs[0]
                        self.repo.record_application(job_id=target_job.id, status=JobStatus.APPLIED, notes="Recorded via natural language prompt")
                        return {
                            "action": "marked_applied",
                            "message": f"Successfully marked your application to {target_job.title} at {target_job.company_name} (Job #{target_job.id}).",
                            "job": {"id": target_job.id, "title": target_job.title, "company": target_job.company_name}
                        }

        # 2. "What should I apply to tonight?" or "Show me my best new jobs"
        if any(term in q_lower for term in ["apply to tonight", "best new jobs", "top priority", "recommend", "best jobs"]):
            jobs = self.repo.list_jobs(
                statuses=[JobStatus.NEW, JobStatus.ACTIVE],
                min_priority=75.0,
                sort_by="priority",
                limit=5,
            )
            return {
                "action": "recommendations",
                "message": f"Found {len(jobs)} top priority opportunities recommended for immediate application:",
                "results": [
                    {
                        "id": j.id,
                        "title": j.title,
                        "company": j.company_name,
                        "priority": j.priority_score,
                        "relevance": j.relevance_score,
                        "urgency": j.urgency_score,
                        "career_cluster": j.best_career_cluster,
                        "eligibility": j.eligibility.value,
                        "application_url": j.application_url,
                    }
                    for j in jobs
                ]
            }

        # 3. "Find me product design positions"
        if "product design" in q_lower:
            jobs = self.repo.list_jobs(
                statuses=[JobStatus.NEW, JobStatus.ACTIVE],
                career_cluster="PRODUCT / MECHANICAL DESIGN",
                sort_by="priority",
                limit=5,
            )
            return {
                "action": "cluster_search",
                "cluster": "PRODUCT / MECHANICAL DESIGN",
                "message": f"Found {len(jobs)} product design positions:",
                "results": [
                    {"id": j.id, "title": j.title, "company": j.company_name, "priority": j.priority_score}
                    for j in jobs
                ]
            }

        # 4. "Show me everything above an 85"
        score_num_match = re.search(r"above (?:an? )?(\d+)", q_lower)
        if score_num_match:
            min_sc = float(score_num_match.group(1))
            jobs = self.repo.list_jobs(
                statuses=[JobStatus.NEW, JobStatus.ACTIVE],
                min_priority=min_sc,
                sort_by="priority",
                limit=10,
            )
            return {
                "action": "filter_score",
                "threshold": min_sc,
                "message": f"Found {len(jobs)} active opportunities with priority >= {min_sc}:",
                "results": [
                    {"id": j.id, "title": j.title, "company": j.company_name, "priority": j.priority_score}
                    for j in jobs
                ]
            }

        # 5. "I'm more interested in robotics now"
        if "robotics" in q_lower and any(t in q_lower for t in ["more interested", "prefer", "prioritize"]):
            pref = UserPreference(
                cluster_id="ROBOTICS / MECHATRONICS",
                preference_type=PreferenceType.LIKE,
                weight=2.0,
                is_learned=False,
                notes="Explicit user preference for Robotics / Mechatronics",
                created_at=utc_now(),
            )
            self.session.add(pref)
            self.session.commit()
            return {
                "action": "preference_updated",
                "message": "Recorded preference update: boosting relevance weight for ROBOTICS / MECHATRONICS roles.",
            }

        # 6. Fallback general search
        jobs = self.repo.list_jobs(
            statuses=[JobStatus.NEW, JobStatus.ACTIVE],
            search_query=q,
            limit=5,
        )
        return {
            "action": "text_search",
            "query": q,
            "count": len(jobs),
            "results": [
                {"id": j.id, "title": j.title, "company": j.company_name, "priority": j.priority_score}
                for j in jobs
            ]
        }
