"""Urgency scoring and explanation engine."""

from datetime import datetime, timezone
import re
from typing import Any, Dict, List, Optional, Tuple

from ..config import RankingConfig, load_ranking_config


class UrgencyEngine:
    def __init__(self, ranking_config: Optional[RankingConfig] = None):
        self.config = ranking_config or load_ranking_config()

    def calculate_urgency(
        self,
        posting_date: Optional[datetime],
        discovery_date: Optional[datetime],
        description: str,
        application_deadline: Optional[datetime] = None,
    ) -> Tuple[float, str, str]:
        """
        Calculate urgency score (0-100), categorical level (HIGH, MEDIUM, LOW), and explanation.
        Never invent deadlines.
        """
        now = datetime.now(timezone.utc)
        effective_date = posting_date or discovery_date or now
        if effective_date.tzinfo is None:
            effective_date = effective_date.replace(tzinfo=timezone.utc)

        age_hours = (now - effective_date).total_seconds() / 3600.0

        score = 50.0
        level = "MEDIUM"
        explanation_parts = []

        # 1. Posting age heuristics
        if age_hours <= 24.0:
            score = 92.0
            level = "HIGH"
            explanation_parts.append(f"Posted {int(max(1, age_hours))} hours ago.")
        elif age_hours <= 72.0:
            score = 80.0
            level = "HIGH"
            explanation_parts.append(f"Posted {int(age_hours / 24.0)} days ago.")
        elif age_hours <= 168.0:  # 7 days
            score = 65.0
            level = "MEDIUM"
            explanation_parts.append(f"Posted {int(age_hours / 24.0)} days ago.")
        elif age_hours <= 720.0:  # 30 days
            score = 45.0
            level = "LOW"
            explanation_parts.append(f"Posted {int(age_hours / 24.0)} days ago.")
        else:
            score = 25.0
            level = "LOW"
            explanation_parts.append("Listing is over 30 days old.")

        # 2. Check for explicit deadline
        if application_deadline:
            if application_deadline.tzinfo is None:
                application_deadline = application_deadline.replace(tzinfo=timezone.utc)
            hours_to_deadline = (application_deadline - now).total_seconds() / 3600.0
            if hours_to_deadline > 0:
                days_left = hours_to_deadline / 24.0
                if days_left <= 3:
                    score = 98.0
                    level = "CRITICAL"
                    explanation_parts.append(f"Explicit deadline approaching in {int(days_left)} days.")
                elif days_left <= 7:
                    score = 85.0
                    level = "HIGH"
                    explanation_parts.append(f"Explicit deadline in {int(days_left)} days.")
                else:
                    explanation_parts.append(f"Explicit deadline: {application_deadline.strftime('%b %d, %Y')}.")

        # 3. Rolling recruiting note for early career
        desc_lower = description.lower()
        if any(term in desc_lower for term in ["rolling", "first come", "reviewed on a rolling basis", "apply early"]):
            score = min(100.0, score + 10.0)
            explanation_parts.append("Posting explicitly notes applications reviewed on a rolling basis.")
        elif not application_deadline and score >= 75.0:
            explanation_parts.append("No explicit deadline. Early-career engineering applications are typically reviewed on a rolling basis.")

        explanation = " ".join(explanation_parts)
        return (round(score, 1), level, explanation)
