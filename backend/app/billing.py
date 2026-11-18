"""Stripe subscription billing via plain HTTPS calls to the Stripe REST API (no SDK)."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import Settings
from .db import StripeEvent, User
from .deps import current_user, get_db, get_settings
from .errors import ApiError, bad_request

router = APIRouter(prefix="/billing")


# ---------------------------------------------------------------- Stripe API


async def stripe_post(request: Request, path: str, form: dict[str, str]) -> dict:
    settings: Settings = request.app.state.settings
    if not settings.stripe_secret_key:
        raise ApiError(503, "api_error", "Billing is not configured on this server.")
    client: httpx.AsyncClient = request.app.state.stripe_client
    try:
        resp = await client.post(
            f"{settings.stripe_api_base}{path}",
            data=form,
            auth=(settings.stripe_secret_key, ""),
        )
    except httpx.HTTPError as exc:
        raise ApiError(502, "api_error", f"Could not reach Stripe: {exc.__class__.__name__}")
    if resp.status_code >= 400:
        try:
            msg = resp.json().get("error", {}).get("message", "")
        except ValueError:
            msg = ""
        raise ApiError(502, "api_error", f"Stripe error ({resp.status_code}): {msg or 'request failed'}")
    return resp.json()


@router.post("/checkout")
async def checkout(request: Request, user: User = Depends(current_user), settings: Settings = Depends(get_settings)):
    if not settings.stripe_price_id:
        raise ApiError(503, "api_error", "Billing is not configured on this server.")
    form = {
        "mode": "subscription",
        "line_items[0][price]": settings.stripe_price_id,
        "line_items[0][quantity]": "1",
        "success_url": settings.checkout_success_url,
        "cancel_url": settings.checkout_cancel_url,
        "client_reference_id": str(user.id),
        "metadata[user_id]": str(user.id),
        "subscription_data[metadata][user_id]": str(user.id),
    }
    if user.stripe_customer_id:
        form["customer"] = user.stripe_customer_id
    else:
        form["customer_email"] = user.email
    session = await stripe_post(request, "/v1/checkout/sessions", form)
    return {"url": session.get("url"), "id": session.get("id")}


@router.post("/portal")
async def portal(request: Request, user: User = Depends(current_user), settings: Settings = Depends(get_settings)):
    if not user.stripe_customer_id:
        raise bad_request("No billing account yet. Start a subscription first.")
    session = await stripe_post(
        request,
        "/v1/billing_portal/sessions",
        {"customer": user.stripe_customer_id, "return_url": settings.portal_return_url},
    )
    return {"url": session.get("url")}


# ---------------------------------------------------------------- webhooks


class SignatureError(Exception):
    pass


def verify_stripe_signature(payload: bytes, header: str, secret: str, tolerance: int, now: float | None = None) -> None:
    """Stripe's documented scheme: header `t=<unix>,v1=<hex>[,v1=...]`; the signature is
    HMAC-SHA256(secret, f"{t}.{payload}") in hex. Rejects timestamps outside `tolerance` seconds."""
    if not secret:
        raise SignatureError("webhook secret not configured")
    timestamp = None
    signatures: list[str] = []
    for part in header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            timestamp = value
        elif key == "v1":
            signatures.append(value)
    if timestamp is None or not timestamp.isdigit() or not signatures:
        raise SignatureError("malformed Stripe-Signature header")
    expected = hmac.new(
        secret.encode("utf-8"), timestamp.encode("ascii") + b"." + payload, hashlib.sha256
    ).hexdigest()
    if not any(hmac.compare_digest(expected, s) for s in signatures):
        raise SignatureError("signature mismatch")
    now = time.time() if now is None else now
    if abs(now - int(timestamp)) > tolerance:
        raise SignatureError("timestamp outside tolerance")


def _ts(value) -> datetime | None:
    if not value:
        return None
    return datetime.fromtimestamp(int(value), UTC).replace(tzinfo=None)


def _find_user(db: Session, obj: dict, *, subscription_id: str | None = None) -> User | None:
    meta_uid = (obj.get("metadata") or {}).get("user_id") or obj.get("client_reference_id")
    if meta_uid and str(meta_uid).isdigit():
        user = db.get(User, int(meta_uid))
        if user:
            return user
    if subscription_id:
        user = db.scalar(select(User).where(User.stripe_subscription_id == subscription_id))
        if user:
            return user
    customer = obj.get("customer")
    if isinstance(customer, str) and customer:
        return db.scalar(select(User).where(User.stripe_customer_id == customer))
    return None


def _period_end(sub: dict) -> datetime | None:
    if sub.get("current_period_end"):
        return _ts(sub["current_period_end"])
    # Newer Stripe API versions report the period on each subscription item.
    items = (sub.get("items") or {}).get("data") or []
    ends = [i.get("current_period_end") for i in items if i.get("current_period_end")]
    return _ts(max(ends)) if ends else None


def apply_event(db: Session, event: dict) -> str:
    """Apply a verified event to the matching user. Returns a short outcome string."""
    etype = event.get("type", "")
    obj = (event.get("data") or {}).get("object") or {}
    created = int(event.get("created") or 0)

    if etype == "checkout.session.completed":
        user = _find_user(db, obj)
        if not user:
            return "user_not_found"
        if obj.get("customer"):
            user.stripe_customer_id = obj["customer"]
        if obj.get("subscription"):
            user.stripe_subscription_id = obj["subscription"]
        if created >= user.stripe_event_created and obj.get("payment_status", "paid") in ("paid", "no_payment_required"):
            user.plan_status = "active"
            user.stripe_event_created = created
        return "ok"

    if etype in ("customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.created"):
        user = _find_user(db, obj, subscription_id=obj.get("id"))
        if not user:
            return "user_not_found"
        if created < user.stripe_event_created:
            return "stale"
        if obj.get("customer"):
            user.stripe_customer_id = obj["customer"]
        user.stripe_subscription_id = obj.get("id") or user.stripe_subscription_id
        user.plan_status = "canceled" if etype.endswith("deleted") else (obj.get("status") or user.plan_status)
        user.current_period_end = _period_end(obj) or user.current_period_end
        user.stripe_event_created = created
        return "ok"

    if etype == "invoice.payment_failed":
        sub_id = obj.get("subscription")
        if not isinstance(sub_id, str):
            sub_id = ((obj.get("parent") or {}).get("subscription_details") or {}).get("subscription")
        user = _find_user(db, {"customer": obj.get("customer")}, subscription_id=sub_id)
        if not user:
            return "user_not_found"
        if created < user.stripe_event_created:
            return "stale"
        user.plan_status = "past_due"
        user.stripe_event_created = created
        return "ok"

    return "ignored"


@router.post("/webhook")
async def webhook(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    payload = await request.body()
    try:
        verify_stripe_signature(
            payload,
            request.headers.get("stripe-signature", ""),
            settings.stripe_webhook_secret,
            settings.stripe_webhook_tolerance_seconds,
        )
    except SignatureError as exc:
        raise bad_request(f"Invalid Stripe signature: {exc}")
    try:
        event = json.loads(payload)
    except ValueError:
        raise bad_request("Invalid JSON payload.")

    event_id = event.get("id")
    if event_id and db.get(StripeEvent, event_id) is not None:
        return {"received": True, "outcome": "duplicate"}
    outcome = apply_event(db, event)
    if event_id:
        db.add(StripeEvent(id=event_id, type=event.get("type", "")))
    try:
        db.commit()
    except IntegrityError:  # concurrent delivery of the same event
        db.rollback()
        return {"received": True, "outcome": "duplicate"}
    return {"received": True, "outcome": outcome}
