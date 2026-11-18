from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import User
from app.main import create_app

SERVER_KEY = "sk-ant-server-test-key"
WEBHOOK_SECRET = "whsec_test_secret"


class Upstream:
    """Mock Anthropic API. Tests set `handler` to customize responses; requests are recorded."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.handler = None

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        await request.aread()
        self.requests.append(request)
        if self.handler:
            return self.handler(request)
        body = json.loads(request.content)
        return httpx.Response(200, json={
            "id": "msg_1", "type": "message", "role": "assistant", "model": body.get("model"),
            "content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 5,
                      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
        })


class Stripe:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        await request.aread()
        self.requests.append(request)
        if request.url.path == "/v1/checkout/sessions":
            return httpx.Response(200, json={"id": "cs_test_1", "url": "https://checkout.stripe.com/c/pay/cs_test_1"})
        if request.url.path == "/v1/billing_portal/sessions":
            return httpx.Response(200, json={"id": "bps_1", "url": "https://billing.stripe.com/p/session/bps_1"})
        return httpx.Response(404, json={"error": {"message": "not found"}})


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        anthropic_api_key=SERVER_KEY,
        anthropic_upstream_url="https://api.anthropic.com",
        monthly_token_budget=1000,
        trial_token_budget=100,
        rate_limit_per_minute=1000,
        stripe_secret_key="sk_test_123",
        stripe_price_id="price_123",
        stripe_webhook_secret=WEBHOOK_SECRET,
    )


@pytest.fixture
def upstream() -> Upstream:
    return Upstream()


@pytest.fixture
def stripe() -> Stripe:
    return Stripe()


@pytest.fixture
def app(settings, upstream, stripe):
    return create_app(settings, upstream_transport=httpx.MockTransport(upstream),
                      stripe_transport=httpx.MockTransport(stripe))


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


def signup(client, email="student@example.edu", password="correct horse"):
    r = client.post("/auth/signup", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()["token"]


@pytest.fixture
def token(client) -> str:
    return signup(client)


def set_plan(app, email: str, status: str) -> None:
    db = app.state.sessionmaker()
    user = db.query(User).filter_by(email=email).one()
    user.plan_status = status
    db.commit()
    db.close()
