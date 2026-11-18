import json

import httpx
import pytest

from app.db import Usage
from app.gateway import SSEUsageTracker

from .conftest import SERVER_KEY, set_plan

BETA = "claude-code-20250219,interleaved-thinking-2025-05-14,some-future-beta-2027-01-01"


def sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


SSE_EVENTS = [
    sse("message_start", {"type": "message_start", "message": {
        "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5", "content": [],
        "usage": {"input_tokens": 12, "output_tokens": 1, "cache_creation_input_tokens": 3,
                  "cache_read_input_tokens": 40}}}),
    sse("ping", {"type": "ping"}),
    sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    sse("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}),
    sse("content_block_stop", {"type": "content_block_stop", "index": 0}),
    sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 7}}),
    sse("message_stop", {"type": "message_stop"}),
]


def body(model="claude-sonnet-5-5", stream=False) -> dict:
    return {"model": model, "max_tokens": 64, "stream": stream,
            "system": [{"type": "text", "text": "You are Claude Code.", "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": "hi"}]}


def headers(token: str) -> dict:
    # What the Claude Code CLI sends with ANTHROPIC_AUTH_TOKEN set.
    return {"Authorization": f"Bearer {token}", "anthropic-version": "2023-06-01",
            "anthropic-beta": BETA, "content-type": "application/json"}


def usage_rows(app) -> list[Usage]:
    db = app.state.sessionmaker()
    rows = db.query(Usage).order_by(Usage.id).all()
    db.close()
    return rows


def test_hello_probe(client):
    r = client.head("/llm/api/hello")
    assert r.status_code == 200


def test_models_lists_allowlist(client, token):
    assert client.get("/llm/v1/models").status_code == 401
    r = client.get("/llm/v1/models", headers={"Authorization": f"Bearer {token}"})
    ids = [m["id"] for m in r.json()["data"]]
    assert ids == ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]


def test_non_streaming_forwarding(client, app, token, upstream):
    raw = json.dumps(body()).encode()
    upstream.handler = lambda req: httpx.Response(200, json={
        "id": "msg_1", "type": "message", "content": [], "usage": {
            "input_tokens": 10, "output_tokens": 5, "cache_creation_input_tokens": 2, "cache_read_input_tokens": 30}},
        headers={"retry-after": "3", "x-should-retry": "false", "request-id": "req_1",
                 "anthropic-ratelimit-unified-status": "allowed",
                 "anthropic-ratelimit-unified-reset": "1790000000", "x-internal": "secret"})
    r = client.post("/llm/v1/messages?beta=true", content=raw, headers=headers(token))
    assert r.status_code == 200 and r.json()["id"] == "msg_1"

    req = upstream.requests[0]
    assert str(req.url) == "https://api.anthropic.com/v1/messages"
    assert req.headers["x-api-key"] == SERVER_KEY
    assert "authorization" not in req.headers
    assert token not in json.dumps(dict(req.headers))
    assert req.headers["anthropic-version"] == "2023-06-01"
    assert req.headers["anthropic-beta"] == BETA
    assert req.content == raw  # body forwarded byte-for-byte, system array untouched

    assert r.headers["retry-after"] == "3"
    assert r.headers["x-should-retry"] == "false"
    assert r.headers["anthropic-ratelimit-unified-status"] == "allowed"
    assert r.headers["anthropic-ratelimit-unified-reset"] == "1790000000"
    assert "x-internal" not in r.headers

    [row] = usage_rows(app)
    assert (row.input_tokens, row.output_tokens, row.cache_creation_input_tokens, row.cache_read_input_tokens) == (10, 5, 2, 30)
    assert row.model == "claude-sonnet-5-5" and row.stream is False and row.status_code == 200


def test_x_api_key_auth_also_accepted(client, token, upstream):
    h = headers(token)
    del h["Authorization"]
    h["x-api-key"] = token
    r = client.post("/llm/v1/messages", json=body(), headers=h)
    assert r.status_code == 200
    assert upstream.requests[0].headers["x-api-key"] == SERVER_KEY


def test_streaming_relays_events_and_records_usage(client, app, token, upstream):
    async def gen():
        for event in SSE_EVENTS:
            yield event

    upstream.handler = lambda req: httpx.Response(
        200, headers={"content-type": "text/event-stream", "anthropic-ratelimit-unified-status": "allowed"},
        content=gen())
    with client.stream("POST", "/llm/v1/messages?beta=true", json=body(stream=True), headers=headers(token)) as r:
        assert r.status_code == 200
        assert r.headers["content-type"] == "text/event-stream"
        assert r.headers["anthropic-ratelimit-unified-status"] == "allowed"
        received = b"".join(r.iter_bytes())
    assert received == b"".join(SSE_EVENTS)  # every event incl. ping, through message_delta and message_stop
    assert b"event: ping" in received and received.endswith(sse("message_stop", {"type": "message_stop"}))

    req = upstream.requests[0]
    assert req.headers["x-api-key"] == SERVER_KEY and "authorization" not in req.headers
    [row] = usage_rows(app)
    assert row.stream is True
    assert (row.input_tokens, row.output_tokens, row.cache_creation_input_tokens, row.cache_read_input_tokens) == (12, 7, 3, 40)


def test_sse_tracker_handles_split_chunks():
    data = b"".join(SSE_EVENTS)
    t = SSEUsageTracker()
    for i in range(0, len(data), 7):
        t.feed(data[i:i + 7])
    t.finish()
    assert t.usage == {"input_tokens": 12, "output_tokens": 7, "cache_creation_input_tokens": 3, "cache_read_input_tokens": 40}


@pytest.mark.parametrize("stream", [False, True])
def test_upstream_400_forwarded_unmodified(client, app, token, upstream, stream):
    err = (b'{"type":"error","error":{"type":"invalid_request_error",'
           b'"message":"prompt is too long: 1050000 tokens > 1000000 maximum"}}')
    upstream.handler = lambda req: httpx.Response(400, content=err, headers={"content-type": "application/json",
                                                                             "request-id": "req_9"})
    r = client.post("/llm/v1/messages", json=body(stream=stream), headers=headers(token))
    assert r.status_code == 400
    assert r.content == err
    assert r.headers["request-id"] == "req_9"
    assert usage_rows(app)[0].status_code == 400


def test_upstream_429_headers_forwarded(client, token, upstream):
    upstream.handler = lambda req: httpx.Response(
        429, json={"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}},
        headers={"retry-after": "17", "x-should-retry": "true", "anthropic-ratelimit-unified-status": "rejected"})
    r = client.post("/llm/v1/messages", json=body(), headers=headers(token))
    assert r.status_code == 429
    assert r.headers["retry-after"] == "17" and r.headers["x-should-retry"] == "true"
    assert r.headers["anthropic-ratelimit-unified-status"] == "rejected"


def test_unknown_model_mapped_only_model_field(client, token, upstream, settings):
    raw = json.dumps(body(model="gpt-unknown"), indent=None).encode()
    client.post("/llm/v1/messages", content=raw, headers=headers(token))
    sent = json.loads(upstream.requests[0].content)
    original = json.loads(raw)
    assert sent["model"] == settings.default_model == "claude-opus-5-5"
    original.pop("model"), sent.pop("model")
    assert sent == original
    assert list(json.loads(upstream.requests[0].content).keys())[0] == "model"  # order preserved


def test_older_family_model_maps_to_current_family(client, token, upstream):
    client.post("/llm/v1/messages", json=body(model="claude-haiku-4-5-20251001"), headers=headers(token))
    assert json.loads(upstream.requests[0].content)["model"] == "claude-haiku-5-5"


def test_auth_required_and_user_token_never_used(client, upstream):
    r = client.post("/llm/v1/messages", json=body(), headers={"Authorization": "Bearer ja_fake"})
    assert r.status_code == 401
    assert r.json() == {"type": "error", "error": {"type": "authentication_error",
                                                   "message": r.json()["error"]["message"]}}
    assert upstream.requests == []


def test_trial_budget_then_402_then_subscription(client, app, token, upstream):
    # Trial budget is 100 tokens; each mocked call bills 15.
    for _ in range(7):
        assert client.post("/llm/v1/messages", json=body(), headers=headers(token)).status_code == 200
    r = client.post("/llm/v1/messages", json=body(), headers=headers(token))
    assert r.status_code == 402
    assert r.json()["type"] == "error" and r.json()["error"]["type"] == "billing_error"
    assert len(upstream.requests) == 7

    set_plan(app, "student@example.edu", "active")
    assert client.post("/llm/v1/messages", json=body(), headers=headers(token)).status_code == 200
    me = client.get("/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert me["usage"]["kind"] == "subscription" and me["usage"]["used_tokens"] == 120


def test_monthly_budget_enforced(client, app, token, upstream):
    set_plan(app, "student@example.edu", "active")
    upstream.handler = lambda req: httpx.Response(200, json={"id": "m", "usage": {"input_tokens": 600, "output_tokens": 500}})
    assert client.post("/llm/v1/messages", json=body(), headers=headers(token)).status_code == 200
    r = client.post("/llm/v1/messages", json=body(), headers=headers(token))
    assert r.status_code == 402 and "month" in r.json()["error"]["message"]


def test_canceled_subscription_without_trial_left_gets_402(client, app, token, upstream):
    set_plan(app, "student@example.edu", "active")
    upstream.handler = lambda req: httpx.Response(200, json={"id": "m", "usage": {"input_tokens": 200, "output_tokens": 0}})
    client.post("/llm/v1/messages", json=body(), headers=headers(token))
    set_plan(app, "student@example.edu", "canceled")
    assert client.post("/llm/v1/messages", json=body(), headers=headers(token)).status_code == 402


def test_rate_limit_429(client, app, token):
    app.state.rate_limiter.per_minute = 2
    assert client.post("/llm/v1/messages", json=body(), headers=headers(token)).status_code == 200
    assert client.post("/llm/v1/messages", json=body(), headers=headers(token)).status_code == 200
    r = client.post("/llm/v1/messages", json=body(), headers=headers(token))
    assert r.status_code == 429
    assert r.json()["error"]["type"] == "rate_limit_error"
    assert int(r.headers["retry-after"]) >= 1


def test_count_tokens_passthrough(client, app, token, upstream):
    upstream.handler = lambda req: httpx.Response(200, json={"input_tokens": 42})
    raw = json.dumps({"model": "claude-opus-5-5", "messages": [{"role": "user", "content": "hi"}]}).encode()
    r = client.post("/llm/v1/messages/count_tokens?beta=true", content=raw, headers=headers(token))
    assert r.json() == {"input_tokens": 42}
    req = upstream.requests[0]
    assert req.url.path == "/v1/messages/count_tokens" and req.content == raw
    assert req.headers["x-api-key"] == SERVER_KEY and req.headers["anthropic-beta"] == BETA
    assert usage_rows(app) == []


def test_invalid_json_body(client, token):
    r = client.post("/llm/v1/messages", content=b"{not json", headers=headers(token))
    assert r.status_code == 400 and r.json()["error"]["type"] == "invalid_request_error"
