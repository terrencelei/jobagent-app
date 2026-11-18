"""Discovery service for finding new companies and validating public ATS boards."""

import logging
from typing import Any, Dict, List, Optional
import httpx
from sqlalchemy.orm import Session

from ..db.models import Company

logger = logging.getLogger("jobagent.company_discovery")


class CompanyDiscovery:
    def __init__(self, session: Session):
        self.session = session

    def register_company(
        self,
        name: str,
        ats_type: str,
        board_token: str,
        career_url: Optional[str] = None,
    ) -> Company:
        """Register or update a target employer board."""
        existing = self.session.query(Company).filter(Company.name.ilike(name)).first()
        if existing:
            existing.ats_type = ats_type
            existing.board_token = board_token
            if career_url:
                existing.career_url = career_url
            self.session.commit()
            return existing

        comp = Company(
            name=name,
            slug=board_token.lower(),
            ats_type=ats_type,
            board_token=board_token,
            career_url=career_url,
        )
        self.session.add(comp)
        self.session.commit()
        return comp

    def test_board_connectivity(self, ats_type: str, token: str) -> bool:
        """Verify if public ATS board endpoint is alive."""
        try:
            if ats_type == "greenhouse":
                url = f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs"
            elif ats_type == "lever":
                url = f"https://api.lever.co/v0/postings/{token}?mode=json"
            elif ats_type == "ashby":
                url = f"https://api.ashbyhq.com/posting-api/job-board/{token}"
            else:
                return True

            with httpx.Client(timeout=8.0) as client:
                resp = client.get(url)
                return resp.status_code == 200
        except Exception:
            return False
