"""Settings read from environment variables (see README.md and .env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_ALLOWED_MODELS = (
    "claude-fable-5-2",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
)


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else default


def _str(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def normalize_database_url(url: str) -> str:
    """Hosts such as Fly.io and Render hand out ``postgres://`` URLs; SQLAlchemy 2
    needs an explicit dialect, and we ship the psycopg 3 driver."""
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


@dataclass
class Settings:
    database_url: str = "sqlite:///./jobagent.db"

    # AI gateway
    anthropic_api_key: str = ""
    anthropic_upstream_url: str = "https://api.anthropic.com"
    allowed_models: tuple[str, ...] = DEFAULT_ALLOWED_MODELS
    default_model: str = "claude-opus-5-5"
    monthly_token_budget: int = 20_000_000
    trial_token_budget: int = 200_000
    rate_limit_per_minute: int = 60
    upstream_timeout_seconds: int = 600

    # Stripe
    stripe_secret_key: str = ""
    stripe_price_id: str = ""
    stripe_webhook_secret: str = ""
    stripe_webhook_tolerance_seconds: int = 300
    stripe_api_base: str = "https://api.stripe.com"
    checkout_success_url: str = "https://jobagent.app/billing/success"
    checkout_cancel_url: str = "https://jobagent.app/billing/cancel"
    portal_return_url: str = "https://jobagent.app/account"

    @classmethod
    def from_env(cls) -> "Settings":
        allowed = tuple(
            m.strip() for m in _str("ALLOWED_MODELS").split(",") if m.strip()
        ) or DEFAULT_ALLOWED_MODELS
        default_model = _str("DEFAULT_MODEL", "claude-opus-5-5")
        if default_model not in allowed:
            default_model = allowed[0]
        return cls(
            database_url=normalize_database_url(_str("DATABASE_URL", "sqlite:///./jobagent.db")),
            anthropic_api_key=_str("ANTHROPIC_API_KEY"),
            anthropic_upstream_url=_str("ANTHROPIC_UPSTREAM_URL", "https://api.anthropic.com").rstrip("/"),
            allowed_models=allowed,
            default_model=default_model,
            monthly_token_budget=_int("MONTHLY_TOKEN_BUDGET", 20_000_000),
            trial_token_budget=_int("TRIAL_TOKEN_BUDGET", 200_000),
            rate_limit_per_minute=_int("RATE_LIMIT_PER_MINUTE", 60),
            upstream_timeout_seconds=_int("UPSTREAM_TIMEOUT_SECONDS", 600),
            stripe_secret_key=_str("STRIPE_SECRET_KEY"),
            stripe_price_id=_str("STRIPE_PRICE_ID"),
            stripe_webhook_secret=_str("STRIPE_WEBHOOK_SECRET"),
            stripe_webhook_tolerance_seconds=_int("STRIPE_WEBHOOK_TOLERANCE_SECONDS", 300),
            checkout_success_url=_str("CHECKOUT_SUCCESS_URL", "https://jobagent.app/billing/success"),
            checkout_cancel_url=_str("CHECKOUT_CANCEL_URL", "https://jobagent.app/billing/cancel"),
            portal_return_url=_str("PORTAL_RETURN_URL", "https://jobagent.app/account"),
        )
