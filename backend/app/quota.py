"""Plan status, token budgets, and per-user rate limiting."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import Settings
from .db import Usage, User, utcnow

ACTIVE_STATUSES = {"active", "trialing"}

# Cache reads cost ~10% of normal input on the Anthropic API, so they count at 1/10.
CACHE_READ_WEIGHT_DIVISOR = 10


def is_subscribed(user: User) -> bool:
    return user.plan_status in ACTIVE_STATUSES


def month_bounds(now: datetime | None = None) -> tuple[datetime, datetime]:
    now = now or utcnow()
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start, end


def billable_tokens_expr():
    return (
        func.coalesce(func.sum(Usage.input_tokens), 0)
        + func.coalesce(func.sum(Usage.output_tokens), 0)
        + func.coalesce(func.sum(Usage.cache_creation_input_tokens), 0)
        + func.coalesce(func.sum(Usage.cache_read_input_tokens), 0) / CACHE_READ_WEIGHT_DIVISOR
    )


def billable(input_tokens: int, output_tokens: int, cache_creation: int, cache_read: int) -> int:
    return input_tokens + output_tokens + cache_creation + cache_read // CACHE_READ_WEIGHT_DIVISOR


@dataclass
class Allowance:
    plan: str  # "subscription" | "trial"
    period_start: datetime | None
    period_end: datetime | None
    used: int
    limit: int

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)


def allowance(db: Session, user: User, settings: Settings) -> Allowance:
    if is_subscribed(user):
        start, end = month_bounds()
        used = db.scalar(
            select(billable_tokens_expr()).where(Usage.user_id == user.id, Usage.created_at >= start)
        )
        return Allowance("subscription", start, end, int(used or 0), settings.monthly_token_budget)
    # Trial: a one-time allowance over the account's lifetime.
    used = db.scalar(select(billable_tokens_expr()).where(Usage.user_id == user.id))
    return Allowance("trial", None, None, int(used or 0), settings.trial_token_budget)


class RateLimiter:
    """Sliding-window limiter, in process memory. With several instances, each enforces its own window."""

    def __init__(self, per_minute: int, window_seconds: float = 60.0):
        self.per_minute = per_minute
        self.window = window_seconds
        self._hits: dict[int, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: int) -> int | None:
        """Record a hit; return None if allowed, else seconds until a slot frees up."""
        if self.per_minute <= 0:
            return None
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] >= self.window:
                hits.popleft()
            if len(hits) >= self.per_minute:
                return max(1, int(self.window - (now - hits[0])) + 1)
            hits.append(now)
            return None
