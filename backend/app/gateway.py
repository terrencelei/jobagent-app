"""Anthropic Messages API gateway for the Claude Code CLI and the Anthropic SDK.

Clients set ANTHROPIC_BASE_URL=<backend>/llm and ANTHROPIC_AUTH_TOKEN=<device token>.
Follows https://code.claude.com/docs/en/llm-gateway-protocol.md:
  * POST /llm/v1/messages (query string such as ?beta=true is ignored)
  * POST /llm/v1/messages/count_tokens (passthrough)
  * GET  /llm/v1/models (allowlisted models, for model discovery)
  * HEAD /llm/api/hello (startup probe)
The user's token is never forwarded; the server's ANTHROPIC_API_KEY goes upstream as x-api-key.
Request bodies are forwarded byte-for-byte unless the model id has to be rewritten, in which
case only the `model` field changes. Upstream error bodies are relayed unmodified.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .config import Settings
from .db import Usage, User
from .errors import ApiError, bad_request
from .quota import allowance
from .security import authenticate

log = logging.getLogger("jobagent.gateway")

router = APIRouter(prefix="/llm")

DEFAULT_ANTHROPIC_VERSION = "2023-06-01"
FAMILIES = ("fable", "mythos", "opus", "sonnet", "haiku")

# Request headers never sent upstream (credentials and hop-by-hop headers).
_DROP_REQUEST_HEADERS = {"authorization", "x-api-key", "cookie", "host", "content-length", "connection",
                         "accept-encoding", "transfer-encoding", "proxy-authorization"}
_FORWARD_RESPONSE_HEADERS = {"retry-after", "x-should-retry", "request-id"}


# ---------------------------------------------------------------- helpers


def map_model(requested: str, settings: Settings) -> str:
    """Allowlisted ids pass through; others map to the allowlisted model of the same family
    (e.g. an older haiku -> the current haiku), else to DEFAULT_MODEL."""
    if requested in settings.allowed_models:
        return requested
    lowered = (requested or "").lower()
    for family in FAMILIES:
        if family in lowered:
            for model in settings.allowed_models:
                if family in model:
                    return model
    return settings.default_model


def upstream_request_headers(request: Request, settings: Settings) -> dict[str, str]:
    headers: dict[str, str] = {}
    for name, value in request.headers.items():
        lname = name.lower()
        if lname in _DROP_REQUEST_HEADERS:
            continue
        # anthropic-version, anthropic-beta (verbatim, not allowlisted) and any other anthropic-* header.
        if lname.startswith("anthropic-") or lname in ("content-type", "user-agent") or lname.startswith("x-claude-code"):
            headers[lname] = value
    headers.setdefault("anthropic-version", DEFAULT_ANTHROPIC_VERSION)
    headers.setdefault("content-type", "application/json")
    headers["x-api-key"] = settings.anthropic_api_key
    # Ask for an uncompressed body so SSE can be relayed and parsed as it arrives.
    headers["accept-encoding"] = "identity"
    return headers


def downstream_headers(upstream: httpx.Response) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in upstream.headers.items():
        lname = name.lower()
        if lname in _FORWARD_RESPONSE_HEADERS or lname.startswith("anthropic-ratelimit-unified-"):
            out[lname] = value
    return out


def _parse_body(raw: bytes) -> dict:
    try:
        body = json.loads(raw)
    except ValueError:
        raise bad_request("Request body must be valid JSON.")
    if not isinstance(body, dict):
        raise bad_request("Request body must be a JSON object.")
    return body


def prepare_body(raw: bytes, settings: Settings) -> tuple[bytes, dict, str, str]:
    """Return (body_to_send, parsed, requested_model, model)."""
    body = _parse_body(raw)
    requested = body.get("model") if isinstance(body.get("model"), str) else ""
    model = map_model(requested, settings)
    if model != requested:
        body["model"] = model  # only the model field changes; dict order is preserved
        raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return raw, body, requested, model


def _usage_numbers(usage: dict | None) -> dict[str, int]:
    usage = usage or {}
    out = {}
    for key in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
        val = usage.get(key)
        if isinstance(val, int):
            out[key] = val
    return out


class SSEUsageTracker:
    """Incrementally parses relayed SSE bytes to collect usage from message_start/message_delta.
    It only observes the stream; the bytes are relayed untouched."""

    def __init__(self) -> None:
        self._buf = b""
        self.usage: dict[str, int] = {}

    def feed(self, chunk: bytes) -> None:
        self._buf += chunk.replace(b"\r\n", b"\n")
        while b"\n\n" in self._buf:
            block, self._buf = self._buf.split(b"\n\n", 1)
            self._handle(block)

    def finish(self) -> None:
        if self._buf.strip():
            self._handle(self._buf)
        self._buf = b""

    def _handle(self, block: bytes) -> None:
        data_lines = [line[5:].lstrip() for line in block.split(b"\n") if line.startswith(b"data:")]
        if not data_lines:
            return
        try:
            event = json.loads(b"\n".join(data_lines))
        except ValueError:
            return
        if not isinstance(event, dict):
            return
        etype = event.get("type")
        if etype == "message_start":
            self.usage.update(_usage_numbers((event.get("message") or {}).get("usage")))
        elif etype == "message_delta":
            # message_delta usage values are cumulative; take the latest.
            self.usage.update(_usage_numbers(event.get("usage")))


def record_usage(app_state, user_id: int, *, endpoint: str, requested: str, model: str, stream: bool,
                 status: int, usage: dict[str, int]) -> None:
    db: Session = app_state.sessionmaker()
    try:
        db.add(Usage(
            user_id=user_id, endpoint=endpoint, requested_model=requested[:128], model=model, stream=stream,
            status_code=status,
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cache_creation_input_tokens=usage.get("cache_creation_input_tokens", 0),
            cache_read_input_tokens=usage.get("cache_read_input_tokens", 0),
        ))
        db.commit()
    except Exception:  # never let accounting break a response
        log.exception("failed to record usage")
        db.rollback()
    finally:
        db.close()


def _authorize(request: Request, *, check_budget: bool) -> User:
    state = request.app.state
    settings: Settings = state.settings
    db: Session = state.sessionmaker()
    try:
        user, _ = authenticate(request, db)
        retry = state.rate_limiter.check(user.id)
        if retry is not None:
            raise ApiError(429, "rate_limit_error",
                           f"Too many requests. Limit is {settings.rate_limit_per_minute} per minute.",
                           {"retry-after": str(retry)})
        if check_budget:
            a = allowance(db, user, settings)
            if a.remaining <= 0:
                if a.plan == "trial":
                    msg = ("Your JobAgent free trial allowance is used up. "
                           "Subscribe in the JobAgent app to keep using AI features.")
                else:
                    msg = ("You have reached this month's JobAgent AI allowance. "
                           "It resets at the start of next month.")
                raise ApiError(402, "billing_error", msg)
        return user
    finally:
        db.close()


def _require_upstream_key(settings: Settings) -> None:
    if not settings.anthropic_api_key:
        raise ApiError(503, "api_error", "The AI gateway is not configured on this server.")


async def _send(request: Request, path: str, body: bytes, stream: bool) -> httpx.Response:
    settings: Settings = request.app.state.settings
    client: httpx.AsyncClient = request.app.state.upstream_client
    req = client.build_request(
        "POST", f"{settings.anthropic_upstream_url}{path}",
        content=body, headers=upstream_request_headers(request, settings),
    )
    try:
        return await client.send(req, stream=stream)
    except httpx.HTTPError as exc:
        raise ApiError(502, "api_error", f"Upstream AI service unreachable: {exc.__class__.__name__}",
                       {"x-should-retry": "true"})


# ---------------------------------------------------------------- routes


@router.api_route("/api/hello", methods=["HEAD", "GET"])
async def hello() -> Response:
    return Response(status_code=200)


@router.get("/v1/models")
async def models(request: Request):
    _authorize(request, check_budget=False)
    settings: Settings = request.app.state.settings
    data = [
        {"type": "model", "id": m, "display_name": m, "created_at": "2026-01-01T00:00:00Z"}
        for m in settings.allowed_models
    ]
    return {"data": data, "has_more": False,
            "first_id": data[0]["id"] if data else None, "last_id": data[-1]["id"] if data else None}


@router.post("/v1/messages/count_tokens")
async def count_tokens(request: Request):
    settings: Settings = request.app.state.settings
    _authorize(request, check_budget=False)
    _require_upstream_key(settings)
    body, _, _, _ = prepare_body(await request.body(), settings)
    upstream = await _send(request, "/v1/messages/count_tokens", body, stream=False)
    return Response(content=upstream.content, status_code=upstream.status_code,
                    media_type=upstream.headers.get("content-type", "application/json"),
                    headers=downstream_headers(upstream))


@router.post("/v1/messages")
async def messages(request: Request):
    state = request.app.state
    settings: Settings = state.settings
    user = _authorize(request, check_budget=True)
    _require_upstream_key(settings)
    body, parsed, requested, model = prepare_body(await request.body(), settings)
    is_stream = parsed.get("stream") is True

    upstream = await _send(request, "/v1/messages", body, stream=is_stream)

    if not is_stream or upstream.status_code != 200:
        # Non-streaming, or an error (errors are plain JSON even for stream requests):
        # relay status and body unmodified.
        content = upstream.content if not is_stream else await upstream.aread()
        if is_stream:
            await upstream.aclose()
        usage: dict[str, int] = {}
        if upstream.status_code == 200:
            try:
                usage = _usage_numbers(json.loads(content).get("usage"))
            except (ValueError, AttributeError):
                usage = {}
        record_usage(state, user.id, endpoint="messages", requested=requested, model=model,
                     stream=is_stream, status=upstream.status_code, usage=usage)
        return Response(content=content, status_code=upstream.status_code,
                        media_type=upstream.headers.get("content-type", "application/json"),
                        headers=downstream_headers(upstream))

    tracker = SSEUsageTracker()

    async def relay() -> AsyncIterator[bytes]:
        try:
            # Relay each chunk as soon as it arrives (no buffering); ping events pass through untouched.
            async for chunk in upstream.aiter_bytes():
                tracker.feed(chunk)
                yield chunk
            tracker.finish()
        finally:
            await upstream.aclose()
            record_usage(state, user.id, endpoint="messages", requested=requested, model=model,
                         stream=True, status=200, usage=tracker.usage)

    headers = downstream_headers(upstream)
    # Set content-type directly so it is exactly `text/event-stream` (no charset suffix).
    headers.update({"content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no"})
    return StreamingResponse(relay(), status_code=200, headers=headers)
