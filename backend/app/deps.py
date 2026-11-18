"""Shared FastAPI dependencies."""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from .config import Settings
from .db import DeviceToken, User
from .security import authenticate


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Iterator[Session]:
    db = request.app.state.sessionmaker()
    try:
        yield db
    finally:
        db.close()


def current_auth(request: Request, db: Session = Depends(get_db)) -> tuple[User, DeviceToken]:
    return authenticate(request, db)


def current_user(auth: tuple[User, DeviceToken] = Depends(current_auth)) -> User:
    return auth[0]
