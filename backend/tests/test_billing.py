import hashlib
import hmac
import json
import time
from urllib.parse import parse_qs

from app.db import User

from .conftest import WEBHOOK_SECRET


def sign(payload: bytes, secret: str = WEBHOOK_SECRET, ts: int | None = None) -> str:
    ts = int(time.time()) if ts is None else ts
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def post_event(client, event: dict, header: str | None = None):
    payload = json.dumps(event).encode()
    return client.post("/billing/webhook", content=payload,
                       headers={"Stripe-Signature": header or sign(payload), "Content-Type": "application/json"})


def user(app) -> User:
    db = app.state.sessionmaker()
    u = db.query(User).one()
    db.close()
    return u


def me(client, token):
    return client.get("/me", headers={"Authorization": f"Bearer {token}"}).json()


def test_checkout_creates_subscription_session(client, token, stripe):
    r = client.post("/billing/checkout", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == {"url": "https://checkout.stripe.com/c/pay/cs_test_1", "id": "cs_test_1"}
    req = stripe.requests[0]
    assert req.url.host == "api.stripe.com" and req.url.path == "/v1/checkout/sessions"
    assert req.headers["authorization"].startswith("Basic ")
    form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()}
    assert form["mode"] == "subscription"
    assert form["line_items[0][price]"] == "price_123"
    assert form["customer_email"] == "student@example.edu"
    assert form["client_reference_id"] == "1"


def test_checkout_requires_auth(client):
    assert client.post("/billing/checkout").status_code == 401


def test_portal_requires_customer_then_works(client, app, token, stripe):
    h = {"Authorization": f"Bearer {token}"}
    assert client.post("/billing/portal", headers=h).status_code == 400
    post_event(client, {"id": "evt_1", "type": "checkout.session.completed", "created": 100,
                        "data": {"object": {"client_reference_id": "1", "customer": "cus_1",
                                            "subscription": "sub_1", "payment_status": "paid"}}})
    r = client.post("/billing/portal", headers=h)
    assert r.status_code == 200 and r.json()["url"].startswith("https://billing.stripe.com/")
    assert parse_qs(stripe.requests[-1].content.decode())["customer"] == ["cus_1"]


def test_webhook_signature_valid_bad_stale(client):
    event = {"id": "evt_x", "type": "ping.unknown", "created": 1, "data": {"object": {}}}
    payload = json.dumps(event).encode()
    assert post_event(client, event).status_code == 200
    bad = client.post("/billing/webhook", content=payload,
                      headers={"Stripe-Signature": sign(payload, secret="whsec_wrong")})
    assert bad.status_code == 400 and "mismatch" in bad.json()["error"]["message"]
    stale = client.post("/billing/webhook", content=payload,
                        headers={"Stripe-Signature": sign(payload, ts=int(time.time()) - 3600)})
    assert stale.status_code == 400 and "tolerance" in stale.json()["error"]["message"]
    assert client.post("/billing/webhook", content=payload, headers={"Stripe-Signature": "garbage"}).status_code == 400
    # Tampered body with a signature for the original payload.
    tampered = client.post("/billing/webhook", content=payload + b" ", headers={"Stripe-Signature": sign(payload)})
    assert tampered.status_code == 400


def test_webhook_status_transitions(client, app, token):
    assert me(client, token)["usage"]["kind"] == "trial"

    post_event(client, {"id": "evt_1", "type": "checkout.session.completed", "created": 100,
                        "data": {"object": {"client_reference_id": "1", "customer": "cus_1",
                                            "subscription": "sub_1", "payment_status": "paid"}}})
    u = user(app)
    assert (u.plan_status, u.stripe_customer_id, u.stripe_subscription_id) == ("active", "cus_1", "sub_1")
    body = me(client, token)
    assert body["plan"]["subscribed"] is True and body["usage"]["kind"] == "subscription"
    assert body["usage"]["limit_tokens"] == 1000

    # Duplicate delivery is a no-op.
    r = post_event(client, {"id": "evt_1", "type": "checkout.session.completed", "created": 100,
                            "data": {"object": {"client_reference_id": "1"}}})
    assert r.json()["outcome"] == "duplicate"

    post_event(client, {"id": "evt_2", "type": "invoice.payment_failed", "created": 200,
                        "data": {"object": {"customer": "cus_1", "subscription": "sub_1"}}})
    assert user(app).plan_status == "past_due"
    assert me(client, token)["plan"]["subscribed"] is False

    post_event(client, {"id": "evt_3", "type": "customer.subscription.updated", "created": 300,
                        "data": {"object": {"id": "sub_1", "customer": "cus_1", "status": "active",
                                            "items": {"data": [{"current_period_end": 1893456000}]}}}})
    u = user(app)
    assert u.plan_status == "active" and u.current_period_end.year == 2030

    # An older event arriving late is ignored.
    r = post_event(client, {"id": "evt_old", "type": "customer.subscription.updated", "created": 250,
                            "data": {"object": {"id": "sub_1", "customer": "cus_1", "status": "past_due"}}})
    assert r.json()["outcome"] == "stale" and user(app).plan_status == "active"

    post_event(client, {"id": "evt_4", "type": "customer.subscription.deleted", "created": 400,
                        "data": {"object": {"id": "sub_1", "customer": "cus_1", "status": "canceled"}}})
    assert user(app).plan_status == "canceled"
    assert me(client, token)["usage"]["kind"] == "trial"
