"""Signup, login (device tokens), logout, and /me."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import Settings
from .db import DeviceToken, User
from .deps import current_auth, get_db, get_settings
from .errors import ApiError, bad_request, unauthorized
from .quota import allowance, is_subscribed
from .security import burn_password_check, hash_password, new_device_token, token_hash, verify_password

router = APIRouter()

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD = 8


class Credentials(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=1024)
    device_name: str = Field(default="", max_length=120)


def _issue_token(db: Session, user: User, device_name: str) -> str:
    token = new_device_token()
    db.add(DeviceToken(user_id=user.id, token_hash=token_hash(token), device_name=device_name))
    db.commit()
    return token


@router.post("/auth/signup", status_code=201)
def signup(body: Credentials, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise bad_request("Enter a valid email address.")
    if len(body.password) < MIN_PASSWORD:
        raise bad_request(f"Password must be at least {MIN_PASSWORD} characters.")
    pw_hash, salt = hash_password(body.password)
    user = User(email=email, password_hash=pw_hash, password_salt=salt)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "invalid_request_error", "An account with this email already exists.")
    token = _issue_token(db, user, body.device_name)
    return {"token": token, "email": user.email}


@router.post("/auth/login")
def login(body: Credentials, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        burn_password_check(body.password)
        raise unauthorized("Incorrect email or password.")
    if not verify_password(body.password, user.password_hash, user.password_salt):
        raise unauthorized("Incorrect email or password.")
    return {"token": _issue_token(db, user, body.device_name), "email": user.email}


@router.post("/auth/logout")
def logout(auth=Depends(current_auth), db: Session = Depends(get_db)):
    _, device = auth
    row = db.get(DeviceToken, device.id)
    row.revoked = True
    db.commit()
    return {"ok": True}


@router.get("/me")
def me(auth=Depends(current_auth), db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, _ = auth
    a = allowance(db, user, settings)
    return {
        "email": user.email,
        "plan": {
            "status": user.plan_status,
            "subscribed": is_subscribed(user),
            "current_period_end": user.current_period_end.isoformat() + "Z" if user.current_period_end else None,
        },
        "usage": {
            "kind": a.plan,
            "period_start": a.period_start.isoformat() + "Z" if a.period_start else None,
            "period_end": a.period_end.isoformat() + "Z" if a.period_end else None,
            "used_tokens": a.used,
            "limit_tokens": a.limit,
            "remaining_tokens": a.remaining,
        },
    }
