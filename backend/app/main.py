"""FastAPI application factory. Run with: uvicorn app.main:app"""

from __future__ import annotations

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import accounts, billing, gateway
from .config import Settings
from .db import make_engine, make_sessionmaker
from .errors import ApiError, error_response
from .quota import RateLimiter

_STATUS_TYPES = {400: "invalid_request_error", 401: "authentication_error", 403: "permission_error",
                 404: "not_found_error", 405: "invalid_request_error", 413: "request_too_large",
                 429: "rate_limit_error"}


def create_app(
    settings: Settings | None = None,
    *,
    upstream_transport: httpx.AsyncBaseTransport | None = None,
    stripe_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    engine = make_engine(settings.database_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        timeout = httpx.Timeout(settings.upstream_timeout_seconds, connect=10.0)
        app.state.upstream_client = httpx.AsyncClient(transport=upstream_transport, timeout=timeout)
        app.state.stripe_client = httpx.AsyncClient(transport=stripe_transport, timeout=30.0)
        try:
            yield
        finally:
            await app.state.upstream_client.aclose()
            await app.state.stripe_client.aclose()
            engine.dispose()

    # No CORS middleware: the desktop app calls this from local processes, not from browsers.
    app = FastAPI(title="JobAgent backend", version="0.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.engine = engine
    app.state.sessionmaker = make_sessionmaker(engine)
    app.state.rate_limiter = RateLimiter(settings.rate_limit_per_minute)

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return error_response(exc.status, exc.type, exc.message, exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", []) if p != "body")
        return error_response(400, "invalid_request_error", f"{where}: {first.get('msg', 'invalid request')}".strip(": "))

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException):
        return error_response(exc.status_code, _STATUS_TYPES.get(exc.status_code, "api_error"), str(exc.detail))

    @app.get("/health")
    def health():
        return {"ok": True}

    app.include_router(accounts.router)
    app.include_router(billing.router)
    app.include_router(gateway.router)
    return app


_app: FastAPI | None = None


def __getattr__(name: str):
    """`uvicorn app.main:app` builds the app from the environment on first access, so importing
    this module (e.g. in tests) has no side effects such as creating the default database."""
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
