"""Password hashing (scrypt), device tokens, and request authentication."""

from __future__ import annotations

import hashlib
import hmac
import secrets

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import DeviceToken, User, utcnow
from .errors import unauthorized

# scrypt parameters: N=2^14, r=8, p=1 (~16 MiB memory, tens of ms per hash).
SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 64

TOKEN_PREFIX = "ja_"


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    """Return (hash_hex, salt_hex)."""
    salt = salt if salt is not None else secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN
    )
    return digest.hex(), salt.hex()


def verify_password(password: str, hash_hex: str, salt_hex: str) -> bool:
    candidate, _ = hash_password(password, bytes.fromhex(salt_hex))
    return hmac.compare_digest(candidate, hash_hex)


# Used to keep login timing similar when the email is unknown.
_DUMMY_SALT = secrets.token_bytes(16)


def burn_password_check(password: str) -> None:
    hash_password(password, _DUMMY_SALT)


def new_device_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def extract_token(request: Request) -> str | None:
    """Accept `Authorization: Bearer <token>` (Claude Code's ANTHROPIC_AUTH_TOKEN) or `x-api-key`."""
    auth = request.headers.get("authorization", "")
    if auth[:7].lower() == "bearer ":
        token = auth[7:].strip()
        if token:
            return token
    key = request.headers.get("x-api-key", "").strip()
    return key or None


def authenticate(request: Request, db: Session) -> tuple[User, DeviceToken]:
    token = extract_token(request)
    if not token:
        raise unauthorized()
    row = db.scalar(
        select(DeviceToken).where(DeviceToken.token_hash == token_hash(token), DeviceToken.revoked.is_(False))
    )
    if row is None:
        raise unauthorized()
    user = db.get(User, row.user_id)
    if user is None:
        raise unauthorized()
    now = utcnow()
    # Avoid a write on every request: refresh last_used_at at most once a minute.
    if row.last_used_at is None or (now - row.last_used_at).total_seconds() > 60:
        row.last_used_at = now
        db.commit()
    return user, row
